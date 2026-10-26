/**
 * Development harness for the pet page, with no Harness attached.
 *
 * Serves the vendored `web/` tree exactly as the plugin's Host half does, connects it to a
 * throwaway brain that says hello and then reports every message the page sends back. Used to
 * check the vendored front-end renders (and to take screenshots) without restarting DSH.
 *
 *   node dev/serve.mjs [--say "..."] [--scheme harness] [--outfit maid] [--port 0]
 */
import { PetPrefs, schemeOf } from '../lib/prefs.js';
import { figureListing, scanPacks } from '../lib/packs.js';
import { PetServer } from '../lib/pet-server.js';
import { fileURLToPath } from 'node:url';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const prefs = new PetPrefs();
const say = arg('say', null);
const { packs, problems } = scanPacks(WEB_DIR);
console.log(`packs: ${packs.map((pack) => `${pack.id}(${pack.manifest.vocab.length} words)`).join(', ')}`);
for (const problem of problems) console.log(`  pack problem: ${problem.dir}: ${problem.reason}`);

const status = { kind: 'work', text: '待机' };

function snapshot() {
  const p = prefs.get();
  return {
    startX: p.startX,
    skin: { figure: arg('figure', p.figure), scheme: schemeOf({ ...p, schemeName: arg('scheme', p.schemeName), outfit: arg('outfit', p.outfit) }) },
    roam: p.roam,
    sound: false,
    theme: p.theme,
    glow: p.glow,
    scale: Number(arg('scale', p.scale)),
    bubbleSize: 1,
    fontSize: 1,
    bubbleSpeed: 1,
    rememberPosition: false,
    user: '',
    mic: false,
    micDevice: '',
    voice: { enabled: false, ready: false, detail: null, hint: '', mode: 'hold' },
    doubleClickChat: true,
    statusBubble: true,
    saidBubbles: true,
    lockFrameRate: false,
    frameRate: 60,
    hoverButtons: ['chat', 'roam', 'sound'],
    bot: { name: '大肥鱼', avatar: null, controls: true, buttons: { pause: false, settings: false, quit: false }, quitLabel: '关闭', quitPrompt: '', paused: false },
    /** `--sight` puts the menu's eye button on, which the real Host half only does for `prefs.sight`. */
    sight: args.includes('--sight'),
    language: arg('language', p.language),
    status,
  };
}

const server = new PetServer({
  webDir: WEB_DIR,
  snapshot,
  figures: () => figureListing(packs),
  packProblems: () => problems,
  prefs: () => prefs.get(),
  prefsFile: () => prefs.file,
  onPetConnect: () => {
    console.log('[pet] page connected');
    setTimeout(() => {
      server.sendPet({ t: 'status', status: { kind: 'think', text: '在想…', detail: 'read' } });
      server.sendPet({ t: 'act', actions: ['nod'] });
    }, 700);
    setTimeout(() => {
      server.sendPet({ t: 'say', id: 'dev-1', beats: [{ text: say ?? '搬到 Harness 里来啦，你忙你的，我在这儿看着。' }] });
    }, 1800);
  },
  onPetDisconnect: () => console.log('[pet] page gone'),
  onPetMessage: (msg) => {
    if (msg.t === 'position' || msg.t === 'prefs') return;
    console.log('[pet →]', JSON.stringify(msg).slice(0, 240));
  },
  onPrefs: (patch) => console.log('[api/prefs]', JSON.stringify(patch)),
  onSkin: (skin) => console.log('[api/skin]', JSON.stringify(skin)),
});

