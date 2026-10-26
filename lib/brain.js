/**
 * The brain: what the Harness is doing, turned into what the pet does.
 *
 * Upstream this is `src/world.ts` (98 KB of roam arithmetic, dialogs, voice, CUA). Here the same
 * job is done by translating the Harness event stream — durable `session/event`s and the live
 * `agent/*` events — into the pet page's orders (`say`, `act`, `status`, `walk`, `prefs`), and by
 * turning what the page reports back (`text`, `control`, `prefs`) into Harness actions.
 */
const TOOL_STATUS = [
  [/^(read|read_image|glob|grep|list_dir|lsp)$/, 'read', '读文件'],
  [/^(write|edit|str_replace|notebook_edit)$/, 'write', '写文件'],
  [/^(bash|pwsh|shell|terminal_\w+)$/, 'work', '跑命令'],
  [/^web_search$/, 'search', '搜一下'],
  [/^(web_fetch|fetch|browse\w*)$/, 'browse', '看网页'],
  [/^(todo_write|todo_read)$/, 'write', '记清单'],
  [/^(subagent|subagent_fork|workflow|spawn_teammate|wait_agent|send_message|interrupt_agent)$/, 'wait', '分派任务'],
  [/^(ask_user_question|present|schedule_\w+)$/, 'alarm', '要问你'],
  [/^(create_goal|update_goal|get_goal|ralph)$/, 'work', '管目标'],
  [/^(job_\w+|team_task_\w+)$/, 'wait', '看后台'],
  // a chat bridge (QQ or anything that exposes `qq_*`-style tools): it listens, it types back,
  // it hands out stickers. Names are matched after the `mcp__<server>__` prefix is stripped.
  [/qq_send_(group|private)_message$/, 'type', '往群里说话'],
  [/qq_send_(burst|message)$/, 'type', '往群里说话'],
  [/qq_send_sticker$/, 'look', '发表情'],
  [/qq_(wait_for|get_unread|get_recent|get_message)\w*$/, 'wait', '听消息'],
  [/qq_collect_sticker$/, 'save', '偷表情'],
  [/^mcp__[a-z0-9_-]+__/, 'work', '连桥接'],
];

/** Words the pet says through `act`; only ones the whale actually knows are used. */
const ACTS = {
  thinking: 'thinking',
  happy: 'happy',
  nod: 'nod',
  wave: 'wave',
  look: 'look',
  dance: 'dance',
  sleep: 'sleep',
  stand: 'stand',
  dizzy: 'dizzy',
  sad: 'sad',
  confused: 'confused',
  excited: 'excited',
};

const SAID_MAX = 160;

export class PetBrain {
  /**
   * `send(order)` posts one order to the pet page; `snapshot()` is defined by the caller (it needs
   * the current status, which lives here); `prompt(text)` sends a prompt to the live session.
   */
  constructor({ send, prompt, prefs, log = () => {}, lang = () => 'zh' }) {
    this.send = send;
    this.prompt = prompt;
    this.prefs = prefs;
    this.log = log;
    this.lang = lang;
    this.status = { kind: 'work', text: '待机' };
    this.activeRoot = null;
    this.sawTool = false;
    this.turnStartedAt = 0;
    this.lastActAt = 0;
    this.actQueue = [];
    this.actTimer = null;
    this.idleTimer = null;
    this.saySeq = 0;
    this.debugSeq = 0;
  }

  /* ---------- page → Harness ---------- */

