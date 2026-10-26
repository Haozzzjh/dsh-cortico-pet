/**
 * Host-side owner of the desktop pet window: start it, know whether it is up, stop it.
 *
 * The window is a separate Electron process (`desktop/main.js`). It is deliberately dumb: it loads
 * the pet page from the pet server and reports the mouse and its own visibility. Everything the pet
 * *does* still comes down the pet server's socket, so the desktop window and the in-page overlay are
 * interchangeable — the page cannot tell them apart.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('../desktop/', import.meta.url));

export class DesktopWindow {
  constructor({ electronPath, base, settingsUrl, log = () => {} }) {
    this.electronPath = electronPath;
    this.base = base;
    this.settingsUrl = settingsUrl;
    this.log = log;
    this.child = null;
    this.startedAt = 0;
    this.exitCode = null;
  }

  get running() {
    return this.child !== null && this.child.exitCode === null;
  }

  status() {
    return {
      running: this.running,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt || null,
      exitCode: this.exitCode,
      electron: this.electronPath,
    };
  }

  start() {
    if (this.running) return true;
    const url = `${this.base}/pet?surface=desktop&host=window`;
    this.log(`desktop window: starting ${this.electronPath}`);
    /**
     * The Harness desktop exports `ELECTRON_RUN_AS_NODE=1` for its own subprocess runner; inherited
     * here it would turn Electron into plain Node and the window would die on `require('electron')`.
     * Stripped, along with the injection hooks some Electron builds choke on.
     */
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    delete env.NODE_OPTIONS;
    env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
    this.child = spawn(this.electronPath, [
      APP_DIR,
      `--pet-url=${url}`,
      `--health-url=${this.base}/api/health`,
      `--settings-url=${this.settingsUrl ?? `${this.base}/settings`}`,
    ], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    this.startedAt = Date.now();
    this.exitCode = null;
    this.child.stdout?.on('data', (chunk) => this.log(`[window] ${String(chunk).trim()}`));
    this.child.stderr?.on('data', (chunk) => this.log(`[window!] ${String(chunk).trim()}`));
    this.child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.log(`desktop window exited (code=${code}, signal=${signal ?? 'none'})`);
      this.child = null;
    });
    this.child.on('error', (error) => {
      this.log(`desktop window failed to spawn: ${error.message}`);
      this.child = null;
    });
    return true;
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try { child.kill(); } catch { /* already gone */ }
    // a hung renderer must not keep the window on screen
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* idem */ } }, 1500).unref?.();
  }
}
