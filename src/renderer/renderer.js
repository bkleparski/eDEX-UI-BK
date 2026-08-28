'use strict';

const storageKeys = Object.freeze({
  skipBoot: 'edex-ui-bk.skipBoot',
  scanlines: 'edex-ui-bk.scanlines',
  sound: 'edex-ui-bk.sound'
});

const terminalTheme = Object.freeze({
  background: '#02080a',
  foreground: '#00e5ff',
  cursor: '#8ff8ff',
  cursorAccent: '#02080a',
  selectionBackground: 'rgba(0, 229, 255, 0.25)',
  black: '#02080a',
  red: '#ff5f56',
  green: '#00e5a0',
  yellow: '#ff9f1c',
  blue: '#00b8d9',
  magenta: '#d580ff',
  cyan: '#00e5ff',
  white: '#d8f9ff',
  brightBlack: '#087f9c',
  brightRed: '#ff8a80',
  brightGreen: '#8ff8ff',
  brightYellow: '#ffc46b',
  brightBlue: '#8ff8ff',
  brightMagenta: '#eab8ff',
  brightCyan: '#8ff8ff',
  brightWhite: '#ffffff'
});

const testMode = new URLSearchParams(window.location.search).get('test');
const isSmokeTest = testMode === 'smoke';
const isVisualTest = testMode === 'visual';
const smokeMarker = '__EDEX_PTY_ARM64_OK__';
const dropTestMarker = "__EDEX_DROP_OK__</tmp/eDEX drag one.txt></tmp/O'Brien [v2].log>";
const panelDropTestMarker = "__EDEX_PANEL_DROP_OK__</private/tmp/edex-ui-bk-phase13-browser/O'Brien phase 11.txt>";
const dropTestMime = 'application/x-edex-ui-bk-test-paths';
const internalFilePathMime = 'application/x-edex-ui-bk-file-path';

const maxTerminalSessions = 8;
// One entry per pty: a session is a *pane*, not a tab. Tabs own a layout tree
// of panes, so several sessions can be visible side by side at once.
const terminalSessions = new Map();
const terminalTabs = new Map();
let activeSessionId = null;
let activeTabId = null;
let nextSessionNumber = 1;
let nextTabNumber = 1;
let bootTimer;
let bootActive = false;
let smokeOutput = '';
let smokeCompleted = false;
let audioContext = null;
let soundEnabled = false;
let fileDragDepth = 0;
let dropTestOutput = '';
let rendererShuttingDown = false;

// xterm.js paints to a canvas, so the appearance chosen in SETTINGS reaches it
// through terminal options rather than CSS custom properties.
function themedTerminalPalette(appearance = {}) {
  const foreground = appearance.foreground || terminalTheme.foreground;
  const cursor = appearance.cursor || terminalTheme.cursor;
  return {
    ...terminalTheme,
    foreground,
    cursor,
    cursorAccent: terminalTheme.background,
    selectionBackground: `${foreground}40`
  };
}

function applyTerminalAppearance(appearance = window.themeApi?.appearance()) {
  if (!appearance) return;
  const palette = themedTerminalPalette(appearance);
  for (const session of terminalSessions.values()) {
    session.terminal.options.theme = palette;
    session.terminal.options.fontFamily = appearance.fontFamily;
    session.terminal.options.fontSize = appearance.fontSize;
    if (appearance.scrollback) session.terminal.options.scrollback = appearance.scrollback;
    // Cached glyph bitmaps are keyed by (char, colors), so a new accent or
    // font would otherwise keep painting from the stale atlas until enough
    // cache churn evicts it — clear it explicitly so the switch is instant.
    session.webglAddon?.clearTextureAtlas();
  }
  fitActiveTerminal();
}

function readSetting(key) {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeSetting(key, enabled) {
  try {
    window.localStorage.setItem(key, enabled ? '1' : '0');
  } catch {
    // The interface remains functional if storage is unavailable.
  }
}

function ensureAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext = new AudioContextClass();
  }
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

