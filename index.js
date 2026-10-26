/**
 * dsh-cortico-pet — the Host half.
 *
 * Cortico's desktop pet (`cortico-world-desktop-pet`, MIT, Pal-AI-Lab) is an Electron window driven
 * by a Cortico World. DeepSeek Harness is an Electron app *and* a web app, so this port can put the
 * pet in both places:
 *
 *   Cortico                                  here
 *   ──────────────────────────────────────── ─────────────────────────────────────────────
 *   transparent always-on-top Electron win.   `desktop/` — a real, transparent, click-through,
 *                                             always-on-top window over the whole desktop
 *                                             (`surface: desktop`), or a click-through iframe
 *                                             inside the Harness window (`surface: page`)
 *   World's own agent loop (src/world.ts)     the Harness event stream (`lib/brain.js`)
 *   `cortico-world-desktop-pet/src/server.ts` `lib/pet-server.js` (ws + http, loopback only)
 *
 * Both surfaces load the very same pet page from the pet server, so the page cannot tell them apart.
 * The page itself (`web/`) is vendored apart from three touches: the `<script>` in `pet.html` that
 * stands in for the Electron preload (`web/dsh-pet-host.js`), the wordmark and avatar the menu head
 * draws (`BRAND` in `pet-app.js`, from `web/brand/`), and the page title.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PetServer } from './lib/pet-server.js';
import { PetBrain } from './lib/brain.js';
import { PetPrefs, schemeOf } from './lib/prefs.js';
import { figureListing, scanPacks } from './lib/packs.js';
import { DesktopWindow } from './lib/desktop-window.js';
import { resolveElectron } from './lib/electron-runtime.js';
import { createSight } from './lib/sight.js';
export const name = 'cortico-pet';
export const inject = ['webServer'];

/** Where the overlay page asks this Host half for its origin. */
const ENTRY_PATH = '/dsh-cortico-pet/entry.json';
/**
 * Where the browser half *writes*. Same origin as the Harness page, so a settings panel that has
 * been open across a plugin reload keeps working: it never needs to know the pet server's port,
 * and there is no cross-origin preflight in the way.
 */
const PREF_WRITE_PATH = '/dsh-cortico-pet/api/prefs';
/** The same-origin read of the live state, for a panel that wants it without the pet server. */
const STATE_READ_PATH = '/dsh-cortico-pet/api/state';
/** The settings picker's list of live sessions (title, cwd, whether it is running). */
const SESSIONS_PATH = '/dsh-cortico-pet/api/sessions';
/** "Look at the desktop once" — the settings panel's button, and mine from a shell. */
const LOOK_PATH = '/dsh-cortico-pet/api/look';
/**
 * Re-imports `lib/sight.js` under a fresh URL and swaps the instance. Host modules are cached for the
 * life of the process, so without this every tweak to her eyesight would need a full DSH restart;
 * with it a `POST` here is enough. Loopback-only, like every route in this file.
 */
const RELOAD_PATH = '/dsh-cortico-pet/reload-sight';
/** A body this small is either a prefs patch or junk; nothing legitimate comes close. */
const MAX_BODY_BYTES = 64 * 1024;
/**
 * A *stable* port. `start()` walks upwards on a collision, so two Harness profiles can still coexist;
 * the point of the number is that a plugin reload lands on the same origin, which keeps an already
 * open pet page — and an already open settings page — talking to the right server.
 */
const PET_PORT = 39666;
/** Where she stands above the Harness window's bottom edge, under the composer. */
const FLOOR_PX = 92;
const PACKAGE = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));
/** The eyesight module's own URL, so the reload route can import it again under a fresh query. */
const SIGHT_URL = new URL('./lib/sight.js', import.meta.url);
const WEB_DIR = fileURLToPath(new URL('./web/', import.meta.url));

