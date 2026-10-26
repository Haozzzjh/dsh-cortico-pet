/**
 * The overlay: the pet as a frame-wide, click-through iframe over the Harness window.
 *
 * Served by the pet server and pulled in by the Host half through `webServer.tapIndex()` — so the
 * pet does not depend on the client-plugin module loader at all. The pet page decides when it wants
 * the mouse (`petHost.setInteractive`); that wish becomes `pointer-events` here, which is what makes
 * the pet click-through everywhere except over herself, her bubbles, her menu and her hover buttons.
 *
 *   <script>window.__DSH_CORTICO_PET__ = { base: 'http://127.0.0.1:PORT', floor: 92, prefs: {...} }</script>
 *   <script src="http://127.0.0.1:PORT/web/dsh-overlay.js"></script>
 */
(() => {
  if (window.__dshCorticoPet?.installed) return;
  const cfg = window.__DSH_CORTICO_PET__;
  if (!cfg || !cfg.base) {
    console.warn('[dsh-cortico-pet] no base URL; the Host half did not inject window.__DSH_CORTICO_PET__');
    return;
  }

  /** How long the frame keeps taking the mouse after the page stops renewing its wish. */
  const LEASE_MS = 1500;
  const STATE_POLL_MS = 8000;
  const THEME_POLL_MS = 3000;
  const Z = 2147483000;

  const state = {
    base: String(cfg.base).replace(/\/+$/, ''),
    floor: Number(cfg.floor) || 92,
    enabled: cfg.prefs?.enabled !== false,
    /** False while the desktop window is carrying the pet. */
    overlayAllowed: true,
    theme: cfg.prefs?.theme === 'dark' ? 'dark' : 'light',
    language: typeof cfg.prefs?.language === 'string' ? cfg.prefs.language : 'zh',
    interactive: false,
    hovered: false,
  };

  const petUrl = () => `${state.base}/pet`;

  /* ---------- DOM ---------- */

  const host = document.createElement('div');
  host.dataset.dshCorticoPet = '';
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    zIndex: String(Z),
    pointerEvents: 'none',
    overflow: 'hidden',
    contain: 'layout style',
  });

  let frame = null;
  const lease = { timer: 0 };

  function mount() {
    if (frame || !state.enabled) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => mount(), { once: true });
      return;
    }
    frame = document.createElement('iframe');
    frame.src = petUrl();
    frame.title = '大肥鱼桌宠';
    frame.setAttribute('allow', 'autoplay');
    frame.setAttribute('scrolling', 'no');
    Object.assign(frame.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      border: '0',
      display: 'block',
      background: 'transparent',
      pointerEvents: 'none',
      colorScheme: 'normal',
    });
    host.appendChild(frame);
    if (!host.isConnected) document.body.appendChild(host);
    post({ kind: 'floor', px: state.floor });
    post({ kind: 'shown', shown: true });
  }

  function unmount() {
    clearTimeout(lease.timer);
    state.interactive = false;
    frame?.remove();
    frame = null;
  }

  function applyInteractive(on) {
    state.interactive = on;
    if (!frame) return;
    frame.style.pointerEvents = on ? 'auto' : 'none';
  }

  function post(message) {
    try { frame?.contentWindow?.postMessage({ __dshPet: true, ...message }, '*'); } catch { /* frame swapping */ }
  }

  /* ---------- the page's wishes ---------- */

  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__dshPet !== true) return;
    if (frame && event.source !== frame.contentWindow) return;
    switch (data.kind) {
      case 'interactive': {
        const on = !!data.on;
        clearTimeout(lease.timer);
        applyInteractive(on);
        if (on) lease.timer = setTimeout(() => applyInteractive(false), LEASE_MS);
        return;
      }
      case 'hide':
        void setEnabled(false);
        return;
      case 'open-dress':
        openSettings();
        return;
      case 'ready':
        post({ kind: 'floor', px: state.floor });
        post({ kind: 'shown', shown: true });
        return;
      case 'language':
        // the pet page learned its own language from its prefs; nothing to mirror back
        return;
      default:
        return;
    }
  });

  /* ---------- where the pointer is (a click-through frame cannot read it) ---------- */

  let pending = null;
  let scheduled = false;
  function flushCursor() {
    scheduled = false;
    if (!pending || !frame) return;
    const rect = frame.getBoundingClientRect();
    post({ kind: 'cursor', at: true, x: pending.x - rect.left, y: pending.y - rect.top });
    pending = null;
  }
  const onPointer = (event) => {
    pending = { x: event.clientX, y: event.clientY };
    if (!scheduled) { scheduled = true; requestAnimationFrame(flushCursor); }
  };
  const onLeave = () => post({ kind: 'cursor', at: false });

  addEventListener('pointermove', onPointer, { passive: true, capture: true });
  addEventListener('pointerdown', onPointer, { passive: true, capture: true });
  addEventListener('blur', onLeave);
  document.addEventListener('pointerleave', onLeave);

  /* ---------- the Harness look, mirrored into the pet page ---------- */

  function detectTheme() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;background:var(--dsw-alias-bg-base,#fff)';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const numbers = String(value).match(/\d+(\.\d+)?/g);
    if (!numbers || numbers.length < 3) return 'light';
    const [r, g, b] = numbers.slice(0, 3).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 ? 'dark' : 'light';
  }

  function detectLanguage() {
    const tags = [document.documentElement.lang, ...(navigator.languages || []), navigator.language].filter(Boolean);
    for (const tag of tags) {
      const value = String(tag).toLowerCase();
      if (value.startsWith('zh-tw') || value.startsWith('zh-hant') || value.startsWith('zh-hk')) return 'zh-Hant';
      if (value.startsWith('zh')) return 'zh';
      for (const code of ['en', 'ja', 'ko', 'fr', 'de', 'it', 'ru']) if (value.startsWith(code)) return code;
      if (value.startsWith('es')) return 'es-419';
      if (value.startsWith('pt')) return 'pt-BR';
    }
    return 'zh';
  }

  /* ---------- the Host half's record ---------- */

  async function readState() {
    try {
      const res = await fetch(`${state.base}/api/state`, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function writePrefs(patch) {
    try {
      const res = await fetch(`${state.base}/api/prefs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function setEnabled(on) {
    if (state.enabled === on) return;
    const ok = await writePrefs({ enabled: on });
    if (!ok) return;
    state.enabled = on;
    sync();
  }

  function openSettings() {
    window.open(`${state.base}/settings`, '_blank', 'noopener');
  }

  /* ---------- upkeep ---------- */

  async function syncLook(force = false) {
    const theme = detectTheme();
    const language = detectLanguage();
    if (!force && theme === state.theme && language === state.language) return;
    state.theme = theme;
    state.language = language;
    await writePrefs({ theme, language });
  }

  /** Mounts or unmounts the in-page overlay: she shows here only if she is enabled and not carrying
   *  the desktop window (a real always-on-top window takes precedence). */
  function sync() {
    const wanted = state.enabled && state.overlayAllowed;
    if (wanted) mount(); else unmount();
  }

  async function poll() {
    const snapshot = await readState();
    if (!snapshot) return;
    const enabled = snapshot.enabled !== false;
    const overlayAllowed = snapshot.overlay !== false;
    if (enabled === state.enabled && overlayAllowed === state.overlayAllowed) return;
    state.enabled = enabled;
    state.overlayAllowed = overlayAllowed;
    sync();
  }

  // the sidebar toggle and the settings page both ask for this
  addEventListener('dsh-cortico-pet:toggle', () => { void setEnabled(!state.enabled); });
  addEventListener('dsh-cortico-pet:refresh', () => { void poll(); });

  // ask the Host first: when the desktop window is up, the in-page overlay stays out of the way
  void poll().finally(() => {
    sync();
    void syncLook(true);
  });
  setInterval(() => { void poll(); }, STATE_POLL_MS);
  setInterval(() => { void syncLook(); }, THEME_POLL_MS);

  window.__dshCorticoPet = {
    installed: true,
    state,
    show: () => setEnabled(true),
    hide: () => setEnabled(false),
    toggle: () => setEnabled(!state.enabled),
    settings: openSettings,
    reload: () => { unmount(); mount(); },
    base: state.base,
  };
  console.info(`[dsh-cortico-pet] overlay ready — pet at ${petUrl()}`);
})();
