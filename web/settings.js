/**
 * The settings page's script, kept in its own file on purpose: the pages are served with
 * `default-src 'self'`, which blocks inline <script> — an inline block here would render the page
 * but silently do nothing (every control dead). Served at `/web/settings.js`.
 */
const SCHEMES = [['harness', 'Harness'], ['deepseek', 'DeepSeek'], ['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['qwen', 'Qwen'], ['kimi', 'Kimi'], ['minimax', 'MiniMax']];
const FIGURES = [['whale', '鲸鱼娘']];
const OUTFITS = [['maid', '女仆装'], ['cape', '冬装'], ['crew', '店员装']];
const ROAMS = [['off', 'off'], ['calm', 'calm'], ['free', 'free']];
const SURFACES = [['auto', '自动'], ['desktop', '桌面窗口'], ['page', '页面内'], ['both', '都显示']];
const TOGGLES = ['enabled', 'sound', 'statusBubble', 'sayReplies', 'chatEnabled', 'relayQq', 'sight', 'debugEvents'];

let prefs = null;
let path = '';

const $ = (id) => document.getElementById(id);

function paint() {
  if (!prefs) return;
  for (const key of TOGGLES) $(key).classList.toggle('on', !!prefs[key]);
  for (const [group, list] of [['surface', SURFACES], ['figure', FIGURES], ['scheme', SCHEMES], ['outfit', OUTFITS], ['roam', ROAMS]]) {
    const key = group === 'scheme' ? 'schemeName' : group;
    const holder = $(group);
    holder.innerHTML = '';
    for (const [id, label] of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip' + (id === prefs[key] ? ' on' : '');
      button.textContent = label;
      button.onclick = () => save({ [key]: id });
      holder.appendChild(button);
    }
  }
  $('scale').value = prefs.scale;
  $('glow').value = prefs.glow;
  $('scaleText').textContent = Math.round(prefs.scale * 100) + '%';
  $('glowText').textContent = prefs.glow;
  if (document.activeElement !== $('followCwd')) $('followCwd').value = prefs.followCwd || '';
  $('prefsPath').textContent = path || '~/.dsh/dsh-cortico-pet.json';
  void paintSessions();
  void paintDesktop();
}

/** The session picker: 自动 plus every live session, titled the way the GUI titles it. */
async function paintSessions() {
  const select = $('followSession');
  try {
    const data = await (await fetch('/api/sessions', { cache: 'no-store' })).json();
    if (!data.ok) throw new Error(data.error || 'list failed');
    select.innerHTML = '';
    select.appendChild(new Option('自动（最新在动的会话）', ''));
    for (const item of data.items) {
      const tail = item.cwd ? ` · ${item.cwd.split(/[\\/]/).filter(Boolean).pop()}` : '';
      select.appendChild(new Option(`${item.title || item.id.slice(0, 8)}${tail}${item.running ? ' · 运行中' : ''}`, item.id));
    }
    select.value = data.followSession ?? '';
    if (data.followSession && select.value !== data.followSession) {
      // the pinned session is gone from the list: keep it selectable so it can be cleared
      select.appendChild(new Option(`已固定的会话 ${String(data.followSession).slice(0, 8)}（不在列表里）`, data.followSession));
      select.value = data.followSession;
    }
  } catch (error) {
    // keep 自动 usable even when the Host cannot answer: the picker is not the only thing here
    select.innerHTML = '';
    select.appendChild(new Option('自动（最新在动的会话）', ''));
    select.appendChild(new Option(`（会话列表读不到：${error}）`, ''));
  }
}

/** What the Host half reports about the desktop window (from /api/state). */
async function paintDesktop() {
  const element = $('desktopState');
  try {
    const state = await (await fetch('/api/state', { cache: 'no-store' })).json();
    const desk = state.desktop ?? {};
    if (desk.running) element.textContent = `运行中${desk.pid ? `（pid ${desk.pid}）` : ''}`;
    else if (desk.error) element.textContent = `起不来：${desk.error}`;
    else element.textContent = '没在跑（选「桌面窗口」或「自动」会拉起它）';
    paintSight(state.sight);
  } catch {
    element.textContent = '读不到状态';
  }
}

/** What she saw last, in her own words, or which session the picture went to, or why not. */
function paintSight(sight) {
  const element = $('sightState');
  if (!sight) { element.textContent = '还没看过。'; return; }
  if (sight.busy) element.textContent = '正在看…';
  else if (sight.error && sight.error !== 'sight-off') element.textContent = `上次没看成：${sight.error}`;
  else if (sight.text) element.textContent = sight.text;
  else if (sight.session) element.textContent = `上次投给了会话 ${String(sight.session).slice(0, 8)}。`;
  else element.textContent = '还没看过。';
}

async function load() {
  const response = await fetch('/api/prefs', { cache: 'no-store' });
  const data = await response.json();
  prefs = data.prefs;
  path = data.file;
  paint();
}

async function save(patch) {
  const response = await fetch('/api/prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) return;
  Object.assign(prefs, patch);
  paint();
  $('saved').classList.add('on');
  setTimeout(() => $('saved').classList.remove('on'), 1200);
}

for (const key of TOGGLES) $(key).addEventListener('click', () => save({ [key]: !prefs[key] }));
$('scale').addEventListener('input', (event) => { $('scaleText').textContent = Math.round(event.target.value * 100) + '%'; });
$('scale').addEventListener('change', (event) => save({ scale: Number(event.target.value) }));
$('glow').addEventListener('input', (event) => { $('glowText').textContent = event.target.value; });
$('glow').addEventListener('change', (event) => save({ glow: Number(event.target.value) }));
$('followSession').addEventListener('change', (event) => save({ followSession: event.target.value || null }));
$('followCwd').addEventListener('change', (event) => save({ followCwd: event.target.value.trim() || null }));
$('openPet').addEventListener('click', () => window.open('/pet', '_blank', 'noopener'));
$('lookNow').addEventListener('click', async () => {
  const element = $('sightState');
  element.textContent = '正在看…';
  try {
    const response = await fetch('/api/look', { method: 'POST' });
    const result = await response.json();
    if (!result.ok) element.textContent = `没看成：${result.error}`;
    else if (result.session) element.textContent = `投给会话 ${String(result.session).slice(0, 8)} 了，等它回话。`;
    else element.textContent = result.text || '看了一眼。';
    void paintDesktop();
  } catch (error) {
    element.textContent = `没看成：${error}`;
  }
});
$('restartWindow').addEventListener('click', async () => {
  // flip the surface away and back: that stops the window and starts a fresh one
  const current = prefs.surface || 'auto';
  await save({ surface: 'page' });
  await new Promise((resolve) => setTimeout(resolve, 600));
  await save({ surface: current === 'page' ? 'auto' : current });
  void paintDesktop();
});
$('reset').addEventListener('click', () => save({
  enabled: true, figure: 'whale', schemeName: 'harness', outfit: 'maid', scale: 1, glow: 7, roam: 'calm',
  sound: true, statusBubble: true, saidBubbles: true, sayReplies: true, chatEnabled: true,
  surface: 'auto', followSession: null, followCwd: null, relayQq: true, sight: false, debugEvents: false,
}));

load().catch((error) => { document.body.dataset.error = String(error); });