function playInputSound(data) {
  if (!soundEnabled || typeof data !== 'string' || data.length === 0) return;
  const context = ensureAudioContext();
  if (!context || context.state === 'closed') return;

  const enter = data === '\r' || data === '\n';
  const now = context.currentTime;
  const duration = enter ? 0.07 : 0.03 + Math.random() * 0.02;
  const baseFrequency = enter ? 1_200 : 2_100 * (0.95 + Math.random() * 0.1);
  const attack = enter ? 0.003 : 0.0025;
  const volume = enter ? 0.07 : 0.05 + Math.random() * 0.02;
  const main = context.createOscillator();
  const harmonic = context.createOscillator();
  const mainGain = context.createGain();
  const harmonicGain = context.createGain();

  main.type = enter ? 'sine' : 'triangle';
  harmonic.type = 'sine';
  main.frequency.setValueAtTime(baseFrequency, now);
  harmonic.frequency.setValueAtTime(baseFrequency * 2, now);
  mainGain.gain.setValueAtTime(0.0001, now);
  mainGain.gain.exponentialRampToValueAtTime(volume, now + attack);
  mainGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  harmonicGain.gain.setValueAtTime(0.0001, now);
  harmonicGain.gain.exponentialRampToValueAtTime(volume * 0.25, now + attack);
  harmonicGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  main.connect(mainGain).connect(context.destination);
  harmonic.connect(harmonicGain).connect(context.destination);
  main.start(now);
  harmonic.start(now);
  main.stop(now + duration + 0.01);
  harmonic.stop(now + duration + 0.01);
}

// A two-note rising chime — distinct from the keystroke clicks so it reads
// as "something finished", not more typing noise.
function playCommandCompleteSound() {
  if (!soundEnabled) return;
  const context = ensureAudioContext();
  if (!context || context.state === 'closed') return;
  const now = context.currentTime;
  [[880, 0], [1_320, 0.09]].forEach(([frequency, delay]) => {
    const start = now + delay;
    const duration = 0.16;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.09, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  });
}

function updateSound(enabled, activateAudio = true) {
  soundEnabled = enabled;
  document.body.dataset.soundToggleCount = String((Number(document.body.dataset.soundToggleCount) || 0) + 1);
  document.body.dataset.soundEnabled = String(enabled);
  document.getElementById('soundState').textContent = enabled ? 'ON' : 'OFF';
  const toggle = document.getElementById('soundToggle');
  toggle.setAttribute('aria-pressed', String(enabled));
  toggle.classList.toggle('is-on', enabled);
  writeSetting(storageKeys.sound, enabled);
  if (enabled && activateAudio) ensureAudioContext();
}

function toggleSound() {
  updateSound(!soundEnabled);
  focusTerminal();
}

function initializeAudio() {
  soundEnabled = readSetting(storageKeys.sound);
  const unlock = () => {
    if (soundEnabled) ensureAudioContext();
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
  };
  document.addEventListener('pointerdown', unlock, { capture: true, once: true });
  document.addEventListener('keydown', unlock, { capture: true, once: true });
  window.addEventListener('beforeunload', () => {
    if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {});
  }, { once: true });
}

let terminalFitFrame = null;
let terminalFocusRequested = false;

function tabSessions(tabId) {
  const tab = terminalTabs.get(tabId);
  if (!tab) return [];
  return [...tab.view.querySelectorAll('.terminal-instance')]
    .map((container) => terminalSessions.get(container.dataset.sessionId))
    .filter(Boolean);
}

function visibleSessions() {
  return tabSessions(activeTabId);
}

// Every pane reflows on its own: one observer covers splits, splitter drags
// and window resizes without a separate code path for each.
const paneResizeObserver = new ResizeObserver(() => fitActiveTerminal());

function fitSession(session) {
  if (!session || !session.container.isConnected || session.container.offsetParent === null) return;
  try {
    session.fitAddon.fit();
  } catch (error) {
    console.warn('Terminal fit failed:', error);
  }
}

function fitActiveTerminal({ focus = false } = {}) {
  terminalFocusRequested = terminalFocusRequested || focus;
  if (terminalFitFrame !== null) return;
  terminalFitFrame = requestAnimationFrame(() => {
    terminalFitFrame = null;
    const shouldFocus = terminalFocusRequested;
    terminalFocusRequested = false;
    for (const session of visibleSessions()) fitSession(session);
    const session = terminalSessions.get(activeSessionId);
    if (shouldFocus && session) session.terminal.focus();
    if (!document.getElementById('terminalSearchBar').hidden) positionTerminalSearchBar();
  });
}

function focusTerminal() {
  const session = terminalSessions.get(activeSessionId);
  if (session) fitActiveTerminal({ focus: true });
}

// Text-entry surfaces outside the terminal (TTY rename, file rename, theme
// inputs) must keep plain typing — ⌘F there should not hijack focus into
// terminal search. The terminal's own hidden textarea is the one exception.
function isTypingInForeignInput() {
  const element = document.activeElement;
  if (!element || element.classList?.contains('xterm-helper-textarea')) return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable;
}

function hasFileDrag(dataTransfer) {
  const types = Array.from(dataTransfer?.types || []);
  return types.includes('Files') || types.includes(internalFilePathMime)
    || (document.body.classList.contains('file-browser-dragging') && types.includes('text/plain'))
    || (isVisualTest && types.includes(dropTestMime));
}

