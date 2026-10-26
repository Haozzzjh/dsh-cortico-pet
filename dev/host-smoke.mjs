/**
 * Loads the Host half against a stand-in Cordis context and checks that the entry route, the pet
 * page and the figure listing all come up. No Harness restart needed.
 *
 *   node dev/host-smoke.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// The Host half keeps its prefs next to the profile; a throwaway one keeps this test away from the
// real record (and from the running Harness).
process.env.DSH_PROFILE_DIR = mkdtempSync(join(tmpdir(), 'dsh-cortico-pet-smoke-'));
// `page` keeps this headless test from popping a real desktop window; `sight` so the eye tool runs
writeFileSync(join(process.env.DSH_PROFILE_DIR, 'dsh-cortico-pet.json'), JSON.stringify({ surface: 'page', sight: true }));
const { apply } = await import('../index.js');

const disposers = [];
const routes = new Map();
const taps = [];
const registeredTools = [];
let entryHandler = null;

/** Stand-in for the Host services the eye tool and the session picker touch. */
const services = {
  tools: {
    register: (definition) => {
      registeredTools.push(definition);
      return () => { registeredTools.splice(registeredTools.indexOf(definition), 1); };
    },
  },
  attachments: {
    saveImage: async (input) => ({
      attachmentId: 'smoke-image',
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1280,
      height: 720,
    }),
  },
  sessionController: {
    list: async () => ({
      items: [
        { sessionId: 'session-aaaaaaaa1111', cwd: 'D:\\work\\pet-plugin', running: true, updatedAt: Date.now(), projections: { values: { title: '桌宠插件' } } },
        { sessionId: 'session-bbbbbbbb2222', cwd: 'D:\\work\\chat-bridge\\agents', running: false, updatedAt: Date.now() - 60000, origin: 'subagent' },
      ],
    }),
  },
};

const ctx = {
  webServer: {
    register: (route) => {
      routes.set(`${route.kind}:${route.path}`, route);
      if (route.path === '/dsh-cortico-pet/entry.json') entryHandler = route.handler;
      return () => routes.delete(`${route.kind}:${route.path}`);
    },
    tapIndex: (transform) => { taps.push(transform); return () => taps.splice(taps.indexOf(transform), 1); },
  },
  get: (name) => services[name],
  on: () => () => {},
  effect: (callback) => {
    const dispose = callback();
    if (typeof dispose === 'function') disposers.push(dispose);
    return () => {};
  },
};

apply(ctx);
if (!entryHandler) { console.error('FAIL: the entry route was not registered'); process.exit(1); }

// wait for the pet server, through the route itself
const headers = {};
const res = {
  writeHead(status, head) { headers.status = status; this.headers = head; return this; },
  end(body) { this.body = body; done(this); },
};
let done;
const answered = new Promise((resolve) => { done = resolve; });
entryHandler({ url: '/dsh-cortico-pet/entry.json', headers: {} }, res);
const response = await answered;
const payload = JSON.parse(response.body ?? '{}');
console.log('entry:', { status: headers.status, ok: payload.ok, base: payload.base, pet: payload.pet });
if (!payload.ok || !payload.base) { console.error('FAIL: pet server did not start'); process.exit(1); }

const petPage = await fetch(`${payload.base}/pet`);
const html = await petPage.text();
console.log('GET /pet:', petPage.status, `${html.length} bytes`, html.includes('/web/dsh-pet-host.js') ? '(shim present)' : '(SHIM MISSING)');

const figures = await (await fetch(`${payload.base}/api/figures`)).json();
console.log('GET /api/figures:', figures.map((pack) => `${pack.id}[${pack.axes.length} axes, ${pack.vocab.length} words]`).join(' '));

const state = await (await fetch(`${payload.base}/api/state`)).json();
console.log('GET /api/state:', JSON.stringify({ skin: state.skin, scale: state.scale, roam: state.roam, theme: state.theme, status: state.status }));

