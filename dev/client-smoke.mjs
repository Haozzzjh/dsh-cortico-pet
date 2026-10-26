/**
 * Loads the browser half with stand-ins for everything the Harness page provides, then renders the
 * settings page once and walks the registered slots. Catches wiring and render-time crashes without
 * a browser or a Harness restart.
 *
 *   node dev/client-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failures.push(label); };

/* ---------- the platform: __ModuleLoader__, react, fetch, DOM bits ---------- */

const loaded = [];
const listeners = new Map();
const fakeWindow = {
  __ModuleLoader__: { load(info) { loaded.push(info); } },
  addEventListener(type, fn) { listeners.set(type, fn); },
  removeEventListener() {},
  dispatchEvent() {},
  pointerTo: null,
};
globalThis.window = fakeWindow;

const elements = [];
const react = {
  createElement(type, props, ...children) {
    const element = { type, props: props ?? {}, children };
    elements.push(element);
    return element;
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
  useEffect() {},
  useRef(value) { return { current: value }; },
  useCallback(fn) { return fn; },
};
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const code = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');
new Function('window', 'fetch', 'document', 'requestAnimationFrame', code)(fakeWindow, globalThis.fetch, { addEventListener() {}, removeEventListener() {} }, () => 0);

check(loaded.length === 1, `client.js registered one module through __ModuleLoader__ (got ${loaded.length})`);
const info = loaded[0];
check(info?.id === 'dsh-cortico-pet', `module id is the package name (got ${info?.id})`);

const mod = info.factory((name) => {
  if (name === 'react') return react;
  throw new Error(`unexpected require(${name})`);
});
check(typeof mod.apply === 'function', 'factory returns an apply()');
check(mod.name === 'cortico-pet', `plugin name is cortico-pet (got ${mod.name})`);
check(Array.isArray(mod.inject) && mod.inject.includes('slots'), `inject lists slots (got ${JSON.stringify(mod.inject)})`);

/* ---------- apply() against a stand-in client ctx ---------- */

const registered = [];
const components = new Map();
const effects = [];
const ctx = {
  get: (name) => (name === 'locale' ? { getLocale: () => ({ id: 'zh-CN' }) } : name === 'theme' ? { getTheme: () => ({}) } : undefined),
  on: (name) => { registered.push(`on:${name}`); return () => {}; },
  effect: (callback, label) => { effects.push(label); const dispose = callback(); return dispose ?? (() => {}); },
  slots: {
    inject(key, callback) {
      const effect = callback();
      const iterator = effect?.[Symbol.iterator] ? effect : null;
      if (!iterator) { registered.push(`inject-no-generator:${key}`); return () => {}; }
      let step = iterator.next();
      while (!step.done) { registered.push(`register:${key}`); step = iterator.next(); }
      return () => {};
    },
    register(entry, component) { registered.push(`entry:${entry.name}#${entry.id}`); components.set(entry.id, component); return () => {}; },
  },
};

mod.apply(ctx);
console.log('slots/effects:', registered.filter((r) => !r.startsWith('on:')).join(', '));
check(registered.includes('entry:settings.section#cortico-pet'), 'registers a settings section');
check(registered.includes('entry:sidebar.footer.action#cortico-pet-toggle'), 'registers the sidebar toggle');
check(registered.includes('on:theme/change'), 'listens for theme changes');
check(!registered.some((r) => r.includes('shell.overlay')), 'leaves the overlay to the injected script');

/* ---------- render pass: every registered component survives its loading state ---------- */

for (const [key, component] of components) {
  elements.length = 0;
  try {
    component({});
    check(elements.length > 0, `${key} renders (${elements.length} elements)`);
  } catch (err) {
    check(false, `${key} renders — ${err.message}`);
  }
}

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall client checks passed');
process.exit(failures.length ? 1 : 0);