function quoteShellPath(filePath) {
  return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

function droppedFilePaths(dataTransfer) {
  if (isVisualTest && Array.from(dataTransfer?.types || []).includes(dropTestMime)) {
    try {
      const testPaths = JSON.parse(dataTransfer.getData(dropTestMime));
      return Array.isArray(testPaths) ? testPaths.filter((item) => typeof item === 'string' && item.length > 0) : [];
    } catch {
      return [];
    }
  }

  const types = Array.from(dataTransfer?.types || []);
  if (types.includes(internalFilePathMime)
    || (document.body.classList.contains('file-browser-dragging') && types.includes('text/plain'))) {
    const payload = dataTransfer.getData(internalFilePathMime) || dataTransfer.getData('text/plain');
    // A multi-selection drag carries one path per line.
    return typeof payload === 'string'
      ? payload.split('\n').map((item) => item.trim()).filter(Boolean)
      : [];
  }

  return Array.from(dataTransfer?.files || []).flatMap((file) => {
    try {
      const filePath = window.filesApi.getPathForFile(file);
      return typeof filePath === 'string' && filePath.length > 0 ? [filePath] : [];
    } catch {
      return [];
    }
  });
}

function setFileDropTarget(active) {
  document.querySelector('.terminal-panel').classList.toggle('is-file-drop-target', active);
  if (active) document.body.dataset.dropTargetObserved = 'true';
}

function clearFileDropTarget() {
  fileDragDepth = 0;
  setFileDropTarget(false);
  document.body.dataset.dropIndicatorCleared = 'true';
  document.body.classList.remove('file-browser-dragging');
  document.querySelectorAll('.file-row.is-dragging').forEach((row) => row.classList.remove('is-dragging'));
}

function insertDroppedPaths(paths, source = 'external') {
  const session = terminalSessions.get(activeSessionId);
  if (!session?.online || paths.length === 0) return false;
  const payload = `${paths.map(quoteShellPath).join(' ')} `;
  window.terminalApi.write(activeSessionId, payload);
  const datasetPrefix = source === 'browser' ? 'panelDrop' : 'drop';
  document.body.dataset[`${datasetPrefix}PathCount`] = String(paths.length);
  document.body.dataset[`${datasetPrefix}SessionId`] = activeSessionId;
  document.body.dataset[`${datasetPrefix}QuotedPayload`] = payload;
  session.terminal.focus();
  return true;
}

function initializeFileDrop() {
  const target = document.querySelector('.terminal-surface');
  document.body.dataset.dropPathApiSupported = String(window.filesApi.pathForDropSupported === true);

  target.addEventListener('dragenter', (event) => {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    fileDragDepth += 1;
    setFileDropTarget(true);
  });

  target.addEventListener('dragover', (event) => {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setFileDropTarget(true);
  });

  target.addEventListener('dragleave', () => {
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0) setFileDropTarget(false);
  });

  target.addEventListener('drop', (event) => {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const transferTypes = Array.from(event.dataTransfer?.types || []);
    const fromFileBrowser = transferTypes.includes(internalFilePathMime)
      || (document.body.classList.contains('file-browser-dragging') && transferTypes.includes('text/plain'));
    const paths = droppedFilePaths(event.dataTransfer);
    clearFileDropTarget();
    insertDroppedPaths(paths, fromFileBrowser ? 'browser' : 'external');
  });

  document.addEventListener('dragend', clearFileDropTarget);
  window.addEventListener('blur', clearFileDropTarget);
}

function removeBootListeners() {
  document.removeEventListener('keydown', handleBootInput, true);
  document.getElementById('bootOverlay').removeEventListener('click', handleBootClick);
}

function finishBoot() {
  if (!bootActive) return;
  bootActive = false;
  clearTimeout(bootTimer);
  removeBootListeners();
  document.body.classList.remove('booting');
  document.body.classList.add('boot-complete');
  document.getElementById('bootOverlay').hidden = true;
  focusTerminal();
}

function handleBootInput(event) {
  if (!bootActive) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishBoot();
}

function handleBootClick(event) {
  if (event.target.closest('#skipBootAlways')) {
    writeSetting(storageKeys.skipBoot, true);
  }
  finishBoot();
}

function initializeBoot() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (isSmokeTest || reduceMotion || readSetting(storageKeys.skipBoot)) {
    document.body.classList.remove('booting');
    document.body.classList.add('boot-complete');
    document.getElementById('bootOverlay').hidden = true;
    return;
  }

  bootActive = true;
  document.addEventListener('keydown', handleBootInput, true);
  document.getElementById('bootOverlay').addEventListener('click', handleBootClick);
  bootTimer = setTimeout(finishBoot, 1_450);
}

