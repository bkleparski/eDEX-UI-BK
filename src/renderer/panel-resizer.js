'use strict';

// Shared width-drag controller for the side panels (ASSISTANT and FILES).
// Both panels resize identically — same bounds math, pointer capture,
// keyboard nudge and localStorage persistence — so the behavior lives here
// once and each panel supplies only what actually differs: its storage key,
// CSS variable, DOM elements and whether a hidden panel should ignore
// window resizes.
function createPanelResizer({
  storageKey,
  defaultWidth,
  minWidth,
  terminalMinWidth,
  cssVariable,
  resizingBodyClass,
  datasetWidthKey,
  panel,
  resizer,
  workspace,
  skipResizeWhenHidden = false
}) {
  const state = {
    preferredWidth: null,
    widthStored: false,
    resizePointerId: null,
    resizeStartX: 0,
    resizeStartWidth: defaultWidth
  };

  function readWidth() {
    try {
      const stored = Number.parseFloat(window.localStorage.getItem(storageKey));
      return Number.isFinite(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  function saveWidth(width) {
    try {
      window.localStorage.setItem(storageKey, String(Math.round(width)));
    } catch {
      // Layout persistence is optional when storage is unavailable.
    }
  }

  function widthBounds() {
    const workspaceWidth = workspace.clientWidth;
    const overlayMode = window.matchMedia('(max-width: 1180px)').matches;
    const telemetry = document.getElementById('telemetryPanel');
    const telemetryWidth = !overlayMode && telemetry && getComputedStyle(telemetry).display !== 'none'
      ? telemetry.getBoundingClientRect().width
      : 0;
    const reservedGaps = overlayMode ? 14 : 28;
    const resolvedTerminalMinWidth = overlayMode ? 300 : terminalMinWidth;
    const sharedWidth = workspaceWidth - telemetryWidth - reservedGaps;
    const available = sharedWidth - resolvedTerminalMinWidth;
    const max = Math.max(minWidth, Math.min(720, Math.floor(available)));
    const min = Math.min(minWidth, max);
    const fallback = Math.round(Math.min(max, Math.max(min, sharedWidth / 2)));
    return { min, max, fallback };
  }

  function applyWidth(width, { persist = false } = {}) {
    const bounds = widthBounds();
    const next = Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
    workspace.style.setProperty(cssVariable, `${next}px`);
    resizer.setAttribute('aria-valuemin', String(bounds.min));
    resizer.setAttribute('aria-valuemax', String(bounds.max));
    resizer.setAttribute('aria-valuenow', String(next));
    document.body.dataset[datasetWidthKey] = String(next);
    if (persist) {
      state.preferredWidth = next;
      state.widthStored = true;
      saveWidth(next);
    }
    return next;
  }

  // Preferred width when stored, otherwise the current fallback — used both
  // on window resize and whenever the panel is opened.
  function widthOrFallback() {
    const width = state.widthStored ? state.preferredWidth : widthBounds().fallback;
    if (!state.widthStored) state.preferredWidth = width;
    return width;
  }

  function applyPreferredWidth() {
    applyWidth(widthOrFallback());
  }

  function finishResize(pointerId = null) {
    if (state.resizePointerId === null || (pointerId !== null && pointerId !== state.resizePointerId)) return;
    try {
      if (resizer.hasPointerCapture(state.resizePointerId)) {
        resizer.releasePointerCapture(state.resizePointerId);
      }
    } catch {
      // Synthetic test pointers may not own capture.
    }
    state.resizePointerId = null;
    document.body.classList.remove(resizingBodyClass);
    applyWidth(Number(resizer.getAttribute('aria-valuenow')), { persist: true });
  }

  function initialize() {
    const storedWidth = readWidth();
    state.widthStored = storedWidth !== null;
    state.preferredWidth = storedWidth ?? widthBounds().fallback;
    applyWidth(state.preferredWidth);

    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || state.resizePointerId !== null) return;
      event.preventDefault();
      state.resizePointerId = event.pointerId;
      state.resizeStartX = event.clientX;
      state.resizeStartWidth = panel.getBoundingClientRect().width;
      document.body.classList.add(resizingBodyClass);
      try {
        resizer.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic test pointers may not support capture.
      }
    });

    resizer.addEventListener('pointermove', (event) => {
      if (event.pointerId !== state.resizePointerId) return;
      applyWidth(state.resizeStartWidth + state.resizeStartX - event.clientX);
    });

    resizer.addEventListener('pointerup', (event) => finishResize(event.pointerId));
    resizer.addEventListener('pointercancel', (event) => finishResize(event.pointerId));
    // Belt-and-suspenders: the drag must not get stuck "active" if the
    // pointerup/pointercancel never reaches the resizer itself (e.g. it
    // releases over another element) — listen on the document too.
    document.addEventListener('pointerup', (event) => finishResize(event.pointerId), true);
    document.addEventListener('pointercancel', (event) => finishResize(event.pointerId), true);
    resizer.addEventListener('lostpointercapture', () => finishResize());

    resizer.addEventListener('keydown', (event) => {
      const bounds = widthBounds();
      const current = Number(resizer.getAttribute('aria-valuenow')) || defaultWidth;
      const step = event.shiftKey ? 40 : 16;
      let next = current;
      if (event.key === 'ArrowLeft') next += step;
      else if (event.key === 'ArrowRight') next -= step;
      else if (event.key === 'Home') next = bounds.min;
      else if (event.key === 'End') next = bounds.max;
      else return;
      event.preventDefault();
      applyWidth(next, { persist: true });
    });

    window.addEventListener('resize', () => {
      if (skipResizeWhenHidden && panel.hidden) return;
      applyPreferredWidth();
    });
  }

  return { initialize, applyWidth, applyPreferredWidth };
}
