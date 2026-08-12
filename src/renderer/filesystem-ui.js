'use strict';

(() => {
  const FILES_WIDTH_KEY = 'edex.files.width.v1';
  const FILES_DEFAULT_WIDTH = 390;
  const FILES_MIN_WIDTH = 300;
  const TERMINAL_MIN_WIDTH = 430;
  const FILE_VIEW_MODE_KEY = 'edex.files.viewMode.v1';
  const VIEW_MODES = ['compact', 'detailed', 'tiles'];

  const filesTestMode = new URLSearchParams(window.location.search).get('test') === 'visual';
  if (filesTestMode) {
    try {
      if (window.sessionStorage.getItem('edex.files.width-test-reset') !== '1') {
        window.localStorage.removeItem(FILES_WIDTH_KEY);
        window.sessionStorage.setItem('edex.files.width-test-reset', '1');
      }
    } catch {
      // The visual test will report unavailable storage through its assertions.
    }
  }

  const elements = Object.fromEntries([
    'filesGroupToggle', 'filesGroupState', 'filesPanel', 'filesClose', 'filesResizer',
    'assistantPanel', 'fileList', 'fileListColumns', 'fileViewSwitch'
  ].map((id) => [id, document.getElementById(id)]));

  if (!elements.filesPanel || !elements.filesResizer) return;

  const state = {
    filesPreferredWidth: null,
    filesWidthStored: false,
    resizePointerId: null,
    resizeStartX: 0,
    resizeStartWidth: FILES_DEFAULT_WIDTH
  };

  const workspace = document.querySelector('.workspace');

  function readFilesWidth() {
    try {
      const stored = Number.parseFloat(window.localStorage.getItem(FILES_WIDTH_KEY));
      return Number.isFinite(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  function saveFilesWidth(width) {
    try {
      window.localStorage.setItem(FILES_WIDTH_KEY, String(Math.round(width)));
    } catch {
      // Layout persistence is optional when storage is unavailable.
    }
  }

  function filesWidthBounds() {
    const workspaceWidth = workspace.clientWidth;
    const overlayMode = window.matchMedia('(max-width: 1180px)').matches;
    const telemetry = document.getElementById('telemetryPanel');
    const telemetryWidth = !overlayMode && telemetry && getComputedStyle(telemetry).display !== 'none'
      ? telemetry.getBoundingClientRect().width
      : 0;
    const reservedGaps = overlayMode ? 14 : 28;
    const terminalMinWidth = overlayMode ? 300 : TERMINAL_MIN_WIDTH;
    const sharedWidth = workspaceWidth - telemetryWidth - reservedGaps;
    const available = sharedWidth - terminalMinWidth;
    const max = Math.max(FILES_MIN_WIDTH, Math.min(720, Math.floor(available)));
    const min = Math.min(FILES_MIN_WIDTH, max);
    const fallback = Math.round(Math.min(max, Math.max(min, sharedWidth / 2)));
    return { min, max, fallback };
  }

  function applyFilesWidth(width, { persist = false } = {}) {
    const bounds = filesWidthBounds();
    const next = Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
    workspace.style.setProperty('--files-panel-width', `${next}px`);
    elements.filesResizer.setAttribute('aria-valuemin', String(bounds.min));
    elements.filesResizer.setAttribute('aria-valuemax', String(bounds.max));
    elements.filesResizer.setAttribute('aria-valuenow', String(next));
    document.body.dataset.filesPanelWidth = String(next);
    if (persist) {
      state.filesPreferredWidth = next;
      state.filesWidthStored = true;
      saveFilesWidth(next);
    }
    return next;
  }

  function finishFilesResize(pointerId = null) {
    if (state.resizePointerId === null || (pointerId !== null && pointerId !== state.resizePointerId)) return;
    try {
      if (elements.filesResizer.hasPointerCapture(state.resizePointerId)) {
        elements.filesResizer.releasePointerCapture(state.resizePointerId);
      }
    } catch {
      // Synthetic test pointers may not own capture.
    }
    state.resizePointerId = null;
    document.body.classList.remove('files-resizing');
    applyFilesWidth(Number(elements.filesResizer.getAttribute('aria-valuenow')), { persist: true });
  }

  function initializeFilesResizer() {
    const storedWidth = readFilesWidth();
    state.filesWidthStored = storedWidth !== null;
    state.filesPreferredWidth = storedWidth ?? filesWidthBounds().fallback;
    applyFilesWidth(state.filesPreferredWidth);

    elements.filesResizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || state.resizePointerId !== null) return;
      event.preventDefault();
      state.resizePointerId = event.pointerId;
      state.resizeStartX = event.clientX;
      state.resizeStartWidth = elements.filesPanel.getBoundingClientRect().width;
      document.body.classList.add('files-resizing');
      try {
        elements.filesResizer.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic test pointers may not support capture.
      }
    });

    elements.filesResizer.addEventListener('pointermove', (event) => {
      if (event.pointerId !== state.resizePointerId) return;
      applyFilesWidth(state.resizeStartWidth + state.resizeStartX - event.clientX);
    });

    elements.filesResizer.addEventListener('pointerup', (event) => finishFilesResize(event.pointerId));
    elements.filesResizer.addEventListener('pointercancel', (event) => finishFilesResize(event.pointerId));
    document.addEventListener('pointerup', (event) => finishFilesResize(event.pointerId), true);
    document.addEventListener('pointercancel', (event) => finishFilesResize(event.pointerId), true);
    elements.filesResizer.addEventListener('lostpointercapture', () => finishFilesResize());

    elements.filesResizer.addEventListener('keydown', (event) => {
      const bounds = filesWidthBounds();
      const current = Number(elements.filesResizer.getAttribute('aria-valuenow')) || FILES_DEFAULT_WIDTH;
      const step = event.shiftKey ? 40 : 16;
      let next = current;
      if (event.key === 'ArrowLeft') next += step;
      else if (event.key === 'ArrowRight') next -= step;
      else if (event.key === 'Home') next = bounds.min;
      else if (event.key === 'End') next = bounds.max;
      else return;
      event.preventDefault();
      applyFilesWidth(next, { persist: true });
    });

    window.addEventListener('resize', () => {
      if (elements.filesPanel.hidden) return;
      const width = state.filesWidthStored ? state.filesPreferredWidth : filesWidthBounds().fallback;
      if (!state.filesWidthStored) state.filesPreferredWidth = width;
      applyFilesWidth(width);
    });
  }

  function openFilesPanel() {
    if (elements.assistantPanel && !elements.assistantPanel.hidden) {
      document.getElementById('assistantClose')?.click();
    }
    const width = state.filesWidthStored ? state.filesPreferredWidth : filesWidthBounds().fallback;
    if (!state.filesWidthStored) state.filesPreferredWidth = width;
    applyFilesWidth(width);
    elements.filesPanel.hidden = false;
    elements.filesGroupToggle.setAttribute('aria-expanded', 'true');
    elements.filesGroupToggle.setAttribute('aria-pressed', 'true');
    elements.filesGroupToggle.classList.add('is-on');
    elements.filesGroupState.textContent = 'ON';
    document.body.dataset.filesPanelOpen = 'true';
    document.body.dataset.filesToggleCount = String((Number(document.body.dataset.filesToggleCount) || 0) + 1);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    window.refreshFileBrowser?.();
  }

  function closeFilesPanel() {
    if (elements.filesPanel.hidden) return;
    elements.filesPanel.hidden = true;
    elements.filesGroupToggle.setAttribute('aria-expanded', 'false');
    elements.filesGroupToggle.setAttribute('aria-pressed', 'false');
    elements.filesGroupToggle.classList.remove('is-on');
    elements.filesGroupState.textContent = 'OFF';
    document.body.dataset.filesPanelOpen = 'false';
    document.body.dataset.filesToggleCount = String((Number(document.body.dataset.filesToggleCount) || 0) + 1);
    window.dispatchEvent(new Event('resize'));
  }

  function toggleFilesPanel() {
    if (elements.filesPanel.hidden) openFilesPanel(); else closeFilesPanel();
  }

  elements.filesGroupToggle.addEventListener('click', toggleFilesPanel);
  elements.filesClose?.addEventListener('click', closeFilesPanel);

  if (elements.assistantPanel) {
    new MutationObserver(() => {
      if (!elements.assistantPanel.hidden && !elements.filesPanel.hidden) closeFilesPanel();
    }).observe(elements.assistantPanel, { attributes: true, attributeFilter: ['hidden'] });
  }

  function readViewMode() {
    try {
      const stored = window.localStorage.getItem(FILE_VIEW_MODE_KEY);
      return VIEW_MODES.includes(stored) ? stored : 'compact';
    } catch {
      return 'compact';
    }
  }

  function applyViewMode(mode) {
    const nextMode = VIEW_MODES.includes(mode) ? mode : 'compact';
    document.body.dataset.fileViewMode = nextMode;
    for (const button of elements.fileViewSwitch.querySelectorAll('[data-view-mode]')) {
      const isOn = button.dataset.viewMode === nextMode;
      button.classList.toggle('is-on', isOn);
      button.setAttribute('aria-pressed', String(isOn));
    }
    try {
      window.localStorage.setItem(FILE_VIEW_MODE_KEY, nextMode);
    } catch {
      // View mode persistence is optional when storage is unavailable.
    }
    window.renderCurrentFileBrowserResult?.();
  }

  if (elements.fileViewSwitch) {
    for (const button of elements.fileViewSwitch.querySelectorAll('[data-view-mode]')) {
      button.addEventListener('click', () => applyViewMode(button.dataset.viewMode));
    }
  }

  applyViewMode(readViewMode());
  initializeFilesResizer();
})();