function updateScanlines(enabled) {
  document.body.dataset.scanlinesToggleCount = String((Number(document.body.dataset.scanlinesToggleCount) || 0) + 1);
  document.body.classList.toggle('scanlines-on', enabled);
  document.getElementById('scanlinesState').textContent = enabled ? 'ON' : 'OFF';
  const toggle = document.getElementById('scanlinesToggle');
  toggle.setAttribute('aria-pressed', String(enabled));
  toggle.classList.toggle('is-on', enabled);
  writeSetting(storageKeys.scanlines, enabled);
}

function toggleScanlines() {
  updateScanlines(!document.body.classList.contains('scanlines-on'));
  focusTerminal();
}

function recordSystemVisibilityState(visible) {
  document.body.dataset.dataVisibilityState = visible ? 'system-visible' : 'system-hidden';
  if (!isVisualTest) return;

  const visited = new Set((document.body.dataset.dataVisibilityStates || '').split(',').filter(Boolean));
  visited.add(document.body.dataset.dataVisibilityState);
  document.body.dataset.dataVisibilityStates = [...visited].join(',');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const samples = JSON.parse(document.body.dataset.dataVisibilityGeometry || '{}');
    samples[document.body.dataset.dataVisibilityState] = {
      panelVisible: getComputedStyle(document.getElementById('telemetryPanel')).display !== 'none',
      systemVisible: getComputedStyle(document.getElementById('systemGroup')).display !== 'none',
      terminalWidth: document.querySelector('.terminal-panel').getBoundingClientRect().width,
      terminalScreenWidth: document.querySelector('.terminal-tab-view:not([hidden]) .terminal-instance.is-active-pane .xterm-screen')?.getBoundingClientRect().width || 0,
      visibleProcessCount: [...document.querySelectorAll('#processList .process-row')]
        .filter((row) => row.getClientRects().length > 0).length
    };
    document.body.dataset.dataVisibilityGeometry = JSON.stringify(samples);
  }));
}

function setSystemGroupVisible(visible) {
  document.body.classList.toggle('system-group-hidden', !visible);
  document.body.classList.toggle('telemetry-panel-hidden', !visible);
  const button = document.getElementById('systemGroupToggle');
  const state = document.getElementById('systemGroupState');
  button.classList.toggle('is-on', visible);
  button.setAttribute('aria-pressed', String(visible));
  state.textContent = visible ? 'ON' : 'OFF';
  document.body.dataset.systemToggleCount = String((Number(document.body.dataset.systemToggleCount) || 0) + 1);
  recordSystemVisibilityState(visible);
  // Showing the telemetry column shrinks the space the side panels may occupy,
  // so let their resizers re-clamp a stored width that no longer fits.
  window.dispatchEvent(new Event('resize'));
  focusTerminal();
}

function toggleSystemGroup() {
  setSystemGroupVisible(document.body.classList.contains('system-group-hidden'));
}