  /** One message the pet page sent (`server.ts`'s `onPetMessage`). */
  async onPetMessage(msg) {
    switch (msg.t) {
      case 'hello':
        this.greet();
        return;
      case 'text': {
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!text) return;
        if (!this.prefs.get().chatEnabled) { this.say('（聊天已关闭，在插件设置里打开）'); return; }
        this.sayLine(text, { echo: true });
        const ok = await this.prompt(text);
        if (!ok) this.say('发不出去：现在没有可以对话的会话。');
        return;
      }
      case 'prefs':
        // the pet's own menu switches (sound, theme, roam) land here; keep the record in step
        this.applyPagePrefs(msg);
        return;
      case 'control':
        this.log(`control: ${String(msg.action)}`);
        return;
      case 'position':
        if (typeof msg.x === 'number' && Number.isFinite(msg.x)) this.prefs.patch({ startX: msg.x });
        return;
      case 'figure':
        this.log(`figure: ${String(msg.id)} ok=${String(msg.ok)}${msg.reason ? ` reason=${msg.reason}` : ''}`);
        return;
      default:
        // touch, arrived, dialog, mic, devices, visibility, commit, cancel: nothing to do in this port
        return;
    }
  }

  applyPagePrefs(msg) {
    const patch = {};
    if (msg.roam === 'off' || msg.roam === 'calm' || msg.roam === 'free') patch.roam = msg.roam;
    if (typeof msg.sound === 'boolean') patch.sound = msg.sound;
    if (msg.theme === 'dark' || msg.theme === 'light') patch.theme = msg.theme;
    if (Object.keys(patch).length) this.prefs.patch(patch);
  }

  /* ---------- Harness → page ---------- */

  /** Subscribes to the Host events this port understands. Cordis disposes them with the plugin. */
  attach(ctx) {
    ctx.on('agent/status', (payload) => {
      const sessionId = payload?.agent?.id;
      if (!sessionId) return;
      if (payload.status === 'running') {
        if (!this.follow(sessionId)) return;
        this.clearIdle();
        this.sawTool = false;
        this.turnStartedAt = Date.now();
        this.setStatus({ kind: 'think', text: '在想…' });
        this.act('thinking');
      } else if (this.isActive(sessionId)) {
        this.settle();
      }
    });

    ctx.on('session/event', (session, event) => {
      const sessionId = session?.id;
      if (!sessionId || !event || typeof event.type !== 'string') return;
      if (this.prefs.get().debugEvents) this.debugEvent(event);
      if (!this.follow(session, event)) return;
      switch (event.type) {
        case 'turn/start':
          this.clearIdle();
          this.sawTool = false;
          this.setStatus({ kind: 'think', text: '在想…' });
          return;
        case 'tool/call': {
          const name = String(event.data?.name ?? '工具');
          const [, kind, text] = TOOL_STATUS.find(([re]) => re.test(name)) ?? [null, 'work', name];
          this.sawTool = true;
          this.setStatus({ kind, text, detail: shortToolName(name) });
          this.act(name === 'ask_user_question' ? 'look' : 'nod');
          this.relayQq(name, event.data?.arguments);
          return;
        }
        case 'assistant/message': {
          const text = textOfMessage(event.data?.message);
          if (!text || !this.prefs.get().sayReplies) return;
          this.setStatus(null);
          this.sayLine(summarize(text));
          this.act('happy');
          return;
        }
        case 'turn/end': {
          const kind = event.data?.reason?.kind;
          if (kind === 'completed') this.settle();
          else if (kind === 'error') this.fail(String(event.data?.reason?.error?.message ?? '出错了'));
          else if (kind === 'aborted') { this.setStatus(null); this.act('confused'); }
          else this.setStatus(null);
          return;
        }
        default:
          return;
      }
    });

    ctx.on('agent/error', (payload) => {
      const sessionId = payload?.agent?.id;
      if (sessionId && !this.isActive(sessionId)) return;
      this.fail(String(payload?.error?.message ?? payload?.error ?? '出错了'));
    });
  }

  /** Whether this session is one the pet should follow: pinned id, then pinned cwd, else newest live root. */
  follow(session, event) {
    const sessionId = session?.id;
    if (!sessionId) return false;
    const prefs = this.prefs.get();
    const pinnedId = prefs.followSession;
    if (pinnedId) {
      // a prefix is enough: session ids are long and the settings field is small
      const match = sessionId === pinnedId || sessionId.includes(pinnedId);
      if (match) this.activeRoot = sessionId;
      return match;
    }
    const cwd = String(session.cwd ?? session.header?.cwd ?? '');
    if (prefs.followCwd) {
      const match = cwd.toLowerCase().includes(prefs.followCwd.toLowerCase());
      if (match) this.activeRoot = sessionId;
      return match;
    }
    if (this.activeRoot === null) this.activeRoot = sessionId;
    if (sessionId !== this.activeRoot) {
      // a brand-new root turn takes the pet along; subagent chatter never steals it
      if (!event || event.type === 'turn/start' || event.type === 'user/message') {
        if (!this.isRoot(sessionId)) return false;
        this.activeRoot = sessionId;
      } else {
        return false;
      }
    }
    return true;
  }

  isActive(sessionId) {
    return this.activeRoot === sessionId;
  }

  isRoot(sessionId) {
    try {
      const agents = this.registry;
      if (!agents) return true;
      return agents.roots().some((agent) => agent.id === sessionId);
    } catch {
      return true;
    }
  }

  setRegistry(agents) {
    this.registry = agents;
  }

  /**
   * A chat bridge posts into a group through a tool call whose arguments already hold the text, so
   * she can say what your bot just said — no parsing of the group's own chatter, no guessing.
   */
  relayQq(toolName, rawArguments) {
    if (!this.prefs.get().relayQq) return;
    if (!/qq_send_(group|private|burst)_message$|qq_send_message$/.test(toolName)) return;
    let args;
    try { args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments; } catch { return; }
    const messages = args?.messages;
    const first = Array.isArray(messages) ? messages[0] : typeof messages === 'string' ? messages : null;
    if (typeof first !== 'string' || !first.trim()) return;
    const where = String(args?.key ?? '').startsWith('group:') ? '群里' : '私聊';
    const line = trim(first, 120);
    if (this.lastQqLine === line) return;
    this.lastQqLine = line;
    this.sayLine(`在${where}说：${line}`);
  }

  /* ---------- the pet's own state ---------- */

  settle() {
    this.setStatus(null);
    this.act(this.sawTool ? 'nod' : 'happy');
    this.sawTool = false;
    this.scheduleIdle();
  }

  fail(message) {
    this.setStatus({ kind: 'alarm', text: '出错了', detail: trim(message, 40) });
    this.act('dizzy');
    this.scheduleIdle();
  }

  setStatus(status) {
    const prev = this.status;
    this.status = status;
    if (JSON.stringify(prev) === JSON.stringify(status)) return;
    this.send({ t: 'status', status });
  }

  /** Queues one vocabulary word; the page plays one at a time, so they are paced here too. */
  act(word) {
    if (!word) return;
    const last = this.actQueue[this.actQueue.length - 1];
    if (last === word && Date.now() - this.lastActAt < 2500) return;
    this.actQueue.push(word);
    if (this.actQueue.length > 3) this.actQueue.shift();
    this.pump();
  }

  pump() {
    if (this.actTimer) return;
    const wait = Math.max(0, 1200 - (Date.now() - this.lastActAt));
    this.actTimer = setTimeout(() => {
      this.actTimer = null;
      const word = this.actQueue.shift();
      if (!word) return;
      // "stand" is the pack's own way out of sitting or sleeping; keep it for the wake-up
      this.lastActAt = Date.now();
      this.send({ t: 'act', actions: [word] });
      if (this.actQueue.length) this.pump();
    }, wait);
    this.actTimer.unref?.();
  }

  /** A line above the pet, said with a beat (the page types it out and babbles). */
  sayLine(text, { echo = false } = {}) {
    if (!text) return;
    const beats = [{ text: trim(text, SAID_MAX) }];
    this.send(echo ? { t: 'said', text: beats[0].text } : { t: 'say', id: `dsh-${++this.saySeq}`, beats });
  }

  say(text) {
    this.sayLine(text);
  }

  clearIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  scheduleIdle() {
    this.clearIdle();
    const wait = this.prefs.get().sleepAfterMs;
    if (!wait) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.act('sleep');
    }, wait);
    this.idleTimer.unref?.();
  }

  greet() {
    this.clearIdle();
    this.act('wave');
    this.sayLine(GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);
    if (!this.status) this.scheduleIdle();
  }

  debugEvent(event) {
    if (this.debugSeq++ > 400) return;
    try {
      this.log(`event ${event.type} ${JSON.stringify(event.data).slice(0, 2000)}`);
    } catch { /* unserialisable payload: skip it */ }
  }
}

const GREETINGS = [
  '我来啦，陪你写代码~',
  '今天也一起加油吧！',
  '有事喊我，我就在这儿。',
  '桌面交给我看着，你专心忙。',
];

/** The text of an assistant message, whatever block shape this Harness version used. */
function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : Array.isArray(message?.blocks) ? message.blocks : [];
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** One short line: the first sentence that says something, tidied for a bubble. */
function summarize(text) {
  const flat = text.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
  const firstLine = flat.split('\n').find((line) => line.trim().length > 0) ?? flat;
  const sentence = firstLine.split(/(?<=[。！？!?；;])/)[0] ?? firstLine;
  return trim(sentence.replace(/^[#>\-*\s]+/, ''), SAID_MAX);
}

function trim(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `mcp__<server>__qq_send_message` reads as `qq_send_message` in the pet's status bubble. */
function shortToolName(name) {
  const parts = String(name).split('__');
  return parts.length >= 3 ? parts.slice(2).join('__') : String(name);
}
