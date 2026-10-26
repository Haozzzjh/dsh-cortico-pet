/**
 * dsh-cortico-pet — the browser half.
 *
 * This half is *optional polish*: it adds the pet's settings page inside Harness's own settings panel
 * and an eye button at the sidebar foot. The pet herself is injected into the index by the Host half
 * (`webServer.tapIndex`) and runs from `web/dsh-overlay.js` on the pet server, so nothing here is
 * needed for her to appear.
 *
 * Written as a `__ModuleLoader__` package script: no top-level import/export, everything comes in
 * through the factory's `require`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cortico-pet',
  factory(require) {
    const module = { exports: {} };
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    /** The Host half's discovery route (see index.js). */
    const ENTRY = '/dsh-cortico-pet/entry.json';
    /** The Host half's own write route: same origin, so no port and no preflight involved. */
    const WRITE_PATH = '/dsh-cortico-pet/api/prefs';
    /** The Host half's live state, again same origin: lets the panel say what actually came up. */
    const STATE_PATH = '/dsh-cortico-pet/api/state';
    /** One look at the desktop, on demand (the Host half refuses unless `sight` is on). */
    const LOOK_PATH = '/dsh-cortico-pet/api/look';
    /** The session picker's rows: live sessions with their titles. */
    const SESSIONS_PATH = '/dsh-cortico-pet/api/sessions';
    const SCHEMES = [
      ['harness', 'Harness'],
      ['deepseek', 'DeepSeek'],
      ['chatgpt', 'ChatGPT'],
      ['claude', 'Claude'],
      ['gemini', 'Gemini'],
      ['qwen', 'Qwen'],
      ['kimi', 'Kimi'],
      ['minimax', 'MiniMax'],
    ];
    const OUTFITS = [
      ['maid', '女仆装'],
      ['cape', '冬装'],
      ['crew', '店员装'],
    ];
    const FIGURES = [
      ['whale', '鲸鱼娘（WebGL）'],
    ];
    const SURFACES = [
      ['auto', '自动'],
      ['desktop', '桌面窗口'],
      ['page', '页面内'],
      ['both', '都显示'],
    ];

    /* ---------- one shared little store: the Host's answer, and the prefs it holds ---------- */

    const store = {
      state: { base: null, pet: null, settings: null, prefs: null, desktop: null, sight: null, error: null, writeError: null },
      listeners: new Set(),
      set(patch) {
        Object.assign(this.state, patch);
        for (const listener of [...this.listeners]) {
          try { listener(); } catch { /* one bad listener */ }
        }
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };

    function useStore() {
      const [, bump] = useState(0);
      useEffect(() => store.subscribe(() => bump((n) => n + 1)), []);
      return store.state;
    }

    async function loadEntry() {
      try {
        const res = await fetch(ENTRY, { cache: 'no-store' });
        if (!res.ok) throw new Error(`entry ${res.status}`);
        const data = await res.json();
        if (!data.ok || !data.base) throw new Error('宠物服务没起来');
        store.set({ base: data.base, pet: data.pet, settings: data.settings, prefs: data.prefs, error: null });
        void loadDesktop();
        return data;
      } catch (err) {
        store.set({ error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }

    /** Whether the transparent window over the desktop actually came up (only the Host half knows). */
    async function loadDesktop() {
      const base = store.state.base;
      for (const url of [STATE_PATH, ...(base ? [`${base}/api/state`] : [])]) {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) continue;
          const data = await res.json();
          store.set({ desktop: data?.desktop ?? null, sight: data?.sight ?? null });
          return;
        } catch { /* try the next one */ }
      }
    }

    /** Loads until the Host half has a port, then keeps an eye on it at a lazy pace. */
    function startEntryPolling() {
      let tries = 0;
      let timer = 0;
      let ticker = 0;
      const tick = async () => {
        const data = await loadEntry();
        tries++;
        if (data) {
          // A panel left open across a plugin reload would otherwise keep a dead port forever.
          ticker = setInterval(() => { void loadEntry(); }, 10000);
          return;
        }
        // A Host half that is not up yet is not a dead end: start fast, then keep knocking slowly.
        timer = setTimeout(tick, tries > 40 ? 10000 : 1500);
      };
      void tick();
      return () => { clearTimeout(timer); clearInterval(ticker); };
    }

    /**
     * Writes a patch. The same-origin route answers first, so this works no matter which port the
     * pet server happens to be on; the pet server's own route is the fallback for an older Host half.
     * Either way the answer carries the whole record, so the switch moves the moment the write lands.
     */
    async function postPrefs(patch) {
      const base = store.state.base;
      const body = JSON.stringify(patch);
      const urls = [WRITE_PATH, ...(base ? [`${base}/api/prefs`] : [])];
      let lastError = '宠物服务没起来';
      for (const url of urls) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
          if (!res.ok) { lastError = `${url} → ${res.status}`; continue; }
          const data = await res.json().catch(() => null);
          if (data?.prefs) store.set({ prefs: data.prefs, writeError: null });
          else { store.set({ writeError: null }); await loadEntry(); }
          // the injected overlay listens for this and re-reads its own switch
          window.dispatchEvent(new Event('dsh-cortico-pet:refresh'));
          return true;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      store.set({ writeError: `没写进去：${lastError}` });
      return false;
    }

    /* ---------- the Harness look, handed to the pet page ---------- */

    function detectTheme() {
      try {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;background:var(--dsw-alias-bg-base,#fff)';
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const numbers = String(value).match(/\d+(\.\d+)?/g);
        if (!numbers || numbers.length < 3) return 'light';
        const [r, g, b] = numbers.slice(0, 3).map(Number);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 ? 'dark' : 'light';
      } catch {
        return 'light';
      }
    }

    function detectLanguage(locale) {
      let id = '';
      try {
        const snapshot = locale?.getLocale?.();
        id = String(snapshot?.id ?? snapshot?.locale ?? snapshot ?? '');
      } catch {
        id = '';
      }
      const value = id.toLowerCase();
      if (value.startsWith('zh-tw') || value.startsWith('zh-hant') || value.startsWith('zh-hk')) return 'zh-Hant';
      if (value.startsWith('zh')) return 'zh';
      for (const code of ['en', 'ja', 'ko', 'fr', 'de', 'it', 'ru']) if (value.startsWith(code)) return code;
      if (value.startsWith('es')) return 'es-419';
      if (value.startsWith('pt')) return 'pt-BR';
      return 'zh';
    }

    /* ---------- the settings page ---------- */

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 2px 24px', color: 'var(--dsw-alias-label-primary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '12px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      title: { fontSize: '13px', fontWeight: 600 },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.6' },
      chip: (active) => ({
        borderRadius: '999px',
        border: `1px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
        background: active ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: active ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
        padding: '5px 12px',
        fontSize: '12px',
        cursor: 'pointer',
      }),
      button: {
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '6px 12px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      toggle: (on) => ({
        width: '38px',
        height: '22px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
        position: 'relative',
        cursor: 'pointer',
        flex: '0 0 auto',
      }),
      knob: (on) => ({
        position: 'absolute',
        top: '2px',
        left: on ? '18px' : '2px',
        width: '16px',
        height: '16px',
        borderRadius: '999px',
        background: on ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
        transition: 'left .15s ease',
      }),
    };

    function Toggle({ value, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': value,
        'aria-label': label,
        style: S.toggle(value),
        onClick: () => onChange(!value),
      }, h('span', { style: S.knob(value) }));
    }

    function Row({ title, hint, children }) {
      return h('div', { style: S.row },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
          h('span', { style: S.title }, title),
          hint ? h('span', { style: S.hint }, hint) : null),
        children);
    }

    /** One honest line about where she actually is, so "nothing happened" is never the answer. */
    function whereLine(prefs, desktop) {
      if (prefs?.enabled === false) return '已收起。打开上面那个开关她就回来。';
      if (prefs?.surface === 'page') return '住在 Harness 页面里，不占桌面。';
      if (!desktop) return null;
      if (desktop.error) return `桌面窗口没起来：${desktop.error}`;
      if (desktop.running) return `桌面窗口运行中 · pid ${desktop.pid ?? '—'}`;
      return '桌面窗口还没起来。';
    }

    /** What she said the last time she looked, in her own words, or why she could not. */
    function sightText(live) {
      if (!live) return '还没看过。';
      if (live.busy) return '正在看…';
      if (live.error && live.error !== 'sight-off') return `上次没看成：${live.error}`;
      if (live.text) return live.text;
      if (live.session) return `上次投给了会话 ${String(live.session).slice(0, 8)}，回话念在气泡里。`;
      return '还没看过。';
    }

    /** One row of the session picker: the GUI's title, else the id; plus the workspace's last segment. */
    function sessionLabel(item) {
      const tail = item.cwd ? ` · ${String(item.cwd).split(/[\\/]/).filter(Boolean).pop()}` : '';
      return `${item.title || String(item.id).slice(0, 8)}${tail}${item.running ? ' · 运行中' : ''}`;
    }

    function PetSettings() {
      const state = useStore();
      const prefs = state.prefs;
      const [cwdDraft, setCwdDraft] = useState(prefs?.followCwd ?? '');
      const [looked, setLooked] = useState(null);
      const [sessions, setSessions] = useState(null);

      const inputStyle = {
        width: '190px',
        padding: '5px 9px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      };

      useEffect(() => startEntryPolling(), []);
      useEffect(() => { setCwdDraft(prefs?.followCwd ?? ''); }, [prefs?.followCwd]);
      useEffect(() => {
        // the picker's rows change as sessions come and go, so keep asking
        let alive = true;
        const tick = async () => {
          try {
            const res = await fetch(SESSIONS_PATH, { cache: 'no-store' });
            const data = await res.json();
            if (alive && data?.ok) setSessions(data.items ?? []);
          } catch { /* the picker keeps the last list it had */ }
        };
        void tick();
        const timer = setInterval(tick, 15000);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      if (!prefs) {
        return h('div', { style: S.wrap }, h('div', { style: S.hint },
          state.error ? `桌宠的 Host 半边还没起来：${state.error}` : '正在连桌宠…'));
      }

      const set = (patch) => { void postPrefs(patch); };
      const live = looked ?? state.sight;
      const lookNow = async () => {
        setLooked({ busy: true });
        try {
          const res = await fetch(LOOK_PATH, { method: 'POST' });
          const data = await res.json().catch(() => null);
          setLooked(data ?? { ok: false, error: `HTTP ${res.status}` });
        } catch (err) {
          setLooked({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        void loadDesktop();
      };

      return h('div', { style: S.wrap },
        state.writeError
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-label-error, #d94c4c)' } }, state.writeError)
          : null,
        h('div', { style: S.card },
          h(Row, { title: '显示桌宠', hint: '关掉就整块浮层收起；侧边栏底部的眼睛按钮随时叫回来。' },
            h(Toggle, { value: prefs.enabled !== false, onChange: (v) => set({ enabled: v }), label: '显示桌宠' })),
          h(Row, { title: '她住在哪儿', hint: '桌面窗口＝真正透明置顶、盖在整个桌面且鼠标穿透；页面内＝只在 Harness 窗口里浮着。' },
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
              SURFACES.map(([id, label]) => h('button', {
                key: id,
                type: 'button',
                style: S.chip(prefs.surface === id),
                onClick: () => set({ surface: id }),
              }, label)))),
          h(Row, { title: '形象' },
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
              FIGURES.map(([id, label]) => h('button', {
                key: id,
                type: 'button',
                style: S.chip(prefs.figure === id),
                onClick: () => set({ figure: id }),
              }, label)))),
          h(Row, { title: '配色', hint: '她穿谁家的工作服。' },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end' } },
              SCHEMES.map(([id, label]) => h('button', {
                key: id,
                type: 'button',
                style: S.chip(prefs.schemeName === id),
                onClick: () => set({ schemeName: id }),
              }, label)))),
          h(Row, { title: '服装' },
            h('div', { style: { display: 'flex', gap: '6px' } },
              OUTFITS.map(([id, label]) => h('button', {
                key: id,
                type: 'button',
                style: S.chip(prefs.outfit === id),
                onClick: () => set({ outfit: id }),
              }, label)))),
          whereLine(prefs, state.desktop)
            ? h('div', { style: S.hint }, whereLine(prefs, state.desktop))
            : null,
        ),
        h('div', { style: S.card },
          h(Row, { title: '大小', hint: `${Math.round(prefs.scale * 100)}%` },
            h('input', {
              type: 'range',
              min: 0.6,
              max: 1.8,
              step: 0.05,
              value: prefs.scale,
              style: { width: '160px', accentColor: 'var(--dsw-alias-brand-primary)' },
              onChange: (event) => set({ scale: Number(event.target.value) }),
            })),
          h(Row, { title: '走动', hint: 'off 站着不动，calm 偶尔溜达，free 想走就走。' },
            h('div', { style: { display: 'flex', gap: '6px' } },
              ['off', 'calm', 'free'].map((id) => h('button', {
                key: id,
                type: 'button',
                style: S.chip(prefs.roam === id),
                onClick: () => set({ roam: id }),
              }, id)))),
          h(Row, { title: '音效' }, h(Toggle, { value: !!prefs.sound, onChange: (v) => set({ sound: v }), label: '音效' })),
          h(Row, { title: '光晕', hint: `强度 ${prefs.glow}` },
            h('input', {
              type: 'range',
              min: 0,
              max: 20,
              step: 1,
              value: prefs.glow,
              style: { width: '160px', accentColor: 'var(--dsw-alias-brand-primary)' },
              onChange: (event) => set({ glow: Number(event.target.value) }),
            })),
        ),
        h('div', { style: S.card },
          h(Row, { title: '状态气泡', hint: '她头顶那行「在想… · read」。' },
            h(Toggle, { value: !!prefs.statusBubble, onChange: (v) => set({ statusBubble: v }), label: '状态气泡' })),
          h(Row, { title: '回答说一遍', hint: '每轮结束把答案的第一句念在气泡里。' },
            h(Toggle, { value: !!prefs.sayReplies, onChange: (v) => set({ sayReplies: v }), label: '回答说一遍' })),
          h(Row, { title: '抱在怀里聊天', hint: '点她身上的对话按钮，打字就发进当前会话。' },
            h(Toggle, { value: !!prefs.chatEnabled, onChange: (v) => set({ chatEnabled: v }), label: '宠物聊天' })),
          h(Row, { title: '跟随会话', hint: '「自动」＝跟最新在动的那个；挑一个就只看它 —— 她的截图也投给它。' },
            h('select', {
              value: prefs.followSession ?? '',
              style: { ...inputStyle, width: '210px', fontFamily: 'inherit' },
              onChange: (event) => set({ followSession: event.target.value || null }),
            },
            h('option', { value: '' }, '自动（最新在动的会话）'),
            (sessions ?? []).map((item) => h('option', { key: item.id, value: item.id }, sessionLabel(item))),
            prefs.followSession && !(sessions ?? []).some((item) => item.id === prefs.followSession)
              ? h('option', { key: 'pinned', value: prefs.followSession }, `已固定的会话 ${String(prefs.followSession).slice(0, 8)}（不在列表里）`)
              : null)),
          h(Row, { title: '跟随工作区', hint: '按 cwd 子串匹配；桥接那种会话 id 会轮换的场景用它更稳。' },
            h('input', {
              type: 'text',
              value: cwdDraft,
              placeholder: '不限',
              spellCheck: false,
              style: inputStyle,
              onChange: (event) => setCwdDraft(event.target.value),
              onBlur: () => set({ followCwd: cwdDraft.trim() || null }),
              onKeyDown: (event) => { if (event.key === 'Enter') set({ followCwd: cwdDraft.trim() || null }); },
            })),
          h(Row, { title: '念机器人发出去的话', hint: '用气泡说出桥接机器人刚发出去的那一句（群聊 / 私聊都算）。' },
            h(Toggle, { value: !!prefs.relayQq, onChange: (v) => set({ relayQq: v }), label: '念机器人' })),
        ),
        h('div', { style: S.card },
          h(Row, { title: '让她看桌面', hint: '打开后菜单里多一个眼睛按钮：每按一次截一张屏，投给她盯着的那个会话，回的答案念在气泡里。关着就不截。' },
            h(Toggle, { value: !!prefs.sight, onChange: (v) => set({ sight: v }), label: '让她看桌面' })),
          h(Row, { title: '现在看一眼', hint: sightText(live) },
            h('button', { type: 'button', style: S.button, onClick: () => { void lookNow(); } }, '看一眼')),
        ),
        h('div', { style: S.card },
          h(Row, { title: '调试宿主事件', hint: '把 Host 事件原文写进 dsh-cortico-pet.log。' },
            h(Toggle, { value: !!prefs.debugEvents, onChange: (v) => set({ debugEvents: v }), label: '调试' })),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              style: S.button,
              onClick: () => window.open(`${state.base}/settings`, '_blank', 'noopener'),
            }, '打开独立设置页'),
            h('button', {
              type: 'button',
              style: S.button,
              onClick: () => set({ startX: 0.72, scale: 1, roam: 'calm', glow: 7, enabled: true }),
            }, '恢复默认'),
          ),
          h('div', { style: S.hint }, `宠物服务：${state.base}`),
        ),
      );
    }

    /** The sidebar-foot eye: one click shows or hides her. */
    function PetToggleButton() {
      const state = useStore();
      const enabled = state.prefs?.enabled !== false;
      return h('button', {
        type: 'button',
        title: enabled ? '收起桌宠' : '叫出桌宠',
        'aria-label': enabled ? '收起桌宠' : '叫出桌宠',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          borderRadius: '8px',
          border: '1px solid transparent',
          background: 'transparent',
          color: enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer',
        },
        onClick: () => window.dispatchEvent(new Event('dsh-cortico-pet:toggle')),
      }, h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M3 12c2.4-4 5.7-6 9-6s6.6 2 9 6c-2.4 4-5.7 6-9 6s-6.6-2-9-6z' }),
      h('circle', { cx: 12, cy: 12, r: 2.6 })));
    }

    /* ---------- wiring ---------- */

    const name = 'cortico-pet';
    const inject = ['slots'];

    function apply(ctx) {
      const locale = ctx.get?.('locale');
      // plain functions: apply() is not a render pass, so no hooks here
      const syncLook = () => {
        const base = store.state.base;
        if (!base) return;
        void fetch(`${base}/api/prefs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ theme: detectTheme(), language: detectLanguage(locale) }),
        }).catch(() => {});
      };

      ctx.effect(() => { const timer = setTimeout(syncLook, 800); return () => clearTimeout(timer); }, 'cortico-pet: first look sync');
      ctx.effect(() => ctx.on('theme/change', () => setTimeout(syncLook, 60)), 'cortico-pet: theme sync');
      ctx.effect(() => ctx.on('locale/change', () => setTimeout(syncLook, 60)), 'cortico-pet: language sync');

      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'cortico-pet', order: 60, label: () => '桌宠' },
          PetSettings,
        );
      });

      ctx.slots.inject('sidebar.footer.action', function* () {
        yield ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'cortico-pet-toggle', order: 40, label: () => '桌宠' },
          PetToggleButton,
        );
      });
    }

    /** `React.useCallback` with the same signature, kept out of the way of the factory's destructuring. */
    module.exports = { name, inject, apply };
    return module.exports;
  },
});