function initializeControls() {
  updateScanlines(readSetting(storageKeys.scanlines));
  updateSound(soundEnabled, false);
  document.getElementById('scanlinesToggle').addEventListener('click', toggleScanlines);
  document.getElementById('soundToggle').addEventListener('click', toggleSound);
  document.getElementById('systemGroupToggle').addEventListener('click', toggleSystemGroup);
  initializeProcessSort();
  initializeTerminalSearch();
  initializePasteWarning();
  recordSystemVisibilityState(!document.body.classList.contains('system-group-hidden'));
  updateClock();
  const clockTimer = setInterval(updateClock, 1_000);
  window.addEventListener('beforeunload', () => clearInterval(clockTimer), { once: true });

  document.addEventListener('keydown', handleFileBrowserKeydown, true);

  document.addEventListener('keydown', (event) => {
    if (bootActive || !event.metaKey || event.ctrlKey) return;
    // ⌥⌘arrows walk the pane grid of the current tab.
    if (event.altKey) {
      const direction = {
        ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down'
      }[event.code];
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      // Hidden panes report zero-size rects, which breaks the geometric
      // scoring below — leave zoom before it runs, not after.
      if (getZoomedSessionId()) exitPaneZoom();
      focusPaneInDirection(direction);
      return;
    }
    // ⇧⌘⏎ toggles a temporary full-pane zoom, iTerm2-style.
    if (event.shiftKey && (event.code === 'Enter' || event.code === 'NumpadEnter')) {
      event.preventDefault();
      event.stopPropagation();
      toggleActivePaneZoom();
      return;
    }
    // ⌘F is FILES' filter shortcut while that panel has real focus (handled in
    // capture phase by handleFileBrowserKeydown, which stops propagation before
    // this runs); anywhere else — and by far the common case, since the
    // terminal keeps DOM focus even while the FILES panel sits open beside it
    // — ⌘F opens terminal search instead, like iTerm2.
    if (event.code === 'KeyF' && !event.shiftKey) {
      if (isTypingInForeignInput()) return;
      event.preventDefault();
      event.stopPropagation();
      openTerminalSearch();
      return;
    }
    // ⌘K clears the active pane's scrollback, like iTerm2.
    if (event.code === 'KeyK' && !event.shiftKey) {
      if (isTypingInForeignInput()) return;
      event.preventDefault();
      event.stopPropagation();
      terminalSessions.get(activeSessionId)?.terminal.clear();
      return;
    }
    // ⌘D splits side by side, ⇧⌘D stacks — same orientation as iTerm2.
    if (event.code === 'KeyD') {
      event.preventDefault();
      event.stopPropagation();
      splitActivePane(event.shiftKey ? 'column' : 'row')
        .catch((error) => console.error('Pane split failed:', error));
      return;
    }
    if (event.shiftKey && event.code === 'KeyW') {
      event.preventDefault();
      event.stopPropagation();
      closeActivePane();
      return;
    }
    if (event.shiftKey && event.code === 'KeyL') {
      event.preventDefault();
      event.stopPropagation();
      toggleScanlines();
      return;
    }
    if (event.shiftKey && event.code === 'KeyS') {
      event.preventDefault();
      event.stopPropagation();
      toggleSound();
      return;
    }
    if (event.shiftKey && event.code === 'Period'
      && !document.getElementById('filesPanel').hidden) {
      event.preventDefault();
      event.stopPropagation();
      toggleDotfiles();
      return;
    }
    if (event.shiftKey) return;
    if (event.code === 'Digit1') {
      event.preventDefault();
      event.stopPropagation();
      toggleSystemGroup();
    } else if (event.code === 'Digit2') {
      event.preventDefault();
      event.stopPropagation();
      document.getElementById('filesGroupToggle').click();
    } else if (event.code === 'Digit3') {
      event.preventDefault();
      event.stopPropagation();
      document.getElementById('assistantToggle').click();
    } else if (event.code === 'KeyT') {
      event.preventDefault();
      event.stopPropagation();
      if (terminalSessions.size > 0) createTerminalSession();
    }
  }, true);
}

function updateShellStatus() {
  const session = terminalSessions.get(activeSessionId);
  const status = document.getElementById('shellStatus');
  const label = document.getElementById('shellStatusText');
  if (!session) {
    status.dataset.state = 'offline';
    label.textContent = 'LINK OFFLINE';
  } else if (session.online) {
    status.dataset.state = 'online';
    label.textContent = 'LINK ONLINE';
  } else {
    status.dataset.state = session.failed ? 'offline' : 'starting';
    label.textContent = session.failed ? 'LINK FAILED' : 'LINK STARTING';
  }
}

function switchTerminalSession(sessionId) {
  const nextSession = terminalSessions.get(sessionId);
  if (!nextSession) return;
  const sessionChanged = sessionId !== activeSessionId;
  const resumedFromBrowsing = sessionChanged && getFileBrowserMode() === 'browsing';
  const currentSearchSessionId = getTerminalSearchSessionId();
  if (sessionChanged && currentSearchSessionId && currentSearchSessionId !== sessionId) {
    closeTerminalSearch({ refocusTerminal: false });
  }
  if (sessionChanged && getZoomedSessionId()) exitPaneZoom();
  nextSession.completedCommandBadge = false;
  activeSessionId = sessionId;
  activeTabId = nextSession.tabId;
  const activeTab = terminalTabs.get(activeTabId);
  if (activeTab) activeTab.activePaneId = sessionId;
  if (sessionChanged) resumeLiveFileBrowser({ refresh: false });
  if (resumedFromBrowsing) document.body.dataset.fileBrowserTabResumeObserved = 'true';
  for (const [tabId, tab] of terminalTabs) {
    const active = tabId === activeTabId;
    tab.view.hidden = !active;
    tab.button.classList.toggle('is-active', active);
    tab.button.setAttribute('aria-selected', String(active));
    tab.button.tabIndex = active ? 0 : -1;
    renderTabLabel(tabId);
  }
  for (const session of terminalSessions.values()) {
    session.container.classList.toggle('is-active-pane', session.id === sessionId);
  }
  document.body.dataset.activePaneId = sessionId;
  window.terminalApi.setActive(sessionId);
  updateShellStatus();
  refreshFileBrowser();
  focusTerminal();
}

