/**
 * Her eyesight — one picture of the desktop, on demand.
 *
 * The pet sees nothing by herself. This module is the whole of it: one screenshot, those bytes
 * handed to the Harness attachment store and to the default vision model, one or two sentences back.
 * Nothing here runs on a timer, and nothing runs at all unless the settings say she may look
 * (`prefs.sight`) *and* someone asked her to (the menu's eye button → `{t:'look'}`).
 *
 * Two capture backends, because neither is guaranteed everywhere: Pillow's `ImageGrab` when a Python
 * with Pillow can be found (fast, DPI-aware, multi-monitor), else Windows PowerShell + System.Drawing.
 * Both downscale to `MAX_WIDTH`, which is plenty to read a desktop out loud and keeps the vision
 * request small.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { closeSync, existsSync, openSync } from 'node:fs';
import { rmSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Wide enough to read what is on screen, small enough that one look is not a thousand tokens. */
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 900;
const TIMEOUT_MS = 25000;
const CALL_TIMEOUT_MS = 60000;
/** Two looks in the same breath are a mis-click, not a request. */
const COOLDOWN_MS = 4000;

const SYSTEM = [
  '你是一只住在 Windows 桌面上的桌宠，能看见用户此刻的屏幕。',
  '用中文说一到两句，像坐在旁边的人随口说的：先说你在屏幕上认出了什么（哪个窗口、在干什么），',
  '再补一句你的猜测或感慨。不要罗列清单，不要提「截图」「图片」「分辨率」这些词，也不要问问题。',
].join('');

const QUESTION = '这是我现在的屏幕。用一到两句话说说我可能在干什么。';

const PYTHON_CAPTURE = `
import sys
from PIL import ImageGrab
image = ImageGrab.grab(all_screens=True)
image.thumbnail((${MAX_WIDTH}, ${MAX_HEIGHT}))
if image.mode != 'RGB':
    image = image.convert('RGB')
image.save(sys.argv[1], optimize=True)
`;

