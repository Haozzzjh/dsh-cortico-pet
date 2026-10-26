/**
 * `window.petHost` for the desktop window — the same contract `web/dsh-pet-host.js` fakes inside the
 * browser overlay, backed by the real thing: a transparent topmost window that can genuinely ignore
 * the mouse (Window's `setIgnoreMouseEvents`), a cursor the window process reports itself, and a
 * window it can actually hide.
 *
 * Kept in sync with `web/dsh-pet-host.js`: the pet page calls exactly these members, and anything
 * left undefined is a capability the page then stops asking for.
 */
const { contextBridge, ipcRenderer } = require('electron');

let cursorListener = null;
let shownListener = null;

ipcRenderer.on('pet:cursor', (_event, point) => {
  if (cursorListener) cursorListener(point ?? null);
});
ipcRenderer.on('pet:shown', (_event, shown) => {
  if (shownListener) shownListener(!!shown);
});

contextBridge.exposeInMainWorld('petHost', {
  /** This is the desk, not a preview: transparent page, no wall, no floor icons. */
  desk: true,
  onCursor(listener) { cursorListener = listener; },
  onShown(listener) {
    shownListener = listener;
    try { listener(true); } catch { /* page not ready */ }
  },
  /** The window's bottom edge is the work area's bottom, so there is no gap to report. */
  onFloor(listener) { try { listener(0); } catch { /* page not ready */ } },
  onWindows() { /* the Harness never asked for the desktop's window tops */ },
  onOverlay(listener) { try { listener(false); } catch { /* page not ready */ } },
  watchWindows() {},
  setLanguage() {},
  setInteractive(on) { ipcRenderer.send('pet:interactive', !!on); },
  focus() { ipcRenderer.send('pet:focus'); },
  grabFocus() { ipcRenderer.send('pet:focus'); },
  releaseFocus() { ipcRenderer.send('pet:release-focus'); },
  hide() { ipcRenderer.send('pet:hide'); },
  show() { ipcRenderer.send('pet:show'); },
  hideWhenFullscreen() {},
  openDress() { ipcRenderer.send('pet:open-settings'); },
  quit() { ipcRenderer.send('pet:quit'); },
});
