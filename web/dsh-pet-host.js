/**
 * The `petHost` shim — a stand-in for the Electron preload that `cortico-world-desktop-pet`'s page
 * normally gets from `host/preload.cjs`.
 *
 * The pet page decides for itself when it wants the mouse: it hit-tests the body and its bubbles
 * and calls `host.setInteractive(on)`. In Electron that toggles a click-through window. Here the
 * page lives in an iframe that covers the Harness window, so the same call is forwarded to the
 * parent, which flips `pointer-events` — the pet stays click-through everywhere except over
 * herself, exactly like the desktop original.
 *
 * The parent also feeds back where the cursor is (the Electron window process reports that on a
 * timer; a click-through frame cannot read the pointer itself), and how much room the floor has.
 */
(() => {
  const parent = window.parent !== window ? window.parent : null;
  const post = (msg) => { try { parent?.postMessage({ __dshPet: true, ...msg }, '*'); } catch { /* parent gone */ } };

  const onCursor = [];
  const onShown = [];
  const onFloor = [];
  const onWindows = [];
  const onOverlay = [];
  let floorPx = 88;
  let shown = true;

  addEventListener('message', (e) => {
    const data = e.data;
    if (!data || data.__dshPet !== true) return;
    switch (data.kind) {
      case 'cursor':
        for (const cb of onCursor) { try { cb(data.at ? { x: Number(data.x) || 0, y: Number(data.y) || 0 } : null); } catch { /* one bad listener */ } }
        return;
      case 'shown':
        shown = !!data.shown;
        for (const cb of onShown) { try { cb(shown); } catch { /* one bad listener */ } }
        return;
      case 'floor':
        if (Number.isFinite(data.px)) {
          floorPx = Number(data.px);
          for (const cb of onFloor) { try { cb(floorPx); } catch { /* one bad listener */ } }
        }
        return;
      case 'windows':
        for (const cb of onWindows) { try { cb(Array.isArray(data.list) ? data.list : null); } catch { /* one bad listener */ } }
        return;
      case 'overlay':
        for (const cb of onOverlay) { try { cb(!!data.on); } catch { /* one bad listener */ } }
        return;
      default:
        return;
    }
  });

  window.petHost = {
    /** This is the desk, not the settings preview: no wall, no floor icons, transparent page. */
    desk: true,
    onCursor(cb) { onCursor.push(cb); },
    onShown(cb) { onShown.push(cb); try { cb(shown); } catch { /* ignore */ } },
    onFloor(cb) { onFloor.push(cb); try { cb(floorPx); } catch { /* ignore */ } },
    onWindows(cb) { onWindows.push(cb); },
    onOverlay(cb) { onOverlay.push(cb); },
    watchWindows() { /* the Harness has no other windows to read */ },
    setLanguage() { /* the page's own text table already speaks the Harness language */ },
    setInteractive(on) { post({ kind: 'interactive', on: !!on }); },
    focus() { /* the frame is always focusable */ },
    grabFocus() { /* no keyboard lease to take: the numbering keys are handled in the page */ },
    releaseFocus() { /* see grabFocus */ },
    hide() { post({ kind: 'hide' }); },
    hideWhenFullscreen() { /* the whole Harness window is the stage here */ },
    openDress() { post({ kind: 'open-dress' }); },
    /** No backdrop sampling, so the page keeps a fixed halo instead of a per-frame one. */
  };

  post({ kind: 'ready', floor: floorPx });
})();
