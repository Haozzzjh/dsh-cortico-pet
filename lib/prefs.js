/**
 * The pet's preferences, kept in one JSON file per Harness profile so the pet's look and habits
 * survive a restart. Everything the pet page reads through its `init`/`prefs` orders is derived
 * from this record (see `snapshot()` in index.js).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** The whale's own presets and outfits (see `web/whale/figure.json`). */
export const SCHEMES = ['deepseek', 'harness', 'chatgpt', 'claude', 'gemini', 'qwen', 'kimi', 'minimax'];
export const OUTFITS = ['maid', 'cape', 'crew'];
export const ROAMS = ['off', 'calm', 'free'];
export const HOVER_ACTIONS = ['chat', 'roam', 'theme', 'sound', 'hide'];
export const MAX_HOVER = 4;
/** Where the pet lives: `auto` = desktop window if it can start, else the in-page overlay. */
export const SURFACES = ['auto', 'desktop', 'page', 'both'];

export const DEFAULTS = {
  /** Whether the overlay is drawn at all. */
  enabled: true,
  figure: 'whale',
  /** One of SCHEMES: which vendor palette the whale wears. */
  schemeName: 'harness',
  /** One of OUTFITS. */
  outfit: 'maid',
  /** Body size, 0.6–1.8. */
  scale: 1,
  /** off | calm | free — how much she wanders while you work. */
  roam: 'calm',
  sound: true,
  /** Strength of the halo behind her, 0–20. */
  glow: 7,
  /** Her activity bubble ("在想…") — the pet's own status line. */
  statusBubble: true,
  /** Lines you send from the chat page, echoed above her. */
  saidBubbles: true,
  /** She says the assistant's finished answer out loud, as one short line. */
  sayReplies: true,
  hoverButtons: ['chat', 'roam', 'sound'],
  /** Passed to the page so its own palette matches the Harness theme. */
  theme: 'light',
  /** The Harness UI language, handed to the page's own text table. */
  language: 'zh',
  /** Where she stands above the viewport's bottom edge (in-page overlay only; the window has its own). */
  startX: 0.72,
  /** auto | desktop | page | both — desktop means a real always-on-top window on the Windows desktop. */
  surface: 'auto',
  /** An electron.exe to use instead of the unpacked/cached one. */
  electronPath: null,
  /** Typing into her chat box sends a prompt to the live session. */
  chatEnabled: true,
  /** Dozes off after this long with nothing running, 0 disables. */
  sleepAfterMs: 300000,
  /** Follow only this Session (a session id), or null to follow whichever session moved last. */
  followSession: null,
  /**
   * Follow every Session whose working directory contains this text (a QQ bridge's agents, say) —
   * sturdier than a session id, because those sessions come and go.
   */
  followCwd: null,
  /** Say the lines a QQ bridge posts into a group (read out of `qq_send_message` arguments). */
  relayQq: true,
  /**
   * May she look at the desktop? Off by default: a screenshot is a real privacy decision, so the
   * menu's eye button only exists while this is on, and every look is one click of it.
   */
  sight: false,
  /** Debug: append every Host event shape to `events.log` next to the prefs file. */
  debugEvents: false,
};

const CLAMP = {
  scale: [0.6, 1.8],
  glow: [0, 20],
  startX: [0, 1],
  sleepAfterMs: [0, 3_600_000],
};

export class PetPrefs {
  constructor() {
    this.file = prefsFile();
    this.values = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') this.values = sanitize({ ...DEFAULTS, ...raw });
    } catch { /* a broken file falls back to the defaults */ }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(this.values, null, 2)}\n`, 'utf8');
    } catch { /* a read-only home must not break the pet */ }
  }

  get() {
    return this.values;
  }

  /** Applies the keys it knows; returns the keys that actually changed. */
  patch(patch) {
    if (!patch || typeof patch !== 'object') return [];
    const next = sanitize({ ...this.values, ...patch });
    const changed = [];
    for (const key of Object.keys(next)) {
      if (JSON.stringify(next[key]) !== JSON.stringify(this.values[key])) changed.push(key);
    }
    if (changed.length) {
      this.values = next;
      this.save();
    }
    return changed;
  }
}

/** Only known keys, only sensible values — the record is also writable over HTTP. */
function sanitize(input) {
  const v = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (key in input) v[key] = input[key];
  v.enabled = !!v.enabled;
  v.sound = !!v.sound;
  v.statusBubble = !!v.statusBubble;
  v.saidBubbles = !!v.saidBubbles;
  v.sayReplies = !!v.sayReplies;
  v.chatEnabled = !!v.chatEnabled;
  v.debugEvents = !!v.debugEvents;
  // the whale is the only figure this build ships: anything else (an old 'coo', a stale value) is pulled back
  if (v.figure !== 'whale') v.figure = 'whale';
  if (!SCHEMES.includes(v.schemeName)) v.schemeName = DEFAULTS.schemeName;
  if (!OUTFITS.includes(v.outfit)) v.outfit = DEFAULTS.outfit;
  if (!ROAMS.includes(v.roam)) v.roam = DEFAULTS.roam;
  if (!SURFACES.includes(v.surface)) v.surface = DEFAULTS.surface;
  v.electronPath = typeof v.electronPath === 'string' && v.electronPath.trim() ? v.electronPath.trim() : null;
  if (v.theme !== 'dark') v.theme = 'light';
  if (typeof v.language !== 'string' || !v.language) v.language = DEFAULTS.language;
  v.relayQq = !!v.relayQq;
  v.sight = !!v.sight;
  v.followSession = typeof v.followSession === 'string' && v.followSession.trim() ? v.followSession.trim() : null;
  v.followCwd = typeof v.followCwd === 'string' && v.followCwd.trim() ? v.followCwd.trim() : null;
  for (const [key, [min, max]] of Object.entries(CLAMP)) {
    const n = Number(v[key]);
    v[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULTS[key];
  }
  v.hoverButtons = Array.isArray(v.hoverButtons)
    ? v.hoverButtons.filter((id) => HOVER_ACTIONS.includes(id)).slice(0, MAX_HOVER)
    : [...DEFAULTS.hoverButtons];
  return v;
}

/** `<profile>/dsh-cortico-pet.json`, else `~/.dsh/dsh-cortico-pet.json`. */
function prefsFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE;
  const dir = process.env.DSH_PROFILE_DIR || (profile ? join(home, 'profiles', profile) : home);
  return join(dir, 'dsh-cortico-pet.json');
}

/** The scheme string the pack understands: a preset id for the maid dress, else `<preset>-<outfit>`. */
export function schemeOf(prefs) {
  return prefs.outfit === 'maid' ? prefs.schemeName : `${prefs.schemeName}-${prefs.outfit}`;
}
