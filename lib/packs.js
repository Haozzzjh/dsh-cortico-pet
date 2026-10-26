/**
 * Figure packs: the pet's body, read from each pack's `figure.json`.
 *
 * Ported in spirit from Cortico's `packs.ts` (MIT, Pal-AI-Lab) but much smaller: this port ships the
 * whale from `web/whale/`, never installs or removes a pack, and only keeps the manifest fields the
 * pet page itself reads. Paths are the same (`/web/<id>/`), so the page and the pack's own code need
 * no rewrites. Upstream's second body, Coo, is not offered here (see `scanPacks`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const OPTION_ID = /^[a-z0-9]{1,24}$/;
const AUDIO = new Set(['.ogg', '.mp3', '.wav']);
const SOUND_KINDS = new Set(['move', 'touch', 'face', 'snore']);

const namesOf = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, s] of Object.entries(v)) if (typeof s === 'string' && s.trim()) out[k] = s.trim();
  return Object.keys(out).length ? out : null;
};
const inside = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/')
  && !p.split(/[\\/]/).includes('..') && !/^[a-z]+:/i.test(p) && !/[<>"\x00-\x1f]/.test(p);

/**
 * The manifest at `dir`, or a string saying what is wrong. Anything this port does not understand
 * (a word of an unknown kind, a sound of an unknown kind or type) is dropped rather than fatal:
 * a newer pack still loads with fewer words.
 */
export function readManifest(dir, builtin) {
  const file = join(dir, 'figure.json');
  if (!existsSync(file)) return 'no figure.json';
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { return `figure.json: ${err.message}`; }
  if (typeof raw?.id !== 'string' || !ID.test(raw.id)) return 'bad id';
  if (raw.id === 'coo' && !builtin) return 'coo is built in';
  const name = namesOf(raw.name);
  if (!name) return 'no name';
  if (!inside(raw.entry) || typeof raw.export !== 'string' || !raw.export) return 'bad entry';

  const axes = [];
  for (const a of Array.isArray(raw.axes) ? raw.axes : []) {
    const an = namesOf(a?.name);
    if (typeof a?.id !== 'string' || !ID.test(a.id) || !an || !Array.isArray(a.options) || !a.options.length) return 'bad axis';
    const options = [];
    for (const o of a.options) {
      const on = namesOf(o?.name);
      if (typeof o?.id !== 'string' || !OPTION_ID.test(o.id) || !on) return 'bad option';
      options.push({ id: o.id, name: on, ...(inside(o.thumb) ? { thumb: o.thumb } : {}), ...(typeof o.accent === 'string' ? { accent: o.accent } : {}) });
    }
    axes.push({ id: a.id, name: an, options });
  }

  const presets = [];
  for (const p of Array.isArray(raw.presets) ? raw.presets : []) {
    const pick = p?.pick;
    if (typeof p?.id !== 'string' || !ID.test(p.id) || !pick || typeof pick !== 'object') continue;
    if (!axes.every((a) => a.options.some((o) => o.id === pick[a.id]))) continue;
    presets.push({
      id: p.id,
      pick: Object.fromEntries(axes.map((a) => [a.id, pick[a.id]])),
      ...(namesOf(p.name) ? { name: namesOf(p.name) } : {}),
      ...(typeof p.accent === 'string' ? { accent: p.accent } : {}),
    });
  }

  const vocab = [];
  for (const w of Array.isArray(raw.vocab) ? raw.vocab : []) {
    if (typeof w?.id !== 'string' || !ID.test(w.id)) continue;
    if (w.kind !== 'expression' && w.kind !== 'motion') continue;
    if (typeof w.seconds !== 'number' || !(w.seconds > 0)) continue;
    vocab.push({ id: w.id, kind: w.kind, seconds: w.seconds, ...(w.lasting === true ? { lasting: true } : {}) });
  }

  const sounds = {};
  if (raw.sounds && typeof raw.sounds === 'object' && !Array.isArray(raw.sounds)) {
    for (const [soundName, d] of Object.entries(raw.sounds)) {
      if (!inside(d?.file) || !AUDIO.has(extname(d.file).toLowerCase())) continue;
      if (!SOUND_KINDS.has(d.kind) || !existsSync(join(dir, d.file))) continue;
      sounds[soundName] = { file: d.file, kind: d.kind, volume: typeof d.volume === 'number' ? d.volume : 1 };
    }
  }

  const needs = [];
  for (const n of Array.isArray(raw.needs) ? raw.needs : []) if (n === 'windows' && !needs.includes(n)) needs.push(n);

  return {
    manifest: 2,
    api: typeof raw.api === 'number' ? raw.api : 2,
    id: raw.id,
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    name,
    about: namesOf(raw.about) ?? name,
    entry: raw.entry,
    export: raw.export,
    ...(inside(raw.model) ? { model: raw.model } : {}),
    ...(inside(raw.thumb) ? { thumb: raw.thumb } : {}),
    axes,
    presets,
    vocab,
    sounds,
    can: { walk: raw?.can?.walk !== false },
    moves: [],
    needs,
    ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
    ...(typeof raw.license === 'string' ? { license: raw.license } : {}),
    ...(Array.isArray(raw.credits) ? { credits: raw.credits } : {}),
  };
}

