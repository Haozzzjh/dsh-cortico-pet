/**
 * The pet's local HTTP + WebSocket server — ported from Cortico's
 * `cortico-world-desktop-pet/src/server.ts` (MIT, Pal-AI-Lab), cut down to what an
 * in-browser overlay needs and kept byte-compatible with the pet page it serves.
 *
 * Differences from upstream:
 * - binds an ephemeral port (0) on 127.0.0.1, so several Harness profiles can each run a pet;
 * - adds loopback CORS to `/api/*`, because the overlaying page lives on the Harness origin, not
 *   on this server's origin, and has to read `/api/state` and POST `/api/prefs`;
 * - drops the pack importer, the OBS overlay feed, the dress page and the syllable speech API.
 *
 * `web/` is served at the same paths the upstream page asks for (`/web/…`, `/figure-frame`), so
 * the vendored front-end runs unmodified apart from the `petHost` shim in `pet.html`.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { acceptUpgrade } from './ws.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const PAGES = { '/pet': 'pet.html', '/settings': 'settings.html' };
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const PORT_ATTEMPTS = 10;
const PACK_CSP = "sandbox allow-scripts; default-src 'none'";

/**
 * The pages' own CSP: they may talk to this server only, and may be framed by any loopback page.
 *
 * `default-src 'self'` governs scripts too, so **no page here may carry an inline `<script>`** — it
 * would render and then silently never run (that is exactly how the settings page first shipped:
 * every control dead, no error anywhere). Scripts live in their own files under `web/`.
 */
const PAGE_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*",
].join('; ');

export class PetServer {
  constructor(opts) {
    this.opts = opts;
    this.http = null;
    /** Every connected pet page: the in-page overlay and the desktop window may both be up. */
    this.pets = new Map();
    this.boundPort = 0;
    this.connections = new Set();
  }

  get origin() {
    return this.boundPort ? `http://127.0.0.1:${this.boundPort}` : '';
  }

  get petConnected() {
    return this.pets.size > 0;
  }

  async start(port = 0) {
    let lastErr = null;
    for (let i = 0; i < PORT_ATTEMPTS; i++) {
      const server = createServer((req, res) => { void this.handle(req, res); });
      try {
        await new Promise((done, fail) => {
          server.once('error', fail);
          server.listen(port === 0 ? 0 : port + i, '127.0.0.1', () => { server.off('error', fail); done(); });
        });
      } catch (err) {
        lastErr = err;
        const code = err?.code;
        if (code === 'EADDRINUSE' || code === 'EACCES') continue;
        throw err;
      }
      this.http = server;
      const addr = server.address();
      this.boundPort = typeof addr === 'object' && addr ? addr.port : 0;
      server.on('connection', (socket) => {
        this.connections.add(socket);
        socket.on('close', () => this.connections.delete(socket));
      });
      server.on('upgrade', (req, socket, head) => {
        if (!this.allowed(req, true)) { socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n'); return; }
        let url;
        try { url = new URL(req.url ?? '/', this.origin); } catch { socket.destroy(); return; }
        if (url.pathname !== '/socket') { socket.destroy(); return; }
        const ws = acceptUpgrade(req, socket, head);
        if (ws) this.acceptSocket(ws, url);
      });
      return this.boundPort;
    }
    throw new Error(`dsh-cortico-pet: no free port (${lastErr?.message ?? 'unknown'})`);
  }

  async stop() {
    for (const ws of this.pets) { try { ws.close(1001, 'shutdown'); } catch { /* already gone */ } }
    this.pets.clear();
    const http = this.http;
    this.http = null;
    this.boundPort = 0;
    if (http) {
      for (const socket of this.connections) { try { socket.destroy(); } catch { /* already gone */ } }
      this.connections.clear();
      http.closeAllConnections?.();
      await new Promise((resolve) => http.close(() => resolve()));
    }
  }

  /** Sends an order to every connected pet page; false when none is connected. */
  sendPet(msg) {
    if (!this.pets.size) return false;
    const text = JSON.stringify(msg);
    let sent = false;
    for (const ws of this.pets.keys()) {
      if (ws.open !== true) continue;
      try { ws.send(text); sent = true; } catch { /* one dead page must not stop the rest */ }
    }
    return sent;
  }

  acceptSocket(ws, url) {
    const params = url.searchParams;
    if (params.get('role') !== 'pet') { ws.close(4003, 'role'); return; }
    const host = params.get('host') === 'window' ? 'window' : 'tab';
    const surface = params.get('surface') === 'desktop' ? 'desktop' : 'page';
    ws.send(JSON.stringify({ t: 'init', ...this.opts.snapshot() }));
    // both surfaces may be up at once (the desktop window and the in-page overlay); orders go to all
    this.pets.set(ws, { surface, host, since: Date.now() });
    this.opts.onPetConnect?.(host, surface);
    ws.on('message', (data, isBinary) => {
      if (!this.pets.has(ws) || isBinary) return; // no microphone path in this port
      let msg = null;
      try {
        const v = JSON.parse(String(data));
        if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.t === 'string') msg = v;
      } catch { /* a broken frame is dropped */ }
      if (msg) this.opts.onPetMessage?.(msg, surface);
    });
    ws.on('close', () => {
      if (!this.pets.delete(ws)) return;
      this.opts.onPetDisconnect?.(surface);
    });
  }