function handleTerminalExit(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  const tabId = session.tabId;
  const tabOrder = [...terminalTabs.keys()];
  const tabIndex = tabOrder.indexOf(tabId);
  const paneOrder = tabSessions(tabId);
  const paneIndex = paneOrder.indexOf(session);
  const wasActive = sessionId === activeSessionId;

  if (getTtyContextSessionId() === sessionId) hideTTYContextMenu();
  if (getTtyRenameSessionId() === sessionId) hideTTYRename();
  if (getTerminalSearchSessionId() === sessionId) closeTerminalSearch({ refocusTerminal: false });
  if (getZoomedSessionId() === sessionId) exitPaneZoom();

  terminalSessions.delete(sessionId);
  session.terminal.dispose();
  removePaneContainer(session.container);
  document.body.dataset.terminalExitCount = String((Number(document.body.dataset.terminalExitCount) || 0) + 1);

  if (isSmokeTest && !smokeCompleted) {
    smokeCompleted = true;
    window.terminalApi.reportSmokeResult(false);
    return;
  }
  if (rendererShuttingDown) return;

  // A tab survives as long as one of its panes is left.
  const remainingPanes = tabSessions(tabId);
  if (remainingPanes.length > 0) {
    const fallback = remainingPanes[Math.min(paneIndex, remainingPanes.length - 1)];
    const tab = terminalTabs.get(tabId);
    if (tab && !terminalSessions.has(tab.activePaneId)) tab.activePaneId = fallback.id;
    if (wasActive) switchTerminalSession(fallback.id);
    else {
      renderTabLabel(tabId);
      refreshFileBrowser();
    }
    fitActiveTerminal();
    return;
  }

  removeTerminalTab(tabId);
  const remainingTabs = [...terminalTabs.keys()];
  if (remainingTabs.length > 0) {
    if (wasActive) switchTerminalTab(remainingTabs[Math.min(tabIndex, remainingTabs.length - 1)]);
    else refreshFileBrowser();
    return;
  }

  activeSessionId = null;
  activeTabId = null;
  updateShellStatus();
  renderFileBrowser(null);
  document.body.dataset.terminalRespawnCount = String((Number(document.body.dataset.terminalRespawnCount) || 0) + 1);
  createTerminalSession().catch((error) => console.error('Terminal respawn failed:', error));
}

function updateTerminalMetadata(updates) {
  if (!Array.isArray(updates)) return;
  updates.forEach((metadata) => {
    const session = terminalSessions.get(metadata?.sessionId);
    if (!session) return;
    const context = typeof metadata.label === 'string' && metadata.label ? metadata.label : '~';
    session.autoContext = context;
    session.autoTitle = metadata.idle ? metadata.cwd || metadata.command || context : metadata.command || context;
    renderTerminalTabLabel(session);
    if (terminalTabs.get(session.tabId)?.activePaneId === session.id) {
      session.tab.dataset.processName = metadata.processName || '';
    }
    if (metadata.processName === 'top') document.body.dataset.ttyTopObserved = 'true';
    if (metadata.completedCommand) handleCommandCompleted(session, metadata.completedCommand);
  });
}

// Only worth a badge if the user isn't already looking at it — main reports
// every foreground->idle transition regardless of focus, so the "was this
// active" call is made here, where activeSessionId actually lives.
function handleCommandCompleted(session, completedCommand) {
  if (session.id === activeSessionId) return;
  session.completedCommandBadge = true;
  renderTabLabel(session.tabId);
  document.body.dataset.commandCompletedCount = String((Number(document.body.dataset.commandCompletedCount) || 0) + 1);
  playCommandCompleteSound();
  console.info(`Background command finished in ${paneLabel(session)}: ${completedCommand.name} (${Math.round(completedCommand.durationMs / 1000)}s)`);
}

function createTerminalTab() {
  const tabNumber = nextTabNumber;
  nextTabNumber += 1;
  const tabId = `tab-${String(tabNumber).padStart(2, '0')}`;

  const button = document.createElement('button');
  button.className = 'tty-tab hud-label';
  button.type = 'button';
  button.id = `${tabId}-tab`;
  button.dataset.tabId = tabId;
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', `${tabId}-view`);
  const index = document.createElement('span');
  index.className = 'tty-index';
  index.textContent = String(tabNumber).padStart(2, '0');
  const context = document.createElement('span');
  context.className = 'tty-context';
  context.textContent = '~';
  button.append(index, context);
  button.addEventListener('click', () => switchTerminalTab(tabId));
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const tab = terminalTabs.get(tabId);
    if (tab?.activePaneId) showTTYContextMenu(tab.activePaneId, event.clientX, event.clientY);
  });

  // Once a tab is split, every pane gets its own chip in the bar so it can be
  // focused, renamed and closed on its own.
  const group = document.createElement('div');
  group.className = 'tty-tab-group';
  group.dataset.tabId = tabId;
  group.append(button);
  document.getElementById('ttyTabs').append(group);

  const view = document.createElement('div');
  view.className = 'terminal-tab-view';
  view.id = `${tabId}-view`;
  view.dataset.tabId = tabId;
  view.setAttribute('role', 'tabpanel');
  view.setAttribute('aria-labelledby', `${tabId}-tab`);
  view.hidden = true;
  document.getElementById('terminalSessions').append(view);

  const tab = { id: tabId, number: tabNumber, button, group, view, activePaneId: null };
  terminalTabs.set(tabId, tab);
  return tab;
}