/**
 * Every pack under `<webDir>/<id>/`. `builtin` packs answer at `/web/<id>/`; nothing else is
 * served here, so there are no installed-pack routes.
 *
 * **Coo is gone on purpose.** Upstream ships Coo as the second body *and* as the fallback for a
 * pack that fails; this port is the whale only. `web/coo/coo.js` stays because `pet-app.js` imports
 * its palettes and `mini()`, the little face drawn in the pet's menu — but the Coo *pack*
 * (`figure.json` + `figure.js`) has been deleted, so nothing can select it.
 */
export function scanPacks(webDir) {
  const packs = [];
  const problems = [];
  let entries = [];
  try { entries = readdirSync(webDir, { withFileTypes: true }); } catch { return { packs, problems }; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'coo') continue;
    const dir = join(webDir, entry.name);
    // `web/` also holds plain asset folders (kit, i18n, speech): only a `figure.json` makes a pack
    if (!existsSync(join(dir, 'figure.json'))) continue;
    const manifest = readManifest(dir, true);
    if (typeof manifest === 'string') { problems.push({ dir: entry.name, reason: manifest, loaded: false }); continue; }
    packs.push({ id: manifest.id, dir, base: `/web/${manifest.id}/`, builtin: true, manifest });
  }
  packs.sort((a, b) => a.id.localeCompare(b.id));
  return { packs, problems };
}

/** What `/api/figures` answers with (the shape `body-host.js` reads). */
export function figureListing(packs) {
  return packs.map(({ id, base, manifest: m }) => ({
    id, base, name: m.name, thumb: m.thumb ?? null, entry: m.entry, export: m.export,
    model: m.model ?? null, axes: m.axes, presets: m.presets, vocab: m.vocab, sounds: m.sounds,
    can: m.can, needs: m.needs, removable: false,
  }));
}

/** A file of `pack` by its path inside it, or null when the path climbs out. */
export function packFile(pack, path) {
  const root = normalize(pack.dir).replace(/[\\/]+$/, '') + sep;
  const full = normalize(join(root, path));
  return full.startsWith(root) ? full : null;
}

/** The scheme `pack` knows: one of its presets, else each axis's option, the axis's first where it does not name one. */
export function knownScheme(pack, scheme) {
  const m = pack.manifest ?? pack;
  if (m.presets?.some((p) => p.id === scheme)) return scheme;
  const parts = String(scheme ?? '').split('-');
  if (!m.axes?.length) return scheme ?? '';
  return m.axes.map((a, i) => (a.options.some((o) => o.id === parts[i]) ? parts[i] : a.options[0].id)).join('-');
}