const POWERSHELL_CAPTURE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DshDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[DshDpi]::SetProcessDPIAware() | Out-Null
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$full = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $full.Size)
$width = ${MAX_WIDTH}
if ($screen.Width -lt $width) { $width = $screen.Width }
$height = [int]($screen.Height * $width / $screen.Width)
if ($height -gt ${MAX_HEIGHT}) { $height = ${MAX_HEIGHT}; $width = [int]($screen.Width * $height / $screen.Height) }
$small = New-Object System.Drawing.Bitmap($width, $height)
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($full, 0, 0, $width, $height)
$small.Save('%OUT%', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $g2.Dispose(); $full.Dispose(); $small.Dispose()
`;

/** The line the screenshot arrives with, inside the selected session. */
const FEED_TEXT = [
  '（桌上那只桌宠按了下眼睛按钮，把此刻的屏幕截图贴在这里。）',
  '看一下我在干什么，用一到两句中文说说；别列清单，不用提"截图"这个词。',
].join('');

export function createSight({ ctx, prefs, brain, log = () => {}, targetSession = () => null }) {
  const state = { busy: false, at: 0, text: '', error: null, model: null, bytes: 0, session: null };

  /** One look. Returns what she said, or why she could not say anything. */
  async function look(trigger = 'menu') {
    const p = prefs.get();
    if (!p.sight) {
      state.error = 'sight-off';
      return { ok: false, error: '还没允许她看桌面（设置 → 桌宠 → 让她看桌面）' };
    }
    if (state.busy) return { ok: false, error: '正在看，别急' };
    if (Date.now() - state.at < COOLDOWN_MS) return { ok: false, error: '刚看过' };
    state.busy = true;
    state.error = null;
    try {
      log(`sight: looking (${trigger})`);
      brain.act('look');
      brain.say('看一眼…');
      const shot = await shoot({ ctx, log });
      state.bytes = shot.bytes;
      state.at = Date.now();

      // 1) the screenshot goes to the session she follows: that agent looks, that agent answers
      const fed = await feedSession(shot);
      if (fed) {
        state.session = fed;
        state.text = '';
        log(`sight: ${shot.tool} ${shot.bytes} bytes → session ${String(fed).slice(0, 8)}`);
        brain.say('看见了，等那边的回话…');
        return { ok: true, session: fed, tool: shot.tool, bytes: shot.bytes };
      }

      // 2) nobody to talk to: ask the default model directly, so a bare Harness still gets an answer
      const text = await describe(shot.ref, shot);
      state.session = null;
      state.text = text;
      log(`sight: ${shot.tool} ${shot.bytes} bytes → ${text.slice(0, 80)}`);
      brain.say(text);
      return { ok: true, text, tool: shot.tool, bytes: shot.bytes };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.at = Date.now();
      state.error = message;
      log(`sight failed: ${message}`);
      brain.say(`没看成：${message}`);
      return { ok: false, error: message };
    } finally {
      state.busy = false;
    }
  }

  /**
   * Hand the picture to the agent in the selected session, as a user turn with an image part. The
   * Host admits the bytes into its attachment store, so nothing here needs to be durable first.
   * Returns the session id it reached, or null when there is no session to reach.
   */
  async function feedSession(shot) {
    const controller = ctx.get('sessionController');
    if (!controller || typeof controller.prompt !== 'function') return null;
    let sessionId = null;
    try { sessionId = await targetSession(); } catch { sessionId = null; }
    if (!sessionId) { log('sight: no session to feed, falling back to the default model'); return null; }
    log(`sight: feeding ${String(sessionId).slice(0, 8)}`);
    const accepted = await controller.prompt({
      requestId: `dsh-cortico-pet-look-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [
        { type: 'text', text: FEED_TEXT },
        { type: 'image', mediaType: 'image/png', data: shot.data.toString('base64'), name: 'desktop.png' },
      ],
      clientTimeZone: safeTimeZone(),
    }, AbortSignal.timeout(CALL_TIMEOUT_MS));
    if (accepted?.accepted !== true) throw new Error('那个会话没收下这张图');
    return sessionId;
  }

  /**
   * One non-streaming voice turn against the default model. `prepareCall` is what tells us whether
   * that model can even take a picture; when it cannot, say so instead of sending bytes nowhere.
   */
  async function describe(image, shot) {
    const llm = ctx.get('llm');
    if (!llm || typeof llm.stream !== 'function') throw new Error('Harness 没有 llm 服务');
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null;
    const provider = selection?.provider;
    const model = selection?.model;
    if (!provider || !model) throw new Error('没有默认模型');
    state.model = `${provider}/${model}`;

    const config = { provider, model, maxTokens: 400, temperature: 0.4 };
    let prepared = null;
    try {
      prepared = await llm.prepareCall?.(config);
    } catch (err) {
      throw new Error(`模型 ${model} 用不了：${err?.message ?? err}`);
    }
    const modalities = prepared?.inputModalities;
    if (Array.isArray(modalities) && !modalities.includes('image')) {
      throw new Error(`${model} 不吃图（换一个能看图的默认模型）`);
    }

    // `prepareCall` materializes the adapter's own defaults, and a prepared handle refuses to dispatch
    // a config that no longer matches ("config changed before adapter dispatch"). So the call config
    // comes from the prepared handle whenever there is one, not from the numbers we asked for.
    const callConfig = prepared?.config ?? config;
    const options = {
      ...callConfig,
      // A side call, not an agent turn: `session-title` is the purpose the DeepSeek adapter maps to
      // "no thinking", so the whole budget goes to the one line we ask for.
      purpose: 'session-title',
      system: SYSTEM,
      // a look that hangs is worse than no look: one minute, then she says it did not work
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      messages: [{
        role: 'user',
        content: [
          { type: 'image', attachment: image },
          { type: 'text', text: QUESTION },
        ],
      }],
    };
    // Dispatch through `llm.stream`, not the prepared handle: a prepared call refuses to dispatch a
    // config that no longer matches what it materialized ("config changed before adapter dispatch"),
    // while `llm.stream` prepares and dispatches in one step. `prepareCall` above still did its job —
    // it told us whether this model can take a picture at all.
    const chunks = llm.stream(options);

    let text = '';
    let reasoning = 0;
    let failure = null;
    for await (const chunk of chunks) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk?.type === 'reasoning-delta') reasoning += 1;
      else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) {
      if (failure) throw new Error(failure.message ?? failure.code ?? '模型报错');
      throw new Error(reasoning ? '模型光顾着想了，没说话' : '模型没说话');
    }
    log(`sight: ${shot.tool} ${shot.bytes} bytes, model ${state.model}`);
    return text;
  }

  return { state, look, shoot: () => shoot({ ctx, log }) };
}

