/**
 * The desktop window: a transparent, always-on-top, click-through Electron window that covers the
 * screen the pet stands on — the same thing Cortico's own pet window is, and the thing a browser
 * overlay can never be (它只在 Harness 窗口里).
 *
 * The page it loads is the very same pet page the in-page overlay loads, served by the plugin's own
 * loopback pet server. So there is no extra protocol: the page talks to the server over its socket,
 * and this process only owns windowing (transparency, topmost, mouse pass-through, the cursor feed
 * that a click-through window cannot read for itself).
 *
 *   electron.exe <this directory> --pet-url=http://127.0.0.1:PORT/pet?surface=desktop
 */
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const { join } = require('node:path');

const arg = (name, fallback = '') => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PET_URL = arg('pet-url');
const HEALTH_URL = arg('health-url');
const SETTINGS_URL = arg('settings-url');
/** How often the cursor is reported to the page (cortico's window process does ~10 a second). */
const CURSOR_MS = 90;
/** A pet server that has been unreachable this many checks means the Host is gone: quit. */
const HEALTH_STRIKES = 3;
const HEALTH_MS = 8000;

if (!PET_URL) {
  console.error('[pet-window] no --pet-url; nothing to show');
  app.exit(2);
}

// One window per machine: a second launch (another Harness profile, a reload) just focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

app.disableHardwareAcceleration = app.disableHardwareAcceleration; // keep the GPU: the whale body is WebGL
app.setAppUserModelId('dsh-cortico-pet-window');

/** The display the pet stands on: the primary one, over its whole work area minus the taskbar. */
let win = null;
let hidden = false;
let cursorTimer = 0;
let healthTimer = 0;
let strikes = 0;
let interactive = false;

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    focusable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // `screen-saver` keeps her above full-screen apps; `floating` is enough for the rest
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => {
    win.showInactive();
    console.log('[pet-window] shown at the desktop work area', area);
  });

  win.on('closed', () => { win = null; });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[pet-window] renderer gone:', details?.reason);
    app.quit();
  });
  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[pet-window] load failed: ${code} ${description}`);
  });

  win.loadURL(PET_URL).catch((error) => console.error('[pet-window] loadURL rejected:', error.message));

  win.webContents.once('did-finish-load', () => {
    if (win) win.webContents.send('pet:shown', !hidden);
    startCursorFeed();
    startHealthWatch();
  });
}

/** Where the cursor is, in window pixels — the page hit-tests the body with this. */
function startCursorFeed() {
  clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || hidden) return;
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    win.webContents.send('pet:cursor', { x: point.x - bounds.x, y: point.y - bounds.y });
  }, CURSOR_MS);
}

/** The Host owns this window's life: when the pet server stops answering, the window goes too. */
function startHealthWatch() {
  if (!HEALTH_URL) return;
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    try {
      const response = await fetch(HEALTH_URL, { cache: 'no-store' });
      if (response.ok) { strikes = 0; return; }
      strikes++;
    } catch {
      strikes++;
    }
    if (strikes >= HEALTH_STRIKES) {
      console.error('[pet-window] pet server unreachable; closing');
      app.quit();
    }
  }, HEALTH_MS);
}

/* ---------- what the page asks of the window ---------- */

ipcMain.on('pet:interactive', (_event, on) => {
  if (!win || win.isDestroyed()) return;
  interactive = !!on;
  // forward:true keeps the window receiving moves while the mouse is passed through, so the pet
  // can notice the cursor coming back (a click-through window gets no pointermove otherwise)
  win.setIgnoreMouseEvents(!interactive, { forward: true });
});

ipcMain.on('pet:hide', () => {
  if (!win || win.isDestroyed()) return;
  hidden = true;
  win.hide();
  if (win.webContents.isDestroyed()) return;
  win.webContents.send('pet:shown', false);
});

ipcMain.on('pet:show', () => {
  if (!win || win.isDestroyed()) return;
  hidden = false;
  win.showInactive();
  win.webContents.send('pet:shown', true);
});

ipcMain.on('pet:focus', () => {
  if (!win || win.isDestroyed()) return;
  win.focus();
});

ipcMain.on('pet:release-focus', () => {
  if (!win || win.isDestroyed()) return;
  win.blur();
});

ipcMain.on('pet:open-settings', () => {
  if (SETTINGS_URL) void shell.openExternal(SETTINGS_URL);
});

ipcMain.on('pet:quit', () => app.quit());

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) win.showInactive();
});

app.whenReady().then(createWindow).catch((error) => {
  console.error('[pet-window] could not create the window:', error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  clearInterval(cursorTimer);
  clearInterval(healthTimer);
});