const write = await fetch(`${payload.base}/api/prefs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:19387' },
  body: JSON.stringify({ schemeName: 'deepseek', outfit: 'cape', scale: 1.2 }),
});
console.log('POST /api/prefs (cross-origin, as the Harness page does):', write.status, await write.text());

const after = await (await fetch(`${payload.base}/api/state`)).json();
console.log('state after write:', JSON.stringify({ skin: after.skin, scale: after.scale }));

// the overlay injection: what the Harness index gets on every render
console.log('tapIndex transforms:', taps.length);
const rendered = taps.reduce((html, transform) => transform(html), '<!doctype html><html><body><div id="root"></div></body></html>');
const injected = rendered.match(/<script>[\s\S]*?<\/script>/g) ?? [];
console.log('injected scripts:', injected.length, `(${injected[0]?.length ?? 0} bytes of boot code)`);
const hasEntry = rendered.includes('/dsh-cortico-pet/entry.json');
const hasOverlay = rendered.includes('/web/dsh-overlay.js');
const keepsBody = rendered.includes('<div id="root"></div>') && rendered.trim().endsWith('</body></html>');
console.log('boot asks the entry route:', hasEntry, '· builds the overlay tag:', hasOverlay, '· leaves the page intact:', keepsBody);
const overlayAsset = await fetch(`${payload.base}/web/dsh-overlay.js`);
console.log('GET /web/dsh-overlay.js:', overlayAsset.status, `${(await overlayAsset.text()).length} bytes`);
const settingsPage = await fetch(`${payload.base}/settings`);
console.log('GET /settings:', settingsPage.status, `${(await settingsPage.text()).length} bytes`);

// The same-origin write route: what the Harness page's settings panel actually posts to. It has to
// answer on a body, apply the patch in-process, and answer 400 — not throw — on junk.
function hit(handler, { method = 'POST', body = '' } = {}) {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.headers = { 'content-type': 'application/json' };
    const res = {
      writeHead(status, head) { this.status = status; this.headers = head; return this; },
      end(text) { resolve({ status: this.status, body: text }); },
    };
    void handler(req, res);
  });
}

const writeRoute = routes.get('exact:/dsh-cortico-pet/api/prefs');
const stateRoute = routes.get('exact:/dsh-cortico-pet/api/state');
if (!writeRoute || !stateRoute) { console.error('FAIL: the same-origin routes were not registered'); process.exit(1); }

console.log('routes:', [...routes.keys()].join(' '));
const sameOrigin = await hit(writeRoute.handler, { body: JSON.stringify({ scale: 1.15, roam: 'free' }) });
const sameOriginBody = JSON.parse(sameOrigin.body ?? '{}');
console.log('POST /dsh-cortico-pet/api/prefs:', sameOrigin.status, JSON.stringify({ ok: sameOriginBody.ok, changed: sameOriginBody.changed, scale: sameOriginBody.prefs?.scale, roam: sameOriginBody.prefs?.roam }));
const junk = await hit(writeRoute.handler, { body: 'not json at all' });
console.log('POST junk body:', junk.status, junk.body);
const wrongMethod = await hit(writeRoute.handler, { method: 'GET' });
console.log('GET the write route:', wrongMethod.status, wrongMethod.body);
const liveState = await hit(stateRoute.handler, { method: 'GET' });
const liveStateBody = JSON.parse(liveState.body ?? '{}');
console.log('GET /dsh-cortico-pet/api/state:', liveState.status, JSON.stringify({ enabled: liveStateBody.enabled, surface: liveStateBody.surface, scale: liveStateBody.scale, desktop: liveStateBody.desktop?.running }));

// The dev-only reload hook: re-imports lib/sight.js under a fresh URL and swaps the instance.
const reloadRoute = routes.get('exact:/dsh-cortico-pet/reload-sight');
if (!reloadRoute) { console.error('FAIL: the sight reload route was not registered'); process.exit(1); }
const reloaded = await hit(reloadRoute.handler, { body: '' });
console.log('POST /dsh-cortico-pet/reload-sight:', reloaded.status, reloaded.body);

// The picker: subagent rows are dropped, titles come out of the projections bag.
const sessionsRoute = routes.get('exact:/dsh-cortico-pet/api/sessions');
if (!sessionsRoute) { console.error('FAIL: the sessions route was not registered'); process.exit(1); }
const sessions = await hit(sessionsRoute.handler, { method: 'GET' });
const sessionsBody = JSON.parse(sessions.body ?? '{}');
console.log('GET /dsh-cortico-pet/api/sessions:', sessions.status, JSON.stringify({
  items: (sessionsBody.items ?? []).map((item) => `${item.title || item.id.slice(0, 8)}${item.running ? '·运行中' : ''}`),
  followSession: sessionsBody.followSession,
}));

// The agent's own eye: a tool whose result carries the picture. Allowed here (sight: true).
const eye = registeredTools.find((tool) => tool.name === 'pet_see_desktop');
if (!eye) { console.error('FAIL: pet_see_desktop was not registered'); process.exit(1); }
const allowed = await eye.execute({ reason: 'smoke' }, { agent: { id: 'session-aaaaaaaa1111' } });
const blocks = eye.output.render({}, allowed);
console.log('pet_see_desktop (sight on):', blocks.map((block) => block.type).join('+'), '·', allowed.note);
if (!blocks.some((block) => block.type === 'image')) { console.error('FAIL: the tool result carried no image'); process.exit(1); }
// and the same tool once the switch is off again
await hit(writeRoute.handler, { body: JSON.stringify({ sight: false }) });
const refused = await eye.execute({}, { agent: { id: 'session-aaaaaaaa1111' } });
console.log('pet_see_desktop (sight off):', JSON.stringify(refused));
if (eye.output.render({}, refused).some((block) => block.type === 'image')) { console.error('FAIL: refused yet still handed over a picture'); process.exit(1); }

for (const dispose of disposers.reverse()) {
  try { await dispose(); } catch (err) { console.error('dispose error:', err.message); }
}
console.log('done');