  /** Which surfaces are connected right now, for `/api/state` and the settings page. */
  surfaces() {
    const out = { page: false, desktop: false, count: this.pets.size };
    for (const info of this.pets.values()) out[info.surface] = true;
    return out;
  }

  /**
   * Reads are open to any loopback origin (the overlay page reads `/api/state`); writes are
   * accepted from any loopback origin too — this server only ever holds pet preferences, and the
   * Harness page that frames the pet is the same machine.
   */
  allowed(req, write) {
    if (!LOOPBACK.test(req.headers.host ?? '')) return false;
    const origin = req.headers.origin;
    if (origin === 'null') return !write;
    if (!origin) return true;
    try {
      return LOOPBACK.test(new URL(origin).host);
    } catch {
      return false;
    }
  }

  async handle(req, res) {
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (!this.allowed(req, write)) { res.writeHead(421).end(); return; }
    // loopback CORS, for the page that frames the pet from another local origin
    const origin = req.headers.origin;
    const cors = origin && origin !== 'null'
      ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        vary: 'origin',
      }
      : {};
    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }

    let url;
    try { url = new URL(req.url ?? '/', 'http://x'); } catch { res.writeHead(400).end(); return; }
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/figures') {
      return json(res, 200, this.opts.figures?.() ?? [], cors);
    }
    if (req.method === 'GET' && path === '/api/figures/status') {
      return json(res, 200, { importable: false, problems: this.opts.packProblems?.() ?? [] }, cors);
    }
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, this.opts.snapshot(), cors);
    if (req.method === 'GET' && path === '/api/prefs') {
      return json(res, 200, { prefs: this.opts.prefs?.() ?? {}, file: this.opts.prefsFile?.() ?? null }, cors);
    }
    if (req.method === 'GET' && path === '/api/avatar') { res.writeHead(404, cors).end(); return; }
    if (req.method === 'POST' && path === '/api/look') {
      // one look at the desktop, for the settings page (the pet's menu sends `{t:'look'}` instead)
      const result = await this.opts.onLook?.();
      return json(res, result?.ok ? 200 : 409, result ?? { ok: false, error: 'not wired' }, cors);
    }
    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, { ok: true, origin: this.origin, version: this.opts.version ?? null }, cors);
    }
    if (req.method === 'POST' && (path === '/api/prefs' || path === '/api/skin')) {
      const body = await readBody(req);
      let msg = null;
      try { msg = body ? JSON.parse(body) : null; } catch { msg = null; }
      if (!msg || typeof msg !== 'object') return json(res, 400, { error: 'bad json' }, cors);
      if (path === '/api/skin') this.opts.onSkin?.(msg.skin);
      else this.opts.onPrefs?.(msg);
      return json(res, 200, { ok: true }, cors);
    }
    if (req.method === 'GET' && path === '/figure-frame') {
      const self = `http://${req.headers.host}`;
      return this.sendFile(res, join(this.opts.webDir, 'figure-frame.html'), [
        'sandbox allow-scripts',
        "default-src 'none'",
        `script-src ${self}`,
        `img-src ${self} data: blob:`,
        "style-src 'unsafe-inline'",
        "connect-src 'none'",
        `frame-ancestors ${self} http://127.0.0.1:* http://localhost:*`,
      ].join('; '), false);
    }
    if (req.method === 'GET' && path.startsWith('/packs/')) {
      const [, , id, ...rest] = path.split('/');
      const pack = (this.opts.figures?.() ?? []).find((p) => p.id === id && !p.builtin);
      const dir = pack ? pack.dir : null;
      if (!dir) { res.writeHead(404).end(); return; }
      const full = safeJoin(dir, decodeURIComponent(rest.join('/')));
      if (!full) { res.writeHead(404).end(); return; }
      return this.sendFile(res, full, PACK_CSP, req.headers.origin === 'null');
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(302, { location: '/pet' }).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, cors).end(); return; }

    const file = PAGES[path] ?? (path.startsWith('/web/') ? decodeURIComponent(path.slice(5)) : null);
    if (!file) { res.writeHead(404, cors).end(); return; }
    const full = safeJoin(this.opts.webDir, file);
    if (!full) { res.writeHead(403, cors).end(); return; }
    if (PAGES[path]) return this.sendPage(res, full, cors);
    return this.sendFile(res, full, null, path.startsWith('/web/') && req.headers.origin === 'null', cors);
  }

  /** A page, its `<html lang>` set to the Harness UI language when it is one the pet speaks. */
  async sendPage(res, full, cors) {
    try {
      const html = await readFile(full, 'utf8');
      res.writeHead(200, {
        'content-type': MIME['.html'],
        'cache-control': 'no-cache',
        'content-security-policy': PAGE_CSP,
        ...cors,
      });
      res.end(html);
    } catch {
      res.writeHead(404).end();
    }
  }

  async sendFile(res, full, csp, frame = false, cors = {}) {
    try {
      const bytes = await readFile(full);
      res.writeHead(200, {
        'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': csp ?? PAGE_CSP,
        'x-content-type-options': 'nosniff',
        ...(frame ? { 'access-control-allow-origin': 'null' } : {}),
        ...cors,
      });
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  }
}

/** `path` inside `root`, or null when it climbs out. */
function safeJoin(root, path) {
  const base = normalize(root).replace(/[\\/]+$/, '') + sep;
  const full = normalize(join(base, path));
  return full.startsWith(base) ? full : null;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 64 * 1024;
function readBody(req) {
  return new Promise((done) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { req.destroy(); done(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done(null));
  });
}