function switchTerminalTab(tabId) {
  const tab = terminalTabs.get(tabId);
  if (!tab) return;
  const paneId = terminalSessions.has(tab.activePaneId)
    ? tab.activePaneId
    : tabSessions(tabId)[0]?.id;
  if (paneId) switchTerminalSession(paneId);
}

function removeTerminalTab(tabId) {
  const tab = terminalTabs.get(tabId);
  if (!tab) return;
  tab.group.remove();
  tab.view.remove();
  terminalTabs.delete(tabId);
  if (activeTabId === tabId) activeTabId = null;
}

// WebGL rendering is an upgrade, not a requirement — some GPUs/drivers refuse
// a context (activate() throws), and an already-running one can lose its
// context later (dropped GPU process, sleep/wake). Either way xterm's own
// canvas renderer is still there underneath once the addon is gone.
function loadWebglAddon(session) {
  try {
    const webglAddon = new WebglAddon.WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
      if (session.webglAddon === webglAddon) session.webglAddon = null;
    });
    session.terminal.loadAddon(webglAddon);
    session.webglAddon = webglAddon;
  } catch (error) {
    console.warn('WebGL terminal renderer unavailable, using canvas:', error);
    session.webglAddon = null;
  }
}

async function createTerminalSession({ tabId = null, splitFrom = null, direction = 'row' } = {}) {
  if (terminalSessions.size >= maxTerminalSessions) {
    terminalSessions.get(activeSessionId)?.terminal.write(`\r\n[TTY LIMIT: ${maxTerminalSessions}]\r\n`);
    return null;
  }

  const sessionNumber = nextSessionNumber;
  nextSessionNumber += 1;
  const sessionId = `tty-${String(sessionNumber).padStart(2, '0')}`;
  const label = `TTY ${String(sessionNumber).padStart(2, '0')}`;
  const origin = splitFrom ? terminalSessions.get(splitFrom) : null;
  const tab = origin ? terminalTabs.get(origin.tabId) : (tabId && terminalTabs.get(tabId)) || createTerminalTab();
  if (!tab) return null;

  const container = document.createElement('div');
  container.className = 'terminal-instance';
  container.id = `${sessionId}-panel`;
  container.dataset.sessionId = sessionId;
  container.style.flex = '1 1 0';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', `${label}, terminal zsh`);
  if (origin) splitPaneContainer(origin.container, container, direction);
  else tab.view.append(container);

  const appearance = window.themeApi?.appearance() || {};
  const terminal = new Terminal({
    // SearchAddon's match highlighting uses registerDecoration, which xterm
    // gates behind this flag as a "proposed" (not yet stabilized) API.
    allowProposedApi: true,
    cursorBlink: true,
    convertEol: false,
    fontFamily: appearance.fontFamily || '"Monaspace Neon NF", "SF Mono", Menlo, monospace',
    fontSize: appearance.fontSize || 12,
    fontWeight: '400',
    letterSpacing: 0.2,
    lineHeight: 1.16,
    scrollback: appearance.scrollback || 10_000,
    theme: themedTerminalPalette(appearance)
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  const searchAddon = new SearchAddon.SearchAddon();
  terminal.loadAddon(searchAddon);
  // CSP locks connect-src down to 'none', so the renderer can't open anything
  // itself — hand the URL to main over the same validated (http/https-only,
  // trusted-sender) channel the assistant's source citations already use.
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => {
    window.assistantApi.openSource(uri).catch((error) => console.warn('Failed to open link:', error));
  }));
  terminal.open(container);
  fitAddon.fit();
  const session = {
    id: sessionId,
    tabId: tab.id,
    terminal,
    fitAddon,
    searchAddon,
    webglAddon: null,
    container,
    tab: tab.button,
    autoContext: '~',
    autoTitle: '~',
    manualName: null,
    closing: false,
    online: false,
    failed: false,
    completedCommandBadge: false
  };
  terminalSessions.set(sessionId, session);
  searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (getTerminalSearchSessionId() === sessionId) updateTerminalSearchCount(resultIndex, resultCount);
  });
  loadWebglAddon(session);
  paneResizeObserver.observe(container);
  container.addEventListener('pointerdown', () => {
    if (activeSessionId !== sessionId) switchTerminalSession(sessionId);
  }, true);
  terminal.textarea?.addEventListener('focus', () => {
    if (activeSessionId !== sessionId) switchTerminalSession(sessionId);
  });
  renderTabLabel(tab.id);
  terminal.onData((data) => {
    playInputSound(data);
    window.terminalApi.write(sessionId, data);
  });
  terminal.onResize(({ cols, rows }) => window.terminalApi.resize(sessionId, cols, rows));
  switchTerminalSession(sessionId);

  try {
    await window.terminalApi.start(sessionId, { cols: terminal.cols, rows: terminal.rows });
    session.online = true;
    window.terminalApi.setActive(sessionId);
    updateShellStatus();
    focusTerminal();
    if (isSmokeTest && sessionNumber === 1) {
      window.terminalApi.write(sessionId, `command -v ai >/dev/null && command -v search >/dev/null && printf '${smokeMarker}\\n'\r`);
    } else if (isVisualTest) {
      window.terminalApi.write(sessionId, "clear; printf 'PTY LINK VERIFIED / ZSH READY\\n'\r");
    }
  } catch (error) {
    session.failed = true;
    terminal.write(`\r\n[ZSH START FAILED: ${error.message}]\r\n`);
    updateShellStatus();
    if (isSmokeTest && !smokeCompleted) window.terminalApi.reportSmokeResult(false);
  }
  return session;
}

