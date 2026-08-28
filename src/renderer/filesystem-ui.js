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

  const filesResizer = createPanelResizer({
    storageKey: FILES_WIDTH_KEY,
    defaultWidth: FILES_DEFAULT_WIDTH,
    minWidth: FILES_MIN_WIDTH,
    terminalMinWidth: TERMINAL_MIN_WIDTH,
    cssVariable: '--files-panel-width',
    resizingBodyClass: 'files-resizing',
    datasetWidthKey: 'filesPanelWidth',
    panel: elements.filesPanel,
    resizer: elements.filesResizer,
    workspace: document.querySelector('.workspace'),
    // Unlike the assistant panel, a hidden FILES panel must not reclaim
    // width on a window resize while it's closed.
    skipResizeWhenHidden: true
  });

  function openFilesPanel() {
    if (elements.assistantPanel && !elements.assistantPanel.hidden) {
      document.getElementById('assistantClose')?.click();
    }
    filesResizer.applyPreferredWidth();
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
  filesResizer.initialize();
})();
