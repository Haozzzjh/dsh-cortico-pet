/**
 * Finds (or unpacks) the Electron runtime the desktop window runs on.
 *
 * The Harness desktop app *is* Electron, but its executable cannot host a second, unrelated app
 * window, so this looks for a standalone `electron.exe`:
 *
 *   1. an explicit path (`prefs.electronPath` or `DSH_CORTICO_PET_ELECTRON`);
 *   2. a build unpacked by an earlier run, under `<localAppData>/dsh-cortico-pet/electron/`;
 *   3. any Electron zip already sitting in the shared `@electron/get` cache
 *      (`%LOCALAPPDATA%\electron\Cache`, written by other plugins that ship Electron helpers) —
 *      unpacked here, so nothing is downloaded.
 *
 * Unpacking uses the `tar.exe` every supported Windows ships (bsdtar reads zip), falling back to
 * PowerShell's `Expand-Archive`.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CACHE_ROOT = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-cortico-pet', 'electron');
const ELECTRON_CACHE = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'electron', 'Cache');

/** The electron.exe this package should use, or a string saying why there is none yet. */
export async function resolveElectron(prefs, log = () => {}) {
  const explicit = prefs?.electronPath || process.env.DSH_CORTICO_PET_ELECTRON;
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    log(`electronPath is set but missing: ${explicit}`);
  }

  const unpacked = findUnpacked();
  if (unpacked) return unpacked;

  const candidates = cachedZips();
  if (!candidates.length) {
    return `no Electron found: put an electron.exe path in the pet settings, or drop an electron-v*-win32-x64.zip into ${ELECTRON_CACHE}`;
  }
  for (const zip of candidates) {
    try {
      const exe = await unpack(zip, log);
      if (exe) return exe;
    } catch (err) {
      log(`unpacking ${basename(zip)} failed: ${err?.message ?? err}`);
    }
  }
  return 'no usable Electron build could be unpacked';
}

/** `electron.exe` from a build this package unpacked before. */
function findUnpacked() {
  try {
    const dirs = readdirSync(CACHE_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const dir of dirs) {
      const exe = join(CACHE_ROOT, dir.name, 'electron.exe');
      if (existsSync(exe)) return exe;
    }
  } catch { /* no cache yet */ }
  return null;
}

/** Electron zips in the shared download cache, newest name first (v44 before v43). */
function cachedZips() {
  const found = [];
  try {
    for (const dir of readdirSync(ELECTRON_CACHE, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const full = join(ELECTRON_CACHE, dir.name);
      for (const file of readdirSync(full)) {
        if (/^electron-v[\d.]+-win32-x64\.zip$/.test(file)) found.push(join(full, file));
      }
    }
  } catch { return []; }
  return found.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
}

/** Unpacks one zip into the package's own cache and returns the exe inside it. */
async function unpack(zip, log) {
  const name = basename(zip, '.zip');
  const target = join(CACHE_ROOT, name);
  mkdirSync(target, { recursive: true });
  const exe = join(target, 'electron.exe');
  if (existsSync(exe) && statSync(exe).size > 1_000_000) return exe;

  log(`unpacking ${basename(zip)} into ${target} (once)`);
  try {
    await run('tar.exe', ['-xf', zip, '-C', target], { timeout: 240_000, windowsHide: true });
  } catch (err) {
    log(`tar.exe could not read the zip (${err?.message ?? err}); trying Expand-Archive`);
    await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`,
    ], { timeout: 300_000, windowsHide: true });
  }
  return existsSync(exe) ? exe : null;
}