const port = await server.start(Number(arg('port', 0)));
if (args.includes('--verbose')) {
  server.http?.prependListener('request', (req) => console.log('[http]', req.method, req.url));
}
// A stand-in for the Harness index: same injection the Host half performs, so the overlay can be
// exercised (and screenshotted) with no Harness attached. Load it over `localhost` while the pet
// base is `127.0.0.1` — a different origin, exactly like the real page and the pet server.
if (server.http) {
  const listeners = server.http.listeners('request');
  server.http.removeAllListeners('request');
  server.http.on('request', (req, res) => {
    if (req.url?.split('?')[0] === '/overlay-test') {
      const base = `http://127.0.0.1:${port}`;
      const boot = JSON.stringify({ base, floor: Number(arg('floor', 92)), prefs: { enabled: true, theme: 'light', language: 'zh' } });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>fake harness index</title></head>
<body style="margin:0;font:14px/1.5 system-ui;background:#f6f7f9;color:#333">
<div style="padding:24px">假页面：这一层是 Harness 的内容，桌宠应该浮在它上面，并且不挡点击。</div>
<script>window.__DSH_CORTICO_PET__=${boot};</script>
<script src="${base}/web/dsh-overlay.js" defer></script>
</body></html>`);
      return;
    }
    if (req.url?.split('?')[0] === '/probe') {
      // Same-origin inspector for the pet page: embed it, wait, then write what the page really
      // looks like into this document, so `--dump-dom` can show it without a debugger.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<style>body{margin:0;font:12px/1.4 ui-monospace,monospace}pre{white-space:pre-wrap;margin:0;padding:8px;background:#111;color:#0f0}
iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head>
<body><iframe id="f" src="/pet?menu=1"></iframe>
<pre id="out" style="position:fixed;left:0;bottom:0;z-index:9;width:100%;max-height:46vh;overflow:auto">waiting…</pre>
<script>
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(async () => {
    const lines = [];
    try {
      const f = document.getElementById('f');
      const w = f.contentWindow, d = f.contentDocument;
      const rect = (el) => (el ? [Math.round(el.getBoundingClientRect().x), Math.round(el.getBoundingClientRect().y), Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)].join(',') : 'none');
      lines.push('body.className = ' + JSON.stringify(d.body.className));
      lines.push('html[data-theme] = ' + JSON.stringify(d.documentElement.dataset.theme));
      lines.push('body background = ' + w.getComputedStyle(d.body).backgroundColor);
      lines.push('stage = ' + rect(d.querySelector('#stage')));
      lines.push('figure-layer children = ' + (d.querySelector('#figureLayer')?.children.length ?? 'n/a'));
      const clip = d.querySelector('.figure-clip');
      const frame = d.querySelector('.figure-frame');
      lines.push('figure-clip = ' + rect(clip) + '  style=' + (clip?.getAttribute('style') || ''));
      lines.push('figure-frame = ' + rect(frame) + '  style=' + (frame?.getAttribute('style') || ''));
      const inner = frame?.contentDocument;
      lines.push('frame doc = ' + (inner ? inner.documentElement.outerHTML.slice(0, 600) : 'no access'));
      const canvases = inner ? [...inner.querySelectorAll('canvas')] : [];
      lines.push('frame canvases = ' + canvases.map((c) => c.width + 'x' + c.height + ' css=' + rect(c)).join(' | '));
      lines.push('bubble hidden = ' + d.querySelector('#bubble')?.hidden + ' text=' + JSON.stringify((d.querySelector('#bubble')?.textContent || '').slice(0, 60)));
      lines.push('tools hidden = ' + d.querySelector('#tools')?.hidden);
      lines.push('webgl2 = ' + !!d.createElement('canvas').getContext('webgl2') + ' webgl = ' + !!d.createElement('canvas').getContext('webgl'));
      lines.push('ws readyState = ' + (w.__probeWs ?? 'n/a'));
      lines.push('document.title = ' + JSON.stringify(d.title));
      const head = d.querySelector('.m-head');
      lines.push('menu head = ' + rect(head) + ' hidden=' + d.querySelector('#menu')?.hidden);
      lines.push('menu name = ' + JSON.stringify(d.querySelector('.m-name')?.textContent ?? null));
      const avatar = d.querySelector('.m-avatar img');
      lines.push('menu avatar = ' + (avatar
        ? avatar.getAttribute('src') + ' natural=' + avatar.naturalWidth + 'x' + avatar.naturalHeight + ' css=' + rect(avatar)
        : 'none'));
    } catch (error) {
      lines.push('ERROR ' + error.message);
    }
    document.getElementById('out').textContent = lines.join('\\n');
  }, 12000);
</script></body></html>`);
      return;
    }
    for (const listener of listeners) listener.call(server.http, req, res);
  });
}
console.log(`serving http://127.0.0.1:${port}/pet`);
console.log(`overlay test page: http://localhost:${port}/overlay-test`);

const shutdown = async () => { await server.stop(); process.exit(0); };
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