export function apply(ctx) {
  const prefs = new PetPrefs();
  const logFile = join(dirname(prefs.file), 'dsh-cortico-pet.log');
  /** Lifecycle notes always land in the log; the per-event dumps next to them are what `debugEvents` gates. */
  const log = (line) => {
    try {
      try { if (statSync(logFile).size > 512 * 1024) writeFileSync(logFile, '', 'utf8'); } catch { /* no log yet */ }
      appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch { /* a read-only home must not break the pet */ }
  };
  let promptSeq = 0;
  const { packs, problems } = scanPacks(WEB_DIR);

  const brain = new PetBrain({
    prefs,
    log,
    send: (order) => server.sendPet(order),
    prompt: async (text) => {
      const controller = ctx.get('sessionController');
      const sessionId = brain.activeRoot;
      if (!controller || typeof controller.prompt !== 'function') { log('prompt: no sessionController'); return false; }
      if (!sessionId) { log('prompt: no active session yet'); return false; }
      try {
        const value = await controller.prompt({
          requestId: `dsh-cortico-pet-${Date.now()}-${++promptSeq}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: safeTimeZone(),
        }, new AbortController().signal);
        return value?.accepted === true;
      } catch (err) {
        log(`prompt failed: ${err?.message ?? err}`);
        return false;
      }
    },
  });
  brain.setRegistry(ctx.get('agents'));
  brain.attach(ctx);

  /**
   * Where the next picture goes. A pinned id wins; then a pinned workspace, because a bridge's session
   * ids rotate while its cwd does not; then whichever session moved last.
   */
  async function resolveTargetSession() {
    const p = prefs.get();
    if (p.followSession) return p.followSession;
    if (p.followCwd) {
      try {
        const list = await ctx.get('sessionController')?.list?.({}, AbortSignal.timeout(4000));
        const needle = p.followCwd.toLowerCase();
        const match = (list?.items ?? [])
          .filter((item) => !item.origin)
          .find((item) => String(item.cwd ?? '').toLowerCase().includes(needle));
        if (match) return match.sessionId;
      } catch { /* fall through to whatever the brain is following */ }
    }
    return brain.activeRoot || null;
  }

  /**
   * Her eyesight: one screenshot of the desktop, on demand, only when `sight` is on. The picture goes
   * to the session she follows (pinned id → pinned workspace → the last one that moved) — see `sight.js`.
   */
  const sightOptions = {
    ctx,
    prefs,
    brain,
    log,
    targetSession: resolveTargetSession,
  };
  let sight = createSight(sightOptions);

  const server = new PetServer({
    version: PACKAGE.version,
    webDir: WEB_DIR,
    snapshot: () => snapshot(prefs, brain, surfaceState, sight),
    figures: () => figureListing(packs),
    packProblems: () => problems,
    prefs: () => prefs.get(),
    prefsFile: () => prefs.file,
    onPetConnect: (host, surface) => {
      log(`pet page connected (${host}/${surface})`);
      brain.send({ t: 'prefs', ...pagePrefs(prefs) });
      brain.greet();
    },
    onPetDisconnect: (surface) => log(`pet page gone (${surface})`),
    onPetMessage: (msg) => {
      // the menu's eye button: the click *is* the permission, `sight` only allows the button to exist
      if (msg?.t === 'look') { void sight.look('menu'); return; }
      void brain.onPetMessage(msg);
    },
    onLook: () => sight.look('settings'),
    onPrefs: (patch) => applyPrefs(patch),
    onSkin: (skin) => {
      if (skin && typeof skin === 'object') applyPrefs({ schemeName: skin.scheme, figure: skin.figure });
    },
  });

  /** Patches the record and tells the open page about the keys that changed. Returns those keys. */
  function applyPrefs(patch) {
    const changed = prefs.patch(patch);
    if (!changed.length) return [];
    log(`prefs: ${changed.join(', ')}`);
    const delta = pagePrefs(prefs);
    const out = {};
    for (const key of changed) if (key in delta) out[key] = delta[key];
    if (Object.keys(out).length) brain.send({ t: 'prefs', ...out });
    // where she lives is decided by this record, so the desktop window follows it live
    if (changed.includes('surface') || changed.includes('enabled') || changed.includes('electronPath')) syncSurface();
    return changed;
  }

  /**
   * The desktop window: a real transparent always-on-top window over the whole desktop. Started
   * when the record asks for it (`auto`/`desktop`/`both`) and stopped when it does not.
   */
  const surfaceState = { window: null, error: null, electron: null };

  async function syncSurface() {
    const p = prefs.get();
    const wantsDesktop = p.enabled && (p.surface === 'auto' || p.surface === 'desktop' || p.surface === 'both');
    if (!wantsDesktop) {
      surfaceState.window?.stop();
      surfaceState.window = null;
      surfaceState.error = null;
      return;
    }
    if (surfaceState.window?.running) return;
    let port = 0;
    try { port = await ready; } catch { return; }
    if (!port) return;
    const electron = await resolveElectron(p, log);
    surfaceState.electron = electron;
    if (electron.endsWith('.exe') === false) {
      surfaceState.error = electron; // a sentence explaining why there is no runtime
      log(`desktop window unavailable: ${electron}`);
      return;
    }
    const base = `http://127.0.0.1:${port}`;
    surfaceState.error = null;
    surfaceState.window = new DesktopWindow({
      electronPath: electron,
      base,
      settingsUrl: `${base}/settings`,
      log,
    });
    surfaceState.window.start();
  }

  const ready = server.start(PET_PORT)
    .then((port) => {
      log(`pet server on http://127.0.0.1:${port}${port === PET_PORT ? '' : ` (wanted ${PET_PORT})`}`);
      return port;
    })
    .catch((err) => { log(`pet server failed: ${err?.message ?? err}`); throw err; });

  // The overlay itself: injected into the index on every render. The index carries no CSP, so a
  // loopback script and a loopback frame are both allowed, and this path does not depend on the
  // client-plugin module loader at all.
  //
  // The injected boot code asks the Host half for its pet-server origin (same-origin route) instead
  // of baking a port in, so a restarted pet server needs no re-render, and a boot that races the
  // server's listen simply retries.
  ctx.effect(() => {
    if (typeof ctx.webServer?.tapIndex !== 'function') {
      log('webServer.tapIndex is missing: the overlay cannot be injected on this Harness build');
      return () => {};
    }
    return ctx.webServer.tapIndex((html) => {
      const boot = [
        '(function(){',
        'var tries=0;',
        'function go(){',
        '  fetch("/dsh-cortico-pet/entry.json",{cache:"no-store"}).then(function(r){return r.json()}).then(function(e){',
        '    if(!e||!e.ok||!e.base){throw new Error("pet server not up")}',
        `    window.__DSH_CORTICO_PET__={base:e.base,floor:${FLOOR_PX},prefs:e.prefs};`,
        '    var s=document.createElement("script");',
        '    s.src=e.base+"/web/dsh-overlay.js";',
        '    s.async=false;',
        '    document.head.appendChild(s);',
        '  }).catch(function(){ if(++tries<40) setTimeout(go,1500); });',
        '}',
        'if(document.body) go(); else document.addEventListener("DOMContentLoaded",go);',
        '})();',
      ].join('');
      const tag = `<script>${boot.replaceAll('<', '\\u003c')}</script>`;
      return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : `${html}${tag}`;
    });
  }, 'cortico-pet: overlay injection');

  ctx.effect(() => {
    if (!ctx.webServer) return () => {};
    return ctx.webServer.register({
      kind: 'exact',
      path: ENTRY_PATH,
      handler: async (req, res) => {
        let port = 0;
        try { port = await ready; } catch { port = 0; }
        const body = JSON.stringify({
          ok: port > 0,
          name: PACKAGE.name,
          version: PACKAGE.version,
          base: port > 0 ? `http://127.0.0.1:${port}` : null,
          pet: port > 0 ? `http://127.0.0.1:${port}/pet` : null,
          settings: port > 0 ? `http://127.0.0.1:${port}/settings` : null,
          prefs: prefs.get(),
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      },
    });
  }, 'cortico-pet: overlay entry');

  // The same-origin write path. A settings panel that has been open since before this plugin was
  // last reloaded still holds the *old* pet-server port, and every write it makes dies on a closed
  // port — a switch that never moves, with nothing to see. These two routes answer on the Harness
  // origin instead, so the panel only ever needs a relative URL.
  ctx.effect(() => {
    if (!ctx.webServer) return () => {};
    const json = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const offPrefs = ctx.webServer.register({
      kind: 'exact',
      path: PREF_WRITE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
        const patch = await readJsonBody(req);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return json(res, 400, { ok: false, error: '需要一个 JSON 对象' });
        }
        try {
          const changed = applyPrefs(patch);
          return json(res, 200, { ok: true, changed, prefs: prefs.get() });
        } catch (err) {
          log(`prefs route failed: ${err?.message ?? err}`);
          return json(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      },
    });
    const offState = ctx.webServer.register({
      kind: 'exact',
      path: STATE_READ_PATH,
      handler: (req, res) => json(res, 200, snapshot(prefs, brain, surfaceState, sight)),
    });
    // One look, for the settings panel and for a shell: the same path the pet's menu takes.
    const offLook = ctx.webServer.register({
      kind: 'exact',
      path: LOOK_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
        const result = await sight.look('route');
        return json(res, result.ok ? 200 : 409, result);
      },
    });
    // Swap in a freshly imported `lib/sight.js`, so tuning her eyesight does not cost a DSH restart.
    const offReload = ctx.webServer.register({
      kind: 'exact',
      path: RELOAD_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
        const rev = Date.now();
        try {
          const fresh = await import(`${SIGHT_URL.href}?rev=${rev}`);
          sight = fresh.createSight(sightOptions);
          log(`sight: reloaded lib/sight.js (rev ${rev})`);
          return json(res, 200, { ok: true, rev });
        } catch (err) {
          log(`sight: reload failed: ${err?.message ?? err}`);
          return json(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      },
    });
    // The picker's data: live sessions, newest first, with whatever title the session projects.
    const offSessions = ctx.webServer.register({
      kind: 'exact',
      path: SESSIONS_PATH,
      handler: async (req, res) => {
        try {
          const list = await ctx.get('sessionController')?.list?.({}, AbortSignal.timeout(5000));
          const items = (list?.items ?? [])
            .filter((item) => !item.origin)
            .map((item) => ({
              id: item.sessionId,
              title: titleOf(item),
              cwd: item.cwd ?? null,
              running: !!item.running,
              updatedAt: item.updatedAt ?? 0,
            }));
          const p = prefs.get();
          return json(res, 200, {
            ok: true,
            followSession: p.followSession,
            followCwd: p.followCwd,
            following: p.followSession || brain.activeRoot || null,
            items,
          });
        } catch (err) {
          return json(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      },
    });
    return () => { offPrefs(); offState(); offLook(); offReload(); offSessions(); };
  }, 'cortico-pet: same-origin prefs');

  /** One session's cwd from its persisted header: the workspace pin needs it at call time. */
  async function sessionCwd(sessionId) {
    try {
      const inspection = await ctx.get('sessionController')?.inspect?.(sessionId, AbortSignal.timeout(4000));
      return inspection?.meta?.cwd ?? null;
    } catch { return null; }
  }

  // Her eye, as a tool: once the settings allow it, the agent in the session she follows can ask for a
  // screenshot itself. The tool registry has no per-session scope here, so it is registered for every
  // session and refuses on its own — off unless `sight` is on, and only the pinned session otherwise.
  ctx.effect(() => {
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
      log('tools service is missing: the desktop-eye tool is not offered');
      return () => {};
    }
    return tools.register({
      name: 'pet_see_desktop',
      description: [
        '看一眼用户此刻的桌面：截一张全屏，图片直接放进这次工具结果里，可以当图像内容看。',
        '只在用户允许桌宠看屏幕时可用（设置 → 桌宠 → 让她看桌面）；被拒绝时说明用户没开，别反复调用。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: '为什么需要看这一次屏幕（一句话）' } },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { note: { type: 'string' }, attachment: { type: 'object' } },
          required: ['note'],
          additionalProperties: true,
        },
        render: (_args, value) => {
          const note = { type: 'text', text: String(value?.note ?? '看了一眼桌面。') };
          return value?.attachment ? [note, { type: 'image', attachment: value.attachment }] : [note];
        },
      },
      async execute(_args, exec) {
        const caller = exec?.agent?.id ? String(exec.agent.id) : null;
        const who = caller ? caller.slice(0, 8) : '?';
        const p = prefs.get();
        if (!p.sight) {
          log(`sight: tool refused (${who}): sight is off`);
          return { note: '拒绝：用户还没允许看桌面（设置 → 桌宠 → 让她看桌面）。先问用户要不要打开。' };
        }
        // The pet follows one session: a pinned id, or a pinned workspace (bridge ids rotate). A tool
        // call from anywhere else would be a session the user never pointed her at.
        if (p.followSession && caller) {
          const match = caller === p.followSession
            || caller.includes(p.followSession)
            || p.followSession.includes(caller);
          if (!match) {
            log(`sight: tool refused (${who}): pinned to ${p.followSession.slice(0, 8)}`);
            return { note: '拒绝：桌宠现在只跟着另一个会话，不在这个会话里截图。' };
          }
        } else if (p.followCwd && caller) {
          const cwd = await sessionCwd(caller);
          if (!cwd || !cwd.toLowerCase().includes(p.followCwd.toLowerCase())) {
            log(`sight: tool refused (${who}): cwd ${cwd ?? '?'} does not match "${p.followCwd}"`);
            return { note: `拒绝：桌宠现在只跟着「${p.followCwd}」那个工作区，不在这个会话里截图。` };
          }
        }
        try {
          const shot = await sight.shoot();
          brain.act('look');
          log(`sight: tool ${who} ${shot.tool} ${shot.bytes} bytes`);
          return { note: `桌面截图（${shot.tool}，${Math.round(shot.bytes / 1024)} KB）。`, attachment: shot.ref };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`sight: tool failed (${who}): ${message}`);
          return { note: `没截成：${message}` };
        }
      },
    });
  }, 'cortico-pet: desktop eye tool');

  // Diagnostics: what the Web boot graph says about this package's browser half. Handy when an
  // install looks idle — it answers whether the page is meant to load `client.js` at all.
  ctx.effect(() => {
    if (!ctx.webServer) return () => {};
    return ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-cortico-pet/graph.json',
      handler: (req, res) => {
        let graph = null;
        try { graph = ctx.get('clientModules')?.graph?.() ?? null; } catch (err) { graph = { error: String(err?.message ?? err) }; }
        const mine = JSON.stringify(graph ?? {}).includes(PACKAGE.name);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ package: PACKAGE.name, inGraph: mine, graph }, null, 2));
      },
    });
  }, 'cortico-pet: boot graph diagnostics');

  ctx.effect(() => () => {
    brain.clearIdle();
    surfaceState.window?.stop();
    surfaceState.window = null;
    void server.stop().catch(() => {});
  }, 'cortico-pet: pet server');

  // the desktop window comes up once the pet server is listening (or reports why it cannot)
  void ready.then(() => syncSurface()).catch((err) => log(`surface: ${err?.message ?? err}`));
}

/** Everything the page needs to start: `init` on connect, and the same body at `/api/state`. */
function snapshot(prefs, brain, surfaceState, sight) {
  const p = prefs.get();
  const windowRunning = !!surfaceState?.window?.running;
  return {
    startX: p.startX,
    ...pagePrefs(prefs),
    status: brain.status,
    /** Where she is meant to live, and what actually came up. */
    enabled: p.enabled,
    surface: p.surface,
    desktop: {
      running: windowRunning,
      pid: surfaceState?.window?.status?.().pid ?? null,
      error: surfaceState?.error ?? null,
      electron: surfaceState?.electron ?? null,
    },
    /** Her eyesight: whether she may look, and how the last look went. */
    sight: {
      allowed: p.sight,
      busy: !!sight?.state.busy,
      at: sight?.state.at ?? 0,
      text: sight?.state.text ?? '',
      error: sight?.state.error ?? null,
      model: sight?.state.model ?? null,
      bytes: sight?.state.bytes ?? 0,
      /** The session the last picture went to, when it went to one. */
      session: sight?.state.session ?? null,
      /** Where the next look would go: the pinned session, else whichever one moved last. */
      target: p.followSession || brain.activeRoot || null,
    },
    /** The in-page overlay steps aside when the desktop window is carrying the pet. */
    overlay: p.surface === 'page' || p.surface === 'both' || !windowRunning,
  };
}

/** The prefs block of the page's `init`/`prefs` orders (see `applyPrefs` in the vendored pet-app.js). */
function pagePrefs(prefs) {
  const p = prefs.get();
  return {
    skin: { figure: p.figure, scheme: schemeOf(p) },
    roam: p.roam,
    sound: p.sound,
    theme: p.theme,
    glow: p.glow,
    scale: p.scale,
    /** Draws the menu's eye button; the click itself is what actually asks for a look. */
    sight: !!p.sight,
    bubbleSize: 1,
    fontSize: 1,
    bubbleSpeed: 1,
    rememberPosition: true,
    user: '',
    mic: false,
    micDevice: '',
    voice: { enabled: false, ready: false, detail: null, hint: '', mode: 'hold' },
    doubleClickChat: true,
    statusBubble: p.statusBubble,
    saidBubbles: p.saidBubbles,
    lockFrameRate: false,
    frameRate: 60,
    hoverButtons: p.hoverButtons,
    bot: {
      name: '大肥鱼',
      // the page draws its own avatar (web/brand/dafayou.png); this port serves no /api/avatar
      avatar: null,
      // the menu head lends no run controls: this port has no bot process to pause or quit
      controls: true,
      buttons: { pause: false, settings: false, quit: false },
      quitLabel: '关闭',
      quitPrompt: '',
      paused: false,
    },
    language: p.language,
  };
}

function safeTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
}

/**
 * The human name of one session row. The GUI's titles are a projection, and projections are a bag of
 * JSON values keyed by whatever the owning plugin registered — so take the first string under a key
 * that says "title", and fall back to nothing rather than inventing one.
 */
function titleOf(summary) {
  const values = summary?.projections?.values;
  if (!values || typeof values !== 'object') return '';
  for (const [key, value] of Object.entries(values)) {
    if (/title/i.test(key) && typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Reads a small JSON request body. Resolves `null` for anything that is not one object — junk, an
 * oversized body, or a body that never finishes — so a route can answer 400 without throwing.
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    const fail = () => resolve(null);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); return fail(); }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    req.on('error', fail);
    req.on('aborted', fail);
  });
}