async function initializeTerminal() {
  await document.fonts.ready;

  window.terminalApi.onData(({ sessionId, data }) => {
    const session = terminalSessions.get(sessionId);
    if (!session || typeof data !== 'string') return;
    session.terminal.write(data);

    if (isVisualTest) {
      dropTestOutput = `${dropTestOutput}${data}`.slice(-2_048);
      if (dropTestOutput.includes(dropTestMarker)) document.body.dataset.dropShellVerified = 'true';
      if (dropTestOutput.includes(panelDropTestMarker)) document.body.dataset.panelDropShellVerified = 'true';
    }

    if (isSmokeTest && sessionId === 'tty-01' && !smokeCompleted) {
      smokeOutput += data;
      if (smokeOutput.includes(smokeMarker)) {
        smokeCompleted = true;
        window.terminalApi.reportSmokeResult(true);
      }
    }
  });

  window.terminalApi.onMetadata(updateTerminalMetadata);

  window.terminalApi.onExit(({ sessionId }) => handleTerminalExit(sessionId));

  const resizeObserver = new ResizeObserver(() => fitActiveTerminal());
  resizeObserver.observe(document.querySelector('.terminal-surface'));
  window.addEventListener('beforeunload', () => {
    rendererShuttingDown = true;
    resizeObserver.disconnect();
    paneResizeObserver.disconnect();
  }, { once: true });
  await createTerminalSession();
}

initializeAudio();
initializeBoot();
initializeControls();
initializeTTYContextMenu();
initializeFileBrowser();
initializeFileDrop();
// Re-apply on every appearance change, and once fonts are ready so xterm
// measures the real glyph widths instead of the fallback face.
window.themeApi?.onChange((appearance) => applyTerminalAppearance(appearance));
document.fonts?.ready?.then(() => applyTerminalAppearance()).catch(() => {});

// Hooks used only by the automated file-manager check (EDEX_FILES_TEST).
if (testMode === 'files') {
  window.__edexBrowse = (directoryPath) => browseDirectory(directoryPath);
  window.__edexTerminalOptions = () => {
    const session = terminalSessions.get(activeSessionId);
    if (!session) return {};
    return {
      fontFamily: session.terminal.options.fontFamily,
      fontSize: session.terminal.options.fontSize,
      foreground: session.terminal.options.theme?.foreground
    };
  };
  window.__edexNewFolder = (name) => {
    const parent = currentDirectoryPath();
    if (!parent) return;
    runFileOperation('TWORZENIE FOLDERU…', () => window.filesApi.makeDirectory(parent, name));
  };
}
initializeMonitoring();
initializeTerminal().catch((error) => {
  document.getElementById('shellStatus').dataset.state = 'offline';
  document.getElementById('shellStatusText').textContent = 'LINK FAILED';
  console.error('Terminal initialization failed:', error);
  if (isSmokeTest && !smokeCompleted) {
    smokeCompleted = true;
    window.terminalApi.reportSmokeResult(false);
  }
});