/* ---------- the screen ---------- */

/**
 * One screenshot, ready for a model: PNG bytes plus the durable attachment reference the request
 * needs. Both the pet's own look and the agent's tool go through here, so they always agree on size,
 * encoding and where the bytes live.
 */
export async function shoot({ ctx, log = () => {} }) {
  const shot = await captureDesktop({ log });
  const attachments = ctx.get('attachments');
  if (!attachments || typeof attachments.saveImage !== 'function') throw new Error('Harness 没有附件服务');
  const ref = await attachments.saveImage({ data: shot.data, mediaType: 'image/png', name: 'desktop.png' });
  return { data: shot.data, bytes: shot.data.byteLength, ref, tool: shot.tool };
}

/** The Host's time zone, for the sessions that log one alongside a prompt. */
function safeTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
}

/** One grab of the whole virtual screen, downscaled, as PNG bytes. Exported for `dev/` checks. */
export async function captureDesktop({ log = () => {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pet-sight-'));
  const file = join(dir, 'desktop.png');
  try {
    const python = await findPython();
    if (python) {
      try {
        await run(python, ['-c', PYTHON_CAPTURE, file]);
        return { data: await readFile(file), tool: 'pillow' };
      } catch (err) {
        log(`sight: pillow capture failed (${err?.message ?? err}), trying powershell`);
      }
    }
    const script = POWERSHELL_CAPTURE.replaceAll('%OUT%', file.replaceAll("'", "''"));
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    return { data: await readFile(file), tool: 'powershell' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Runs one capture command to completion. Output goes to a file rather than a pipe: piped stdio is
 * the one thing a confined process cannot open, and the file is also the only place the useful part
 * of a PowerShell stack trace ever appears.
 */
function run(command, args) {
  return new Promise((done, fail) => {
    const logPath = join(tmpdir(), `dsh-pet-sight-${process.pid}-${Date.now()}.log`);
    let fd = -1;
    try { fd = openSync(logPath, 'w'); } catch { fd = -1; }
    let settled = false;
    const child = spawn(command, args, {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', fd >= 0 ? fd : 'ignore', fd >= 0 ? fd : 'ignore'],
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (fd >= 0) { try { closeSync(fd); } catch { /* already closed */ } }
      let detail = '';
      try {
        detail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-3).join(' ').slice(0, 240);
      } catch { /* no output captured */ }
      try { rmSync(logPath, { force: true }); } catch { /* nothing to clean */ }
      if (error) fail(new Error(detail || error.message));
      else done();
    };
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => finish(code === 0 ? null : new Error(`${command} exited ${code ?? signal}`)));
  });
}

/** A Python that ships Pillow: `DSH_PET_PYTHON`, the Harness runtime's own, or whatever is on PATH. */
async function findPython() {
  const explicit = process.env.DSH_PET_PYTHON;
  if (explicit && existsSync(explicit)) return explicit;
  const runtimes = join(homedir(), '.dsh', 'dsh-runtimes');
  try {
    for (const name of await readdir(runtimes)) {
      const candidate = join(runtimes, name, 'dependencies', 'python', 'python.exe');
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* no runtime tree: fall through to PATH */ }
  return 'python';
}
