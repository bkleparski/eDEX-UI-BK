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
const imagePreviewExtensions = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;
const imagePreviewDwellMs = 200;
const imagePreviewCacheLimit = 24;
const imagePreviewCacheTtlMs = 60_000;
const imagePreviewCacheMaxChars = 48 * 1024 * 1024;
const maxTerminalSessions = 8;
// One entry per pty: a session is a *pane*, not a tab. Tabs own a layout tree
// of panes, so several sessions can be visible side by side at once.
const terminalSessions = new Map();
const terminalTabs = new Map();
let activeSessionId = null;
let activeTabId = null;
let terminalSearchSessionId = null;
let nextSessionNumber = 1;
let nextTabNumber = 1;
let bootTimer;
let bootActive = false;
let smokeOutput = '';
let smokeCompleted = false;
let audioContext = null;
let soundEnabled = false;
let fileRefreshTimer = null;
let fileRefreshInFlight = false;
let fileBrowserMode = 'live';
let browsedDirectory = null;
let showHiddenFiles = false;
let fileBrowserRequestId = 0;
let lastFileBrowserResult = null;
const fileSelection = new Set();
let fileSelectionAnchor = null;
let fileSortKey = 'name';
let fileSortAscending = true;
let fileFilterQuery = '';
let fileClipboard = null;
let fileContextPaths = [];
let fileRenameTarget = null;
let fileOperationInFlight = false;
let imagePreviewTimer = null;
let imagePreviewRequestToken = 0;
let imagePreviewHoverStartedAt = 0;
let imagePreviewPath = null;
let imagePreviewCursorX = 0;
let imagePreviewCursorY = 0;
let ttyContextSessionId = null;
let ttyRenameSessionId = null;
let fileDragDepth = 0;
let dropTestOutput = '';
let rendererShuttingDown = false;
const telemetryHistory = {
  cpu: [],
  networkDown: [],
  networkUp: [],
  gpu: []
};
// Mirrors PROCESS_LIST_LIMIT in src/main.js — the payload carries leaders of
// every sortable column (up to ~3x this), so the renderer re-trims after sorting.
const PROCESS_LIST_LIMIT = 14;
let processSortKey = 'cpuPercent';
let lastProcesses = [];
const imagePreviewCache = new Map();
let imagePreviewCacheChars = 0;

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
    // Cached glyph bitmaps are keyed by (char, colors), so a new accent or
    // font would otherwise keep painting from the stale atlas until enough
    // cache churn evicts it — clear it explicitly so the switch is instant.
    session.webglAddon?.clearTextureAtlas();
  }
  fitActiveTerminal();
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatPercent(value, digits = 0) {
  const number = numeric(value);
  return number === null ? '--' : `${number.toFixed(digits)}%`;
}

function formatCapacity(bytes) {
  const value = numeric(bytes);
  if (value === null) return '--';
  const gibibytes = value / (1024 ** 3);
  return gibibytes >= 100 ? `${gibibytes.toFixed(0)} GB` : `${gibibytes.toFixed(1)} GB`;
}

function formatRate(bytesPerSecond) {
  const value = numeric(bytesPerSecond);
  if (value === null) return '--';
  if (value >= 1024 ** 3) return `${(value / (1024 ** 3)).toFixed(1)} GB/s`;
  if (value >= 1024 ** 2) return `${(value / (1024 ** 2)).toFixed(1)} MB/s`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${Math.round(value)} B/s`;
}

function formatUptime(totalSeconds) {
  const seconds = numeric(totalSeconds);
  if (seconds === null) return '--';
  const totalMinutes = Math.floor(Math.max(seconds, 0) / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days}D ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function pushHistory(history, value, limit = 42) {
  history.push(Math.max(numeric(value) ?? 0, 0));
  if (history.length > limit) history.splice(0, history.length - limit);
}

function sparklinePoints(values, height, maximum = null) {
  if (values.length === 0) return `0,${height} 100,${height}`;
  const scaleMaximum = Math.max(maximum ?? Math.max(...values), 1);
  return values.map((value, index) => {
    const x = values.length === 1 ? 100 : (index / (values.length - 1)) * 100;
    const y = height - (Math.min(value, scaleMaximum) / scaleMaximum) * (height - 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function setMeter(id, percent) {
  const value = numeric(percent);
  document.getElementById(id).style.transform = `scaleX(${value === null ? 0 : Math.min(Math.max(value, 0), 100) / 100})`;
}

function setStackedMeter(id, offsetPercent, sizePercent) {
  const clamp = (value) => Math.min(Math.max(numeric(value) ?? 0, 0), 100);
  const offset = clamp(offsetPercent);
  const size = Math.min(clamp(sizePercent), 100 - offset);
  const element = document.getElementById(id);
  element.style.left = `${offset}%`;
  element.style.width = `${size}%`;
}

function setWarningState(element, enabled) {
  element.classList.toggle('is-warning', enabled);
}

function renderCoreLoads(cores) {
  const container = document.getElementById('cpuCores');
  container.replaceChildren();
  if (!Array.isArray(cores) || cores.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'hud-label core-empty';
    empty.textContent = 'CORE DATA N/A';
    container.append(empty);
    return;
  }

  cores.forEach((load, index) => {
    const core = document.createElement('span');
    core.className = 'core-cell';
    core.title = `Core ${index + 1}: ${formatPercent(load, 0)}`;
    core.setAttribute('aria-label', core.title);
    const level = document.createElement('span');
    level.style.transform = `scaleY(${Math.min(Math.max(numeric(load) ?? 0, 0), 100) / 100})`;
    core.append(level);
    container.append(core);
  });
}

// Nulls (no energy sample yet for that pid) always sort to the bottom,
// regardless of sort direction — there's only one direction, descending.
function sortProcesses(processes, sortKey) {
  return [...processes].sort((left, right) => {
    const leftValue = numeric(left[sortKey]);
    const rightValue = numeric(right[sortKey]);
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return rightValue - leftValue;
  });
}

function formatProcessValue(processInfo, sortKey) {
  if (sortKey === 'energyImpact') {
    const value = numeric(processInfo.energyImpact);
    return value === null ? '--' : value.toFixed(1);
  }
  return formatPercent(processInfo[sortKey], 1);
}

function renderProcesses(processes, sortKey = processSortKey) {
  const list = document.getElementById('processList');
  list.replaceChildren();
  if (!Array.isArray(processes) || processes.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'process-empty hud-label';
    empty.textContent = 'PROCESS DATA N/A';
    list.append(empty);
    return;
  }

  const visible = sortProcesses(processes, sortKey).slice(0, PROCESS_LIST_LIMIT);
  visible.forEach((processInfo, index) => {
    const row = document.createElement('li');
    row.className = 'process-row';

    const rank = document.createElement('span');
    rank.className = 'process-rank';
    rank.textContent = String(index + 1).padStart(2, '0');

    const name = document.createElement('span');
    name.className = 'process-name';
    name.textContent = typeof processInfo.name === 'string' ? processInfo.name : 'UNKNOWN';
    name.title = name.textContent;

    const value = document.createElement('span');
    value.className = 'process-cpu';
    value.textContent = formatProcessValue(processInfo, sortKey);

    row.append(rank, name, value);
    list.append(row);
  });
}

function setProcessSortKey(sortKey) {
  if (sortKey === processSortKey) return;
  processSortKey = sortKey;
  document.querySelectorAll('.process-sort-btn').forEach((button) => {
    const isActive = button.dataset.sortKey === sortKey;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
  renderProcesses(lastProcesses, processSortKey);
}

function initializeProcessSort() {
  document.querySelectorAll('.process-sort-btn').forEach((button) => {
    button.addEventListener('click', () => setProcessSortKey(button.dataset.sortKey));
  });
}

function renderMonitoring(sample) {
  if (!sample || typeof sample !== 'object') return;
  document.body.dataset.monitoringReady = 'true';
  document.body.dataset.monitoringSamples = String((Number(document.body.dataset.monitoringSamples) || 0) + 1);
  document.getElementById('monitoringStatusText').textContent = sample.status === 'ok' ? 'LIVE' : sample.status === 'partial' ? 'PARTIAL' : 'OFFLINE';
  document.getElementById('hudHostname').textContent = sample.session?.hostname || 'LOCALHOST';
  document.getElementById('uptimeValue').textContent = formatUptime(sample.session?.uptimeSeconds);

  const cpuLoad = sample.cpu?.loadPercent;
  document.getElementById('cpuValue').textContent = formatPercent(cpuLoad, 1);
  pushHistory(telemetryHistory.cpu, cpuLoad);
  document.getElementById('cpuSparkline').setAttribute('points', sparklinePoints(telemetryHistory.cpu, 34, 100));
  renderCoreLoads(sample.cpu?.cores);

  document.getElementById('memoryValue').textContent = formatPercent(sample.memory?.usePercent, 0);
  document.getElementById('memoryTotal').textContent = formatCapacity(sample.memory?.totalBytes);
  document.getElementById('memoryUsed').textContent = formatCapacity(sample.memory?.usedBytes);
  document.getElementById('memoryUsedShare').textContent = formatPercent(sample.memory?.usePercent, 0);
  document.getElementById('memoryCached').textContent = formatCapacity(sample.memory?.cachedBytes);
  document.getElementById('memoryCachedShare').textContent = formatPercent(sample.memory?.cachedPercent, 0);
  document.getElementById('memoryAvailable').textContent = formatCapacity(sample.memory?.availableBytes);
  document.getElementById('memoryAvailableShare').textContent = formatPercent(sample.memory?.availablePercent, 0);
  document.getElementById('memoryFree').textContent = formatCapacity(sample.memory?.freeBytes);
  document.getElementById('memoryFreeShare').textContent = formatPercent(sample.memory?.freePercent, 0);
  setMeter('memoryMeter', sample.memory?.usePercent);
  // The cached segment is stacked on top of the used bar, so offset it by the used share.
  setStackedMeter('memoryCachedMeter', sample.memory?.usePercent, sample.memory?.cachedPercent);
  setWarningState(document.getElementById('memoryValue'), numeric(sample.memory?.usePercent) > 90);

  const swapTotal = numeric(sample.memory?.swapTotalBytes) ?? 0;
  const swapRow = document.getElementById('memorySwapRow');
  swapRow.hidden = swapTotal <= 0;
  if (swapTotal > 0) {
    document.getElementById('memorySwap').textContent = `${formatCapacity(sample.memory.swapUsedBytes)} / ${formatCapacity(swapTotal)}`;
    document.getElementById('memorySwapShare').textContent = formatPercent(sample.memory.swapPercent, 0);
    setWarningState(swapRow, numeric(sample.memory.swapPercent) > 80);
  }

  const hasBattery = sample.battery?.hasBattery === true;
  const batteryPercent = numeric(sample.battery?.percent);
  const charging = sample.battery?.isCharging === true;
  document.body.dataset.batteryPresent = String(hasBattery);
  document.getElementById('powerDivider').hidden = !hasBattery;
  const powerStatus = document.getElementById('powerStatus');
  powerStatus.hidden = !hasBattery;
  if (hasBattery) {
    document.getElementById('powerLabel').textContent = charging ? 'CHG' : 'PWR';
    document.getElementById('batteryValue').textContent = formatPercent(batteryPercent, 0);
    setWarningState(powerStatus, !charging && batteryPercent !== null && batteryPercent < 20);
  }

  const down = sample.network?.downBytesPerSecond;
  const up = sample.network?.upBytesPerSecond;
  document.getElementById('networkInterface').textContent = sample.network?.interface ? `INTERFACE ${sample.network.interface}` : 'INTERFACE N/A';
  document.getElementById('networkDown').textContent = formatRate(down);
  document.getElementById('networkUp').textContent = formatRate(up);
  pushHistory(telemetryHistory.networkDown, down);
  pushHistory(telemetryHistory.networkUp, up);
  const networkMaximum = Math.max(...telemetryHistory.networkDown, ...telemetryHistory.networkUp, 1);
  document.getElementById('networkDownSparkline').setAttribute('points', sparklinePoints(telemetryHistory.networkDown, 28, networkMaximum));
  document.getElementById('networkUpSparkline').setAttribute('points', sparklinePoints(telemetryHistory.networkUp, 28, networkMaximum));

  const online = sample.connectivity?.state === 'online';
  document.body.dataset.networkState = online ? 'online' : 'offline';
  document.getElementById('networkLan').textContent = online && sample.connectivity?.lanIpv4 ? sample.connectivity.lanIpv4 : '—';
  document.getElementById('networkPublic').textContent = online && sample.connectivity?.publicIpv4 ? sample.connectivity.publicIpv4 : '—';
  document.getElementById('networkPing').textContent = online && numeric(sample.connectivity?.latencyMs) !== null
    ? `${Math.round(sample.connectivity.latencyMs)}ms`
    : '—';
  const networkState = document.getElementById('networkState');
  networkState.lastChild.textContent = online ? 'ONLINE' : 'OFFLINE';
  networkState.classList.toggle('is-online', online);
  networkState.classList.toggle('is-offline', !online);

  document.getElementById('diskValue').textContent = formatPercent(sample.disk?.usePercent, 0);
  document.getElementById('diskUsed').textContent = formatCapacity(sample.disk?.usedBytes);
  document.getElementById('diskAvailable').textContent = formatCapacity(sample.disk?.availableBytes);
  setMeter('diskMeter', sample.disk?.usePercent);
  setWarningState(document.getElementById('diskSection'), numeric(sample.disk?.usePercent) > 90);

  const gpuBlock = document.getElementById('gpuBlock');
  const hasGpu = sample.gpu && numeric(sample.gpu.utilizationPercent) !== null;
  gpuBlock.hidden = !hasGpu;
  if (hasGpu) {
    document.getElementById('gpuValue').textContent = formatPercent(sample.gpu.utilizationPercent, 1);
    document.getElementById('gpuRenderer').textContent = formatPercent(sample.gpu.rendererPercent, 0);
    document.getElementById('gpuTiler').textContent = formatPercent(sample.gpu.tilerPercent, 0);
    pushHistory(telemetryHistory.gpu, sample.gpu.utilizationPercent);
    document.getElementById('gpuSparkline').setAttribute('points', sparklinePoints(telemetryHistory.gpu, 34, 100));
  }

  lastProcesses = Array.isArray(sample.processes) ? sample.processes : [];
  renderProcesses(lastProcesses);

  const systemUnavailable = !sample.cpu && !sample.memory;
  const networkUnavailable = !sample.network && (!sample.processes || sample.processes.length === 0);
  document.getElementById('systemError').hidden = !systemUnavailable;
  document.getElementById('networkError').hidden = !networkUnavailable;
}

function initializeMonitoring() {
  const unsubscribe = window.monitoringApi.onData(renderMonitoring);
  window.addEventListener('beforeunload', () => {
    unsubscribe();
    window.monitoringApi.stop();
  }, { once: true });

  window.monitoringApi.start().catch((error) => {
    document.body.dataset.monitoringReady = 'true';
    document.getElementById('monitoringStatusText').textContent = 'OFFLINE';
    document.getElementById('systemError').hidden = false;
    document.getElementById('networkError').hidden = false;
    console.error('Monitoring initialization failed:', error);
  });
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

function fileTypeMarker(type) {
  if (type === 'directory') return '[D]';
  if (type === 'link') return '[L]';
  if (type === 'file') return '[F]';
  return '[?]';
}

const fileIconPaths = {
  parent: ['M3 7.5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M12 17v-5m0 0-2.2 2.2M12 12l2.2 2.2'],
  directory: ['M3 7.5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z'],
  file: ['M6 3.5h8l4 4v13H6z', 'M14 3.5v4h4'],
  link: [
    'M10.5 13.5a3.5 3.5 0 0 1 0-5l2-2a3.5 3.5 0 0 1 5 5l-1 1',
    'M13.5 10.5a3.5 3.5 0 0 1 0 5l-2 2a3.5 3.5 0 0 1-5-5l1-1'
  ],
  other: ['M6 3.5h8l4 4v13H6z']
};

function createFileIcon(entry) {
  const key = entry.parent ? 'parent' : fileIconPaths[entry.type] ? entry.type : 'other';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'file-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const definition of fileIconPaths[key]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', definition);
    svg.append(path);
  }
  return svg;
}

function formatFileSize(bytes) {
  const value = numeric(bytes);
  if (value === null) return '--';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB`;
  return `${(value / (1024 ** 3)).toFixed(1)} GB`;
}

function formatFileModified(modifiedMs) {
  const value = numeric(modifiedMs);
  if (value === null) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const datePart = date.toLocaleDateString('pl-PL', sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' });
  const timePart = date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}

function isPreviewableImage(entry) {
  return entry?.type === 'file' && imagePreviewExtensions.test(entry.fullPath || '');
}

function cachedImagePreview(filePath) {
  const cached = imagePreviewCache.get(filePath);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    imagePreviewCache.delete(filePath);
    imagePreviewCacheChars -= cached.chars;
    return null;
  }
  imagePreviewCache.delete(filePath);
  imagePreviewCache.set(filePath, cached);
  return cached.response;
}

function cacheImagePreview(filePath, response) {
  const chars = typeof response?.dataUri === 'string' ? response.dataUri.length : 128;
  if (chars > imagePreviewCacheMaxChars) return;
  const existing = imagePreviewCache.get(filePath);
  if (existing) imagePreviewCacheChars -= existing.chars;
  imagePreviewCache.set(filePath, { response, chars, expiresAt: Date.now() + imagePreviewCacheTtlMs });
  imagePreviewCacheChars += chars;
  while (imagePreviewCache.size > imagePreviewCacheLimit || imagePreviewCacheChars > imagePreviewCacheMaxChars) {
    const oldestPath = imagePreviewCache.keys().next().value;
    const oldest = imagePreviewCache.get(oldestPath);
    imagePreviewCache.delete(oldestPath);
    imagePreviewCacheChars -= oldest.chars;
  }
}

function positionImagePreview() {
  const preview = document.getElementById('fileImagePreview');
  if (preview.hidden) return;
  const margin = 8;
  const offset = 16;
  const rect = preview.getBoundingClientRect();
  let left = imagePreviewCursorX + offset;
  let top = imagePreviewCursorY + offset;
  if (left + rect.width > window.innerWidth - margin) left = imagePreviewCursorX - rect.width - offset;
  if (top + rect.height > window.innerHeight - margin) top = imagePreviewCursorY - rect.height - offset;
  left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - rect.width - margin));
  top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - rect.height - margin));
  preview.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function hideImagePreview(reason = 'leave') {
  const preview = document.getElementById('fileImagePreview');
  const image = document.getElementById('fileImagePreviewImage');
  const wasActive = imagePreviewPath !== null || !preview.hidden;
  clearTimeout(imagePreviewTimer);
  imagePreviewTimer = null;
  imagePreviewRequestToken += 1;
  imagePreviewPath = null;
  image.onload = null;
  image.onerror = null;
  image.removeAttribute('src');
  image.hidden = true;
  preview.hidden = true;
  preview.setAttribute('aria-hidden', 'true');
  preview.dataset.state = 'hidden';
  document.body.dataset.imagePreviewVisible = 'false';
  if (reason === 'drag' && wasActive) document.body.dataset.imagePreviewHiddenByDrag = 'true';
}

function showImagePreviewMessage(message, fileName, requestToken) {
  if (requestToken !== imagePreviewRequestToken || !imagePreviewPath) return;
  const preview = document.getElementById('fileImagePreview');
  const image = document.getElementById('fileImagePreviewImage');
  const messageNode = document.getElementById('fileImagePreviewMessage');
  image.hidden = true;
  messageNode.hidden = false;
  messageNode.textContent = message;
  document.getElementById('fileImagePreviewLabel').textContent = fileName;
  preview.dataset.state = 'message';
  preview.hidden = false;
  preview.setAttribute('aria-hidden', 'false');
  document.body.dataset.imagePreviewVisible = 'true';
  requestAnimationFrame(positionImagePreview);
}

function showImagePreviewImage(response, fileName, requestToken) {
  if (requestToken !== imagePreviewRequestToken || !imagePreviewPath
    || typeof response.dataUri !== 'string' || !response.dataUri.startsWith('data:image/')) return;
  const preview = document.getElementById('fileImagePreview');
  const image = document.getElementById('fileImagePreviewImage');
  const messageNode = document.getElementById('fileImagePreviewMessage');
  image.onload = () => {
    if (requestToken !== imagePreviewRequestToken || !imagePreviewPath) return;
    messageNode.hidden = true;
    image.hidden = false;
    document.getElementById('fileImagePreviewLabel').textContent = fileName;
    preview.dataset.state = 'image';
    preview.hidden = false;
    preview.setAttribute('aria-hidden', 'false');
    document.body.dataset.imagePreviewVisible = 'true';
    document.body.dataset.imagePreviewNaturalWidth = String(image.naturalWidth);
    document.body.dataset.imagePreviewNaturalHeight = String(image.naturalHeight);
    requestAnimationFrame(positionImagePreview);
  };
  image.onerror = () => {
    if (requestToken === imagePreviewRequestToken) hideImagePreview('decode-error');
  };
  image.src = response.dataUri;
}

function presentImagePreview(response, fileName, requestToken) {
  if (response?.status === 'ok') {
    showImagePreviewImage(response, fileName, requestToken);
  } else if (response?.status === 'too-large') {
    showImagePreviewMessage('FILE TOO LARGE', fileName, requestToken);
  } else if (requestToken === imagePreviewRequestToken) {
    hideImagePreview('unavailable');
  }
}

function scheduleImagePreview(row, clientX, clientY) {
  const filePath = row?.dataset.path;
  if (!filePath || row.dataset.previewable !== 'true') return;
  clearTimeout(imagePreviewTimer);
  imagePreviewRequestToken += 1;
  const requestToken = imagePreviewRequestToken;
  imagePreviewPath = filePath;
  imagePreviewCursorX = clientX;
  imagePreviewCursorY = clientY;
  imagePreviewHoverStartedAt = Date.now();
  imagePreviewTimer = setTimeout(async () => {
    imagePreviewTimer = null;
    if (requestToken !== imagePreviewRequestToken || imagePreviewPath !== filePath) return;
    document.body.dataset.imagePreviewDwellMs = String(Date.now() - imagePreviewHoverStartedAt);
    const cached = cachedImagePreview(filePath);
    if (cached) {
      document.body.dataset.imagePreviewCacheHit = 'true';
      presentImagePreview(cached, row.dataset.name, requestToken);
      return;
    }
    document.body.dataset.imagePreviewRequestCount = String(
      (Number(document.body.dataset.imagePreviewRequestCount) || 0) + 1
    );
    try {
      const response = await window.filesApi.preview(filePath);
      if (response?.status === 'ok' || response?.status === 'too-large') cacheImagePreview(filePath, response);
      presentImagePreview(response, row.dataset.name, requestToken);
    } catch {
      if (requestToken === imagePreviewRequestToken) hideImagePreview('ipc-error');
    }
  }, imagePreviewDwellMs);
}

function reconcileImagePreviewRow(list) {
  if (!imagePreviewPath) return;
  const replacement = [...list.querySelectorAll('.file-row[data-previewable="true"]')]
    .find((row) => row.dataset.path === imagePreviewPath);
  if (!replacement) {
    hideImagePreview('listing-changed');
    return;
  }
  const rect = replacement.getBoundingClientRect();
  if (imagePreviewCursorX < rect.left || imagePreviewCursorX > rect.right
    || imagePreviewCursorY < rect.top || imagePreviewCursorY > rect.bottom) {
    hideImagePreview('pointer-left');
    return;
  }
}

function updateFileBrowserMode(mode) {
  fileBrowserMode = mode === 'browsing' ? 'browsing' : 'live';
  const browsing = fileBrowserMode === 'browsing';
  const chip = document.getElementById('fileBrowserMode');
  chip.textContent = browsing ? 'BROWSING' : 'LIVE';
  chip.classList.toggle('is-on', browsing);
  chip.dataset.mode = fileBrowserMode;
  chip.disabled = !browsing;
  chip.setAttribute('aria-pressed', String(browsing));
  chip.title = browsing ? 'RESUME LIVE TRACKING' : 'LIVE CWD TRACKING';
  document.body.dataset.fileBrowserMode = fileBrowserMode;
}

function updateDotfilesState() {
  const toggle = document.getElementById('dotfilesToggle');
  toggle.textContent = showHiddenFiles ? 'DOTS SHOWN' : 'DOTS HIDDEN';
  toggle.classList.toggle('is-on', showHiddenFiles);
  toggle.setAttribute('aria-pressed', String(showHiddenFiles));
  toggle.setAttribute('aria-label', showHiddenFiles ? 'Ukryj ukryte pliki' : 'Pokaz ukryte pliki');
  toggle.title = showHiddenFiles ? 'HIDE DOTFILES (⌘⇧.)' : 'SHOW DOTFILES (⌘⇧.)';
  document.body.dataset.dotfilesVisible = String(showHiddenFiles);
}

function toggleDotfiles() {
  showHiddenFiles = !showHiddenFiles;
  document.body.dataset.dotfilesToggleCount = String(
    (Number(document.body.dataset.dotfilesToggleCount) || 0) + 1
  );
  fileBrowserRequestId += 1;
  fileRefreshInFlight = false;
  updateDotfilesState();
  refreshFileBrowser();
  focusTerminal();
}

function fileBrowserBusy() {
  return fileOperationInFlight
    || !document.getElementById('fileContextMenu').hidden
    || !document.getElementById('fileRenamePopover').hidden;
}

function currentDirectoryPath() {
  return lastFileBrowserResult?.status === 'ok' ? lastFileBrowserResult.cwd : null;
}

function selectableEntries() {
  const entries = Array.isArray(lastFileBrowserResult?.entries) ? lastFileBrowserResult.entries : [];
  return sortFileEntries(entries.filter(matchesFileFilter));
}

function matchesFileFilter(entry) {
  if (!fileFilterQuery) return true;
  return entry.name.toLowerCase().includes(fileFilterQuery);
}

function sortFileEntries(entries) {
  const direction = fileSortAscending ? 1 : -1;
  return [...entries].sort((left, right) => {
    // Folders stay grouped above files regardless of the active sort column.
    const leftDirectory = left.type === 'directory' ? 0 : 1;
    const rightDirectory = right.type === 'directory' ? 0 : 1;
    if (leftDirectory !== rightDirectory) return leftDirectory - rightDirectory;
    if (fileSortKey === 'size') {
      return ((left.sizeBytes ?? -1) - (right.sizeBytes ?? -1)) * direction
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    }
    if (fileSortKey === 'modified') {
      return ((left.modifiedMs ?? 0) - (right.modifiedMs ?? 0)) * direction
        || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) * direction;
  });
}

function updateSortIndicators() {
  for (const button of document.querySelectorAll('.file-sort-btn')) {
    const active = button.dataset.sortKey === fileSortKey;
    button.classList.toggle('is-active', active);
    button.dataset.direction = active ? (fileSortAscending ? 'asc' : 'desc') : '';
  }
}

function updateFileStatusBar() {
  const selected = [...fileSelection];
  const entries = Array.isArray(lastFileBrowserResult?.entries) ? lastFileBrowserResult.entries : [];
  const chosen = entries.filter((entry) => selected.includes(entry.fullPath));
  const totalBytes = chosen.reduce((sum, entry) => sum + (numeric(entry.sizeBytes) ?? 0), 0);
  const label = document.getElementById('fileStatusSelection');
  if (chosen.length === 0) {
    label.textContent = 'NIC NIE ZAZNACZONO';
  } else if (chosen.length === 1) {
    label.textContent = `${chosen[0].name} · ${chosen[0].type === 'directory' ? 'KATALOG' : formatFileSize(chosen[0].sizeBytes)}`;
  } else {
    label.textContent = `${chosen.length} ZAZNACZONE · ${formatFileSize(totalBytes)}`;
  }
  const clipboard = document.getElementById('fileStatusClipboard');
  clipboard.textContent = fileClipboard
    ? `SCHOWEK: ${fileClipboard.paths.length} · ${fileClipboard.mode === 'copy' ? 'KOPIUJ' : 'PRZENIEŚ'}`
    : '';
  document.body.dataset.fileSelectionCount = String(chosen.length);
}

function applySelectionClasses() {
  for (const row of document.querySelectorAll('#fileList .file-row')) {
    row.classList.toggle('is-selected', fileSelection.has(row.dataset.path));
  }
  updateFileStatusBar();
}

function setFileSelection(paths) {
  fileSelection.clear();
  for (const item of paths) fileSelection.add(item);
  applySelectionClasses();
}

function clearFileSelection() {
  fileSelection.clear();
  fileSelectionAnchor = null;
  applySelectionClasses();
}

function handleRowSelection(row, event) {
  const visible = selectableEntries().map((entry) => entry.fullPath);
  const filePath = row.dataset.path;
  if (event.shiftKey && fileSelectionAnchor && visible.includes(fileSelectionAnchor)) {
    const from = visible.indexOf(fileSelectionAnchor);
    const to = visible.indexOf(filePath);
    const [start, end] = from < to ? [from, to] : [to, from];
    setFileSelection(visible.slice(start, end + 1));
    return;
  }
  if (event.metaKey) {
    if (fileSelection.has(filePath)) fileSelection.delete(filePath);
    else fileSelection.add(filePath);
    fileSelectionAnchor = filePath;
    applySelectionClasses();
    return;
  }
  fileSelectionAnchor = filePath;
  setFileSelection([filePath]);
}

function setFileOperationStatus(message) {
  document.getElementById('fileStatusSelection').textContent = message;
}

async function runFileOperation(label, task) {
  if (fileOperationInFlight) return null;
  fileOperationInFlight = true;
  setFileOperationStatus(label);
  try {
    return await task();
  } catch (error) {
    const text = typeof error?.message === 'string' ? error.message : 'OPERACJA NIE POWIODLA SIE';
    setFileOperationStatus(text.replace(/^Error invoking remote method '[^']+':\s*/i, '').slice(0, 120));
    document.body.dataset.fileOperationError = 'true';
    return null;
  } finally {
    fileOperationInFlight = false;
    fileBrowserRequestId += 1;
    fileRefreshInFlight = false;
    await refreshFileBrowser(fileBrowserMode === 'browsing' ? browsedDirectory : null);
    updateFileStatusBar();
  }
}

function openFileEntry(filePath, type) {
  if (!filePath) return;
  if (type === 'directory') {
    clearFileSelection();
    browseDirectory(filePath);
    return;
  }
  runFileOperation('OTWIERANIE…', async () => {
    await window.filesApi.open(filePath);
    document.body.dataset.fileOpenCount = String((Number(document.body.dataset.fileOpenCount) || 0) + 1);
  });
}

function hideFileContextMenu() {
  const menu = document.getElementById('fileContextMenu');
  menu.hidden = true;
  menu.setAttribute('aria-hidden', 'true');
  fileContextPaths = [];
  document.body.dataset.fileContextMenuOpen = 'false';
}

function showFileContextMenu(clientX, clientY) {
  const menu = document.getElementById('fileContextMenu');
  fileContextPaths = [...fileSelection];
  if (fileContextPaths.length === 0) return;
  const multiple = fileContextPaths.length > 1;
  const suffix = multiple ? ` (${fileContextPaths.length})` : '';
  const labels = {
    open: multiple ? `OTWÓRZ${suffix}` : 'OTWÓRZ',
    rename: 'ZMIEŃ NAZWĘ',
    insert: `DODAJ ŚCIEŻKĘ DO TERMINALA${suffix}`,
    'copy-path': `KOPIUJ ŚCIEŻKĘ${suffix}`,
    copy: `KOPIUJ${suffix}`,
    move: `PRZENIEŚ…${suffix}`,
    reveal: 'POKAŻ W FINDERZE',
    trash: `USUŃ DO KOSZA${suffix}`
  };
  for (const item of menu.querySelectorAll('[data-file-action]')) {
    const action = item.dataset.fileAction;
    item.textContent = labels[action] || item.textContent;
    // Renaming and revealing only make sense for exactly one entry.
    item.hidden = multiple && (action === 'rename' || action === 'reveal');
  }
  menu.hidden = false;
  menu.setAttribute('aria-hidden', 'false');
  document.body.dataset.fileContextMenuOpen = 'true';
  positionTTYOverlay(menu, clientX, clientY);
}

function hideFileRename() {
  const popover = document.getElementById('fileRenamePopover');
  popover.hidden = true;
  popover.setAttribute('aria-hidden', 'true');
  fileRenameTarget = null;
  document.body.dataset.fileRenameOpen = 'false';
}

function beginFileRename(filePath, { create = false } = {}) {
  const row = [...document.querySelectorAll('#fileList .file-row')].find((item) => item.dataset.path === filePath);
  const popover = document.getElementById('fileRenamePopover');
  const input = document.getElementById('fileRenameInput');
  fileRenameTarget = create ? { mode: 'create', parent: filePath } : { mode: 'rename', path: filePath };
  document.getElementById('fileRenameLabel').textContent = create ? 'NAZWA NOWEGO FOLDERU' : 'NOWA NAZWA';
  input.value = create ? '' : (row?.dataset.name || '');
  popover.hidden = false;
  popover.setAttribute('aria-hidden', 'false');
  document.body.dataset.fileRenameOpen = 'true';
  const anchor = row?.getBoundingClientRect();
  positionTTYOverlay(popover, anchor ? anchor.left : window.innerWidth / 2, anchor ? anchor.bottom : window.innerHeight / 2);
  input.focus();
  input.select();
}

function commitFileRename() {
  const input = document.getElementById('fileRenameInput');
  const name = input.value.trim();
  const target = fileRenameTarget;
  if (!target || !name) {
    hideFileRename();
    return;
  }
  hideFileRename();
  if (target.mode === 'create') {
    runFileOperation('TWORZENIE FOLDERU…', () => window.filesApi.makeDirectory(target.parent, name));
    return;
  }
  runFileOperation('ZMIANA NAZWY…', async () => {
    const result = await window.filesApi.rename(target.path, name);
    if (result?.target) setFileSelection([result.target]);
    document.body.dataset.fileRenameCount = String((Number(document.body.dataset.fileRenameCount) || 0) + 1);
    return result;
  });
}

function copyPathsToClipboard(paths) {
  const payload = paths.join('\n');
  navigator.clipboard?.writeText(payload).catch(() => {});
  setFileOperationStatus(`SKOPIOWANO ${paths.length === 1 ? 'ŚCIEŻKĘ' : `${paths.length} ŚCIEŻEK`}`);
}

function transferSelection(paths, mode) {
  runFileOperation(mode === 'copy' ? 'KOPIOWANIE…' : 'PRZENOSZENIE…', async () => {
    const choice = await window.filesApi.chooseDirectory(currentDirectoryPath());
    if (choice?.status !== 'ok') return null;
    const result = await window.filesApi.transfer(paths, choice.directory, mode);
    document.body.dataset.fileTransferCount = String((Number(document.body.dataset.fileTransferCount) || 0) + 1);
    return result;
  });
}

async function trashSelection(paths) {
  const hasDirectory = [...document.querySelectorAll('#fileList .file-row')]
    .some((row) => paths.includes(row.dataset.path) && row.dataset.type === 'directory');
  if (hasDirectory || paths.length > 1) {
    const confirmation = await window.filesApi.confirm({
      message: paths.length > 1
        ? `Przenieść ${paths.length} elementów do Kosza?`
        : 'Przenieść katalog do Kosza?',
      detail: paths.slice(0, 8).map((item) => item.split('/').pop()).join('\n'),
      confirmLabel: 'Do Kosza'
    });
    if (!confirmation?.confirmed) return;
  }
  runFileOperation('USUWANIE…', async () => {
    const result = await window.filesApi.trash(paths);
    clearFileSelection();
    document.body.dataset.fileTrashCount = String((Number(document.body.dataset.fileTrashCount) || 0) + 1);
    return result;
  });
}

function runFileContextAction(action) {
  const paths = [...fileContextPaths];
  hideFileContextMenu();
  if (paths.length === 0) return;
  const row = [...document.querySelectorAll('#fileList .file-row')].find((item) => item.dataset.path === paths[0]);
  if (action === 'open') {
    if (paths.length === 1) openFileEntry(paths[0], row?.dataset.type);
    else paths.forEach((item) => window.filesApi.open(item).catch(() => {}));
  } else if (action === 'rename') {
    beginFileRename(paths[0]);
  } else if (action === 'insert') {
    insertDroppedPaths(paths, 'browser');
  } else if (action === 'copy-path') {
    copyPathsToClipboard(paths);
  } else if (action === 'copy') {
    fileClipboard = { mode: 'copy', paths };
    updateFileStatusBar();
  } else if (action === 'move') {
    transferSelection(paths, 'move');
  } else if (action === 'reveal') {
    window.filesApi.reveal(paths[0]).catch(() => {});
  } else if (action === 'trash') {
    trashSelection(paths);
  }
}

function stopFileBrowserPolling() {
  if (fileRefreshTimer !== null) clearInterval(fileRefreshTimer);
  fileRefreshTimer = null;
}

function startFileBrowserPolling() {
  stopFileBrowserPolling();
  fileRefreshTimer = setInterval(refreshFileBrowser, 1_500);
}

function resumeLiveFileBrowser({ refresh = true } = {}) {
  browsedDirectory = null;
  fileBrowserRequestId += 1;
  fileRefreshInFlight = false;
  updateFileBrowserMode('live');
  startFileBrowserPolling();
  if (refresh) refreshFileBrowser();
}

function renderCurrentFileBrowserResult() {
  renderFileBrowser(lastFileBrowserResult);
}

function renderFileBrowser(result) {
  lastFileBrowserResult = result;
  const list = document.getElementById('fileList');
  const viewMode = document.body.dataset.fileViewMode || 'compact';
  list.classList.toggle('file-list--detailed', viewMode === 'detailed');
  list.classList.toggle('file-list--tiles', viewMode === 'tiles');
  document.getElementById('fileListColumns').hidden = viewMode !== 'detailed';
  list.replaceChildren();
  const ready = result?.status === 'ok';
  document.body.dataset.fileBrowserReady = String(ready);
  document.getElementById('fileBrowserError').hidden = ready;
  document.getElementById('fileBrowserSession').textContent = activeSessionId
    ? activeSessionId.replace('tty-', 'TTY ')
    : 'TTY --';
  document.getElementById('fileBrowserCount').textContent = ready
    ? `${result.totalCount}${result.truncated ? '+' : ''} ITEMS`
    : '-- ITEMS';
  const cwd = ready && result.cwd ? result.cwd : 'N/A';
  const cwdNode = document.getElementById('fileBrowserCwd');
  cwdNode.textContent = `CWD ${cwd}`;
  cwdNode.title = ready && result.cwd ? result.cwd : '';

  if (!ready) {
    hideImagePreview('listing-unavailable');
    clearFileSelection();
    return;
  }
  const visibleEntries = selectableEntries();
  updateSortIndicators();
  const filterCount = document.getElementById('fileFilterCount');
  filterCount.textContent = fileFilterQuery
    ? `${visibleEntries.length}/${result.entries?.length ?? 0}`
    : '';

  // Drop selected paths that no longer exist so the status bar cannot lie.
  const availablePaths = new Set((result.entries || []).map((entry) => entry.fullPath));
  for (const selected of [...fileSelection]) {
    if (!availablePaths.has(selected)) fileSelection.delete(selected);
  }

  const entries = [...visibleEntries];
  if (result.parentPath && !fileFilterQuery) {
    entries.unshift({ name: '..', fullPath: result.parentPath, type: 'directory', parent: true });
  }

  if (entries.length === 0) {
    hideImagePreview('listing-empty');
    const empty = document.createElement('li');
    empty.className = 'file-empty hud-label';
    empty.textContent = fileFilterQuery ? 'BRAK DOPASOWAN' : 'DIRECTORY EMPTY';
    list.append(empty);
    updateFileStatusBar();
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('li');
    row.className = `file-row file-row--${entry.type}`;
    if (entry.parent) row.classList.add('file-row--parent');
    row.draggable = true;
    row.dataset.path = entry.fullPath;
    row.dataset.type = entry.type;
    row.dataset.name = entry.name;
    if (isPreviewableImage(entry)) {
      row.classList.add('file-row--image');
      row.dataset.previewable = 'true';
    }
    row.title = entry.fullPath;
    const marker = document.createElement('span');
    marker.className = 'file-marker';
    marker.textContent = fileTypeMarker(entry.type);
    const icon = createFileIcon(entry);
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.parent ? '..' : `${entry.name}${entry.type === 'directory' ? '/' : ''}`;
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = entry.parent ? '' : entry.type === 'directory' ? '--' : formatFileSize(entry.sizeBytes);
    const modified = document.createElement('span');
    modified.className = 'file-modified';
    modified.textContent = entry.parent ? '' : formatFileModified(entry.modifiedMs);
    row.append(marker, icon, name, size, modified);
    list.append(row);
  });
  applySelectionClasses();
  reconcileImagePreviewRow(list);
}

async function refreshFileBrowser(directoryPath = null) {
  if (document.getElementById('filesPanel').hidden || fileRefreshInFlight) return;
  // A live refresh would rebuild the list under an open menu or rename field.
  if (fileBrowserBusy() && directoryPath === null) return;
  const requestedSessionId = activeSessionId;
  const requestedMode = fileBrowserMode;
  const requestedDirectory = requestedMode === 'browsing' ? (directoryPath || browsedDirectory) : null;
  if (!requestedSessionId) {
    renderFileBrowser(null);
    return;
  }

  const requestId = ++fileBrowserRequestId;
  fileRefreshInFlight = true;
  try {
    const result = await window.filesApi.list(requestedSessionId, requestedDirectory, showHiddenFiles);
    if (requestId !== fileBrowserRequestId || requestedSessionId !== activeSessionId
      || requestedMode !== fileBrowserMode) return;
    if (requestedMode === 'browsing' && result?.status === 'ok') browsedDirectory = result.cwd;
    renderFileBrowser(result);
  } catch {
    if (requestId === fileBrowserRequestId && requestedSessionId === activeSessionId) renderFileBrowser(null);
  } finally {
    if (requestId === fileBrowserRequestId) fileRefreshInFlight = false;
  }
}

function browseDirectory(directoryPath) {
  if (typeof directoryPath !== 'string' || directoryPath.length === 0) return;
  browsedDirectory = directoryPath;
  fileBrowserRequestId += 1;
  fileRefreshInFlight = false;
  stopFileBrowserPolling();
  updateFileBrowserMode('browsing');
  refreshFileBrowser(directoryPath);
}

function initializeFileBrowser() {
  const list = document.getElementById('fileList');
  const modeChip = document.getElementById('fileBrowserMode');
  const dotfilesToggle = document.getElementById('dotfilesToggle');

  // Finder semantics: a single click selects, a double click opens or enters.
  list.addEventListener('click', (event) => {
    const row = event.target.closest('.file-row');
    if (!row) {
      clearFileSelection();
      return;
    }
    if (row.classList.contains('file-row--parent')) {
      clearFileSelection();
      return;
    }
    handleRowSelection(row, event);
  });

  list.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.file-row');
    if (!row) return;
    openFileEntry(row.dataset.path, row.dataset.type);
  });

  list.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.file-row');
    event.preventDefault();
    if (!row || row.classList.contains('file-row--parent')) return;
    if (!fileSelection.has(row.dataset.path)) {
      fileSelectionAnchor = row.dataset.path;
      setFileSelection([row.dataset.path]);
    }
    showFileContextMenu(event.clientX, event.clientY);
  });

  list.addEventListener('pointerover', (event) => {
    const row = event.target.closest('.file-row[data-previewable="true"]');
    if (!row || row.contains(event.relatedTarget)) return;
    scheduleImagePreview(row, event.clientX, event.clientY);
  });

  list.addEventListener('pointermove', (event) => {
    const row = event.target.closest('.file-row[data-previewable="true"]');
    if (!row || row.dataset.path !== imagePreviewPath) return;
    imagePreviewCursorX = event.clientX;
    imagePreviewCursorY = event.clientY;
    positionImagePreview();
  });

  list.addEventListener('pointerout', (event) => {
    const row = event.target.closest('.file-row[data-previewable="true"]');
    if (!row || row.contains(event.relatedTarget) || row.dataset.path !== imagePreviewPath) return;
    hideImagePreview('leave');
  });

  list.addEventListener('dragstart', (event) => {
    const row = event.target.closest('.file-row');
    if (!row || !event.dataTransfer) return;
    hideImagePreview('drag');
    // Dragging a selected row carries the whole selection into the terminal.
    const dragged = fileSelection.has(row.dataset.path) && fileSelection.size > 1
      ? [...fileSelection]
      : [row.dataset.path];
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', dragged.join('\n'));
    event.dataTransfer.setData(internalFilePathMime, dragged.join('\n'));
    for (const item of document.querySelectorAll('#fileList .file-row')) {
      if (dragged.includes(item.dataset.path)) item.classList.add('is-dragging');
    }
    document.body.classList.add('file-browser-dragging');
    document.body.dataset.fileBrowserDragStarted = 'true';
  });

  list.addEventListener('dragend', (event) => {
    for (const item of document.querySelectorAll('#fileList .file-row.is-dragging')) {
      item.classList.remove('is-dragging');
    }
    document.body.classList.remove('file-browser-dragging');
  });

  modeChip.addEventListener('click', () => {
    if (fileBrowserMode === 'browsing') resumeLiveFileBrowser();
  });
  dotfilesToggle.addEventListener('click', toggleDotfiles);

  for (const button of document.querySelectorAll('.file-sort-btn')) {
    button.addEventListener('click', () => {
      const key = button.dataset.sortKey;
      if (fileSortKey === key) fileSortAscending = !fileSortAscending;
      else {
        fileSortKey = key;
        // Sizes and dates read best largest/newest first.
        fileSortAscending = key === 'name';
      }
      renderCurrentFileBrowserResult();
    });
  }

  for (const item of document.getElementById('fileContextMenu').querySelectorAll('[data-file-action]')) {
    item.addEventListener('click', () => runFileContextAction(item.dataset.fileAction));
  }

  document.getElementById('fileNewFolder').addEventListener('click', () => {
    const parent = currentDirectoryPath();
    if (parent) beginFileRename(parent, { create: true });
  });

  document.getElementById('fileFilterToggle').addEventListener('click', toggleFileFilter);

  const filterInput = document.getElementById('fileFilterInput');
  filterInput.addEventListener('input', () => {
    fileFilterQuery = filterInput.value.trim().toLowerCase();
    renderCurrentFileBrowserResult();
  });
  filterInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFileFilter();
    }
  });

  const renameInput = document.getElementById('fileRenameInput');
  renameInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      commitFileRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideFileRename();
      focusTerminal();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    const menu = document.getElementById('fileContextMenu');
    if (!menu.hidden && !menu.contains(event.target)) hideFileContextMenu();
    const popover = document.getElementById('fileRenamePopover');
    if (!popover.hidden && !popover.contains(event.target)) hideFileRename();
  }, true);

  list.addEventListener('scroll', () => hideImagePreview('scroll'), { passive: true });
  window.addEventListener('resize', positionImagePreview);
  window.addEventListener('blur', () => hideImagePreview('blur'));

  updateFileBrowserMode('live');
  updateDotfilesState();
  updateSortIndicators();
  updateFileStatusBar();
  startFileBrowserPolling();
  window.addEventListener('beforeunload', stopFileBrowserPolling, { once: true });
}

function toggleFileFilter() {
  const bar = document.getElementById('fileFilterBar');
  if (bar.hidden) openFileFilter(); else closeFileFilter();
}

function openFileFilter() {
  const bar = document.getElementById('fileFilterBar');
  bar.hidden = false;
  document.getElementById('fileFilterToggle').setAttribute('aria-pressed', 'true');
  document.getElementById('fileFilterInput').focus();
}

function closeFileFilter() {
  const bar = document.getElementById('fileFilterBar');
  bar.hidden = true;
  document.getElementById('fileFilterToggle').setAttribute('aria-pressed', 'false');
  document.getElementById('fileFilterInput').value = '';
  fileFilterQuery = '';
  renderCurrentFileBrowserResult();
  focusTerminal();
}

// Keyboard control for the file panel. Only active while the panel is open and the
// terminal does not own the keystroke (the shell keeps priority for plain typing).
function handleFileBrowserKeydown(event) {
  const panel = document.getElementById('filesPanel');
  if (panel.hidden || bootActive) return;
  if (!document.getElementById('fileRenamePopover').hidden) return;
  const filterFocused = document.activeElement === document.getElementById('fileFilterInput');

  // ⌘F is shared with terminal search (initializeControls): only claim it here
  // when focus is actually inside FILES — otherwise fall through unhandled so
  // the terminal search shortcut gets it, matching iTerm2-style expectations.
  if (event.metaKey && !event.altKey && !event.ctrlKey && event.code === 'KeyF') {
    if (!panel.contains(document.activeElement)) return;
    event.preventDefault();
    event.stopPropagation();
    openFileFilter();
    return;
  }
  if (event.metaKey && event.shiftKey && event.code === 'KeyN') {
    event.preventDefault();
    event.stopPropagation();
    const parent = currentDirectoryPath();
    if (parent) beginFileRename(parent, { create: true });
    return;
  }
  if (event.key === 'Escape' && !document.getElementById('fileContextMenu').hidden) {
    event.preventDefault();
    hideFileContextMenu();
    return;
  }
  if (filterFocused) return;

  const paths = [...fileSelection];
  if (event.metaKey && !event.shiftKey && event.code === 'KeyA') {
    event.preventDefault();
    event.stopPropagation();
    setFileSelection(selectableEntries().map((entry) => entry.fullPath));
    return;
  }
  if (event.metaKey && event.altKey && event.code === 'KeyC' && paths.length) {
    event.preventDefault();
    copyPathsToClipboard(paths);
    return;
  }
  if (event.metaKey && !event.altKey && event.code === 'KeyC' && paths.length) {
    event.preventDefault();
    fileClipboard = { mode: 'copy', paths };
    updateFileStatusBar();
    return;
  }
  if (event.metaKey && event.code === 'KeyV' && fileClipboard) {
    event.preventDefault();
    const destination = currentDirectoryPath();
    const payload = fileClipboard;
    if (!destination) return;
    runFileOperation('WKLEJANIE…', () => window.filesApi.transfer(payload.paths, destination, payload.mode));
    return;
  }
  // ⌥⌘↑ belongs to pane navigation, so the plain ⌘↑ shortcut must not swallow it.
  if (event.metaKey && !event.altKey && event.code === 'ArrowUp') {
    event.preventDefault();
    const parentPath = lastFileBrowserResult?.parentPath;
    if (parentPath) {
      clearFileSelection();
      browseDirectory(parentPath);
    }
    return;
  }
  if (paths.length === 0) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    clearFileSelection();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const row = [...document.querySelectorAll('#fileList .file-row')].find((item) => item.dataset.path === paths[0]);
    openFileEntry(paths[0], row?.dataset.type);
  } else if (event.key === 'Backspace' || event.key === 'Delete') {
    event.preventDefault();
    trashSelection(paths);
  }
}

let terminalFitFrame = null;
let terminalFocusRequested = false;

// The layout tree lives in the DOM: a `.terminal-split` always holds exactly
// two children (pane or nested split) separated by one `.terminal-splitter`,
// so closing a pane collapses by hoisting the surviving sibling.
function createSplitter(direction) {
  const splitter = document.createElement('div');
  splitter.className = 'terminal-splitter';
  splitter.dataset.direction = direction;
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', direction === 'row' ? 'vertical' : 'horizontal');
  splitter.addEventListener('pointerdown', beginSplitterDrag);
  return splitter;
}

function beginSplitterDrag(event) {
  const splitter = event.currentTarget;
  const split = splitter.parentElement;
  const before = splitter.previousElementSibling;
  const after = splitter.nextElementSibling;
  if (!split || !before || !after) return;
  const horizontal = split.dataset.direction === 'row';
  const rect = split.getBoundingClientRect();
  const total = horizontal ? rect.width : rect.height;
  if (total <= 0) return;
  event.preventDefault();
  splitter.setPointerCapture(event.pointerId);
  splitter.dataset.dragging = 'true';
  const minRatio = 0.12;

  const onMove = (moveEvent) => {
    const offset = horizontal ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top;
    const ratio = Math.min(1 - minRatio, Math.max(minRatio, offset / total));
    before.style.flex = `${ratio} 1 0`;
    after.style.flex = `${1 - ratio} 1 0`;
  };
  const onEnd = () => {
    splitter.removeEventListener('pointermove', onMove);
    splitter.removeEventListener('pointerup', onEnd);
    splitter.removeEventListener('pointercancel', onEnd);
    delete splitter.dataset.dragging;
    document.body.dataset.paneResizeCount = String((Number(document.body.dataset.paneResizeCount) || 0) + 1);
    fitActiveTerminal();
  };
  splitter.addEventListener('pointermove', onMove);
  splitter.addEventListener('pointerup', onEnd);
  splitter.addEventListener('pointercancel', onEnd);
}

// Replace `container` in place with a split holding it and the new pane.
function splitPaneContainer(container, newContainer, direction) {
  const parent = container.parentElement;
  if (!parent) return;
  const split = document.createElement('div');
  split.className = 'terminal-split';
  split.dataset.direction = direction;
  split.style.flex = container.style.flex || '1 1 0';
  parent.insertBefore(split, container);
  container.style.flex = '1 1 0';
  newContainer.style.flex = '1 1 0';
  split.append(container, createSplitter(direction), newContainer);
}

function removePaneContainer(container) {
  const parent = container.parentElement;
  container.remove();
  if (!parent || !parent.classList.contains('terminal-split')) return;
  parent.querySelectorAll(':scope > .terminal-splitter').forEach((splitter) => splitter.remove());
  const survivor = parent.firstElementChild;
  if (!survivor) {
    parent.remove();
    return;
  }
  survivor.style.flex = parent.style.flex || '1 1 0';
  parent.replaceWith(survivor);
}

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

// Search highlights are painted in the theme's accent, matching the HUD
// chrome rather than the terminal's own (independently chosen) text color —
// decorations need plain #RRGGBB, so read the resolved custom properties.
function terminalSearchDecorations() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  const dim = token('--cyan-dim', '#087f9c');
  const cyan = token('--cyan', '#00e5ff');
  const bright = token('--cyan-bright', '#8ff8ff');
  return {
    matchBackground: dim,
    matchBorder: cyan,
    matchOverviewRuler: cyan,
    activeMatchBackground: cyan,
    activeMatchBorder: bright,
    activeMatchColorOverviewRuler: bright
  };
}

function terminalSearchOptions(extra = {}) {
  return { decorations: terminalSearchDecorations(), ...extra };
}

function positionTerminalSearchBar() {
  const session = terminalSessions.get(terminalSearchSessionId);
  const bar = document.getElementById('terminalSearchBar');
  if (!session || !session.container.isConnected) return;
  const rect = session.container.getBoundingClientRect();
  bar.style.left = `${Math.round(rect.left)}px`;
  bar.style.top = `${Math.round(rect.top)}px`;
  bar.style.width = `${Math.round(rect.width)}px`;
}

function updateTerminalSearchCount(resultIndex, resultCount) {
  const bar = document.getElementById('terminalSearchBar');
  const hasQuery = document.getElementById('terminalSearchInput').value.length > 0;
  document.getElementById('terminalSearchCount').textContent = resultCount > 0 ? `${resultIndex + 1}/${resultCount}` : '0/0';
  bar.classList.toggle('is-empty', hasQuery && resultCount === 0);
}

function runTerminalSearch(direction = 'next', extra = {}) {
  const session = terminalSessions.get(terminalSearchSessionId);
  const input = document.getElementById('terminalSearchInput');
  if (!session) return;
  const term = input.value;
  if (!term) {
    session.searchAddon.clearDecorations();
    updateTerminalSearchCount(-1, 0);
    return;
  }
  const method = direction === 'prev' ? 'findPrevious' : 'findNext';
  session.searchAddon[method](term, terminalSearchOptions(extra));
}

// One shared bar bound to whichever pane was active when it opened — switching
// panes closes it (see switchTerminalSession/handleTerminalExit) rather than
// tracking per-pane state, which keeps this simple like iTerm2's own find bar.
function openTerminalSearch() {
  const session = terminalSessions.get(activeSessionId);
  if (!session) return;
  terminalSearchSessionId = activeSessionId;
  const bar = document.getElementById('terminalSearchBar');
  bar.hidden = false;
  bar.setAttribute('aria-hidden', 'false');
  positionTerminalSearchBar();
  const input = document.getElementById('terminalSearchInput');
  input.focus();
  input.select();
  if (input.value) runTerminalSearch('next', { incremental: true });
}

function closeTerminalSearch({ refocusTerminal = true } = {}) {
  const bar = document.getElementById('terminalSearchBar');
  if (bar.hidden) return;
  bar.hidden = true;
  bar.setAttribute('aria-hidden', 'true');
  bar.classList.remove('is-empty');
  terminalSessions.get(terminalSearchSessionId)?.searchAddon.clearDecorations();
  terminalSearchSessionId = null;
  if (refocusTerminal) focusTerminal();
}

function initializeTerminalSearch() {
  const input = document.getElementById('terminalSearchInput');
  input.addEventListener('input', () => runTerminalSearch('next', { incremental: true }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runTerminalSearch(event.shiftKey ? 'prev' : 'next');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeTerminalSearch();
    }
  });
  document.getElementById('terminalSearchNext').addEventListener('click', () => runTerminalSearch('next'));
  document.getElementById('terminalSearchPrev').addEventListener('click', () => runTerminalSearch('prev'));
  document.getElementById('terminalSearchClose').addEventListener('click', () => closeTerminalSearch());
  window.themeApi?.onChange(() => {
    if (!document.getElementById('terminalSearchBar').hidden) runTerminalSearch('next', { incremental: true });
  });
}

// Geometric navigation beats tree walking here: it does the right thing for
// any nesting depth, the same way ⌥⌘arrows behave in iTerm2.
function focusPaneInDirection(direction) {
  const current = terminalSessions.get(activeSessionId);
  if (!current) return;
  const source = current.container.getBoundingClientRect();
  const sourceX = source.left + source.width / 2;
  const sourceY = source.top + source.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const session of visibleSessions()) {
    if (session === current) continue;
    const rect = session.container.getBoundingClientRect();
    const deltaX = rect.left + rect.width / 2 - sourceX;
    const deltaY = rect.top + rect.height / 2 - sourceY;
    const along = direction === 'left' ? -deltaX
      : direction === 'right' ? deltaX
        : direction === 'up' ? -deltaY : deltaY;
    if (along <= 1) continue;
    const across = direction === 'left' || direction === 'right' ? Math.abs(deltaY) : Math.abs(deltaX);
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = session;
    }
  }
  if (!best) return;
  switchTerminalSession(best.id);
  document.body.dataset.paneNavigationCount = String((Number(document.body.dataset.paneNavigationCount) || 0) + 1);
}

async function splitActivePane(direction) {
  const session = terminalSessions.get(activeSessionId);
  if (!session) return null;
  return createTerminalSession({ tabId: session.tabId, splitFrom: session.id, direction });
}

function closeActivePane() {
  if (activeSessionId) closeTTYSession(activeSessionId);
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

function updateClock() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  document.getElementById('clockHours').textContent = `${hours}:${minutes}`;
  document.getElementById('clockSeconds').textContent = `:${seconds}`;
  document.getElementById('hudClock').dateTime = now.toISOString();
  document.getElementById('hudDate').textContent = date;
  document.getElementById('hudDate').dateTime = date;
}

function initializeControls() {
  updateScanlines(readSetting(storageKeys.scanlines));
  updateSound(soundEnabled, false);
  document.getElementById('scanlinesToggle').addEventListener('click', toggleScanlines);
  document.getElementById('soundToggle').addEventListener('click', toggleSound);
  document.getElementById('systemGroupToggle').addEventListener('click', toggleSystemGroup);
  initializeProcessSort();
  initializeTerminalSearch();
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
      focusPaneInDirection(direction);
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

function positionTTYOverlay(element, anchorX, anchorY, offset = 6) {
  const margin = 8;
  const rect = element.getBoundingClientRect();
  let left = anchorX + offset;
  let top = anchorY + offset;
  if (left + rect.width > window.innerWidth - margin) left = anchorX - rect.width - offset;
  if (top + rect.height > window.innerHeight - margin) top = anchorY - rect.height - offset;
  left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - rect.width - margin));
  top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - rect.height - margin));
  element.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function hideTTYContextMenu() {
  const menu = document.getElementById('ttyContextMenu');
  menu.hidden = true;
  menu.setAttribute('aria-hidden', 'true');
  ttyContextSessionId = null;
  document.body.dataset.ttyContextMenuOpen = 'false';
}

function hideTTYRename() {
  const popover = document.getElementById('ttyRenamePopover');
  popover.hidden = true;
  popover.setAttribute('aria-hidden', 'true');
  ttyRenameSessionId = null;
  document.body.dataset.ttyRenameOpen = 'false';
}

function paneLabel(session) {
  return session.manualName || session.autoContext || '~';
}

// An unsplit tab carries the name itself; a split one hands the names over to
// its pane chips and keeps only the number.
function renderTabLabel(tabId) {
  const tab = terminalTabs.get(tabId);
  if (!tab) return;
  const sessions = tabSessions(tabId);
  const session = terminalSessions.get(tab.activePaneId) || sessions[0] || null;
  const split = sessions.length > 1;
  const context = session ? paneLabel(session) : '~';
  const contextElement = tab.button.querySelector('.tty-context');
  contextElement.textContent = context;
  contextElement.hidden = split;
  tab.button.dataset.context = context;
  tab.button.dataset.manualName = session?.manualName || '';
  tab.button.dataset.sessionId = session?.id || '';
  tab.button.dataset.paneCount = String(sessions.length);
  tab.button.title = session ? session.manualName || session.autoTitle || context : context;
  renderPaneChips(tab, sessions, split);
}

function createPaneChip(sessionId) {
  const chip = document.createElement('button');
  chip.className = 'tty-pane-chip hud-label';
  chip.type = 'button';
  chip.dataset.sessionId = sessionId;
  const branch = document.createElement('span');
  branch.className = 'tty-pane-branch';
  branch.textContent = '├';
  branch.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'tty-pane-name';
  chip.append(branch, name);
  chip.addEventListener('click', () => switchTerminalSession(sessionId));
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showTTYContextMenu(sessionId, event.clientX, event.clientY);
  });
  return chip;
}

// Chips are reused across metadata ticks — rebuilding them every second would
// drop the focus ring mid-click.
function renderPaneChips(tab, sessions, split) {
  const existing = new Map([...tab.group.querySelectorAll('.tty-pane-chip')]
    .map((chip) => [chip.dataset.sessionId, chip]));
  if (!split) {
    existing.forEach((chip) => chip.remove());
    sessions.forEach((session) => { session.chip = null; });
    return;
  }
  let previous = tab.button;
  for (const session of sessions) {
    let chip = existing.get(session.id);
    if (chip) existing.delete(session.id);
    else chip = createPaneChip(session.id);
    if (previous.nextElementSibling !== chip) previous.after(chip);
    previous = chip;
    const label = paneLabel(session);
    chip.querySelector('.tty-pane-name').textContent = label;
    chip.title = session.manualName || session.autoTitle || label;
    chip.dataset.manualName = session.manualName || '';
    chip.classList.toggle('is-active', session.id === tab.activePaneId);
    chip.setAttribute('aria-pressed', String(session.id === tab.activePaneId));
    session.chip = chip;
  }
  existing.forEach((chip) => chip.remove());
}

function renderTerminalTabLabel(session) {
  if (session) renderTabLabel(session.tabId);
}

function showTTYContextMenu(sessionId, clientX, clientY) {
  const session = terminalSessions.get(sessionId);
  if (!session || session.closing) return;
  hideTTYRename();
  const menu = document.getElementById('ttyContextMenu');
  const autoName = menu.querySelector('[data-action="auto-name"]');
  ttyContextSessionId = sessionId;
  autoName.hidden = !session.manualName;
  menu.hidden = false;
  menu.setAttribute('aria-hidden', 'false');
  document.body.dataset.ttyContextMenuOpen = 'true';
  document.body.dataset.ttyContextSessionId = sessionId;
  positionTTYOverlay(menu, clientX, clientY);
  menu.querySelector('[data-action="rename"]').focus({ preventScroll: true });
}

function beginTTYRename(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session || session.closing) return;
  hideTTYContextMenu();
  ttyRenameSessionId = sessionId;
  const popover = document.getElementById('ttyRenamePopover');
  const input = document.getElementById('ttyRenameInput');
  const tabRect = (session.chip || session.tab).getBoundingClientRect();
  input.value = (session.manualName || session.autoContext || '').slice(0, 24);
  popover.hidden = false;
  popover.setAttribute('aria-hidden', 'false');
  document.body.dataset.ttyRenameOpen = 'true';
  positionTTYOverlay(popover, tabRect.left, tabRect.bottom, 5);
  input.focus({ preventScroll: true });
  input.select();
}

function commitTTYRename() {
  const session = terminalSessions.get(ttyRenameSessionId);
  if (!session) {
    hideTTYRename();
    return;
  }
  const input = document.getElementById('ttyRenameInput');
  const manualName = input.value.trim().replace(/\s+/g, ' ').slice(0, 24).trimEnd();
  session.manualName = manualName || null;
  renderTerminalTabLabel(session);
  document.body.dataset.ttyRenameCount = String((Number(document.body.dataset.ttyRenameCount) || 0) + 1);
  document.body.dataset.ttyLastRenamedSession = session.id;
  document.body.dataset.ttyLastManualName = session.manualName || '';
  hideTTYRename();
  focusTerminal();
}

function resetTTYName(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  session.manualName = null;
  renderTerminalTabLabel(session);
  document.body.dataset.ttyAutoNameResetCount = String(
    (Number(document.body.dataset.ttyAutoNameResetCount) || 0) + 1
  );
  hideTTYContextMenu();
  focusTerminal();
}

function closeTTYSession(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session || session.closing) return;
  session.closing = true;
  // Only the last pane takes its tab down with it, so keep the tab clickable
  // while siblings survive — the closing pane's own chip is what greys out.
  if (tabSessions(session.tabId).length === 1) session.tab.disabled = true;
  else if (session.chip) session.chip.disabled = true;
  document.body.dataset.ttyContextCloseCount = String(
    (Number(document.body.dataset.ttyContextCloseCount) || 0) + 1
  );
  document.body.dataset.ttyLastClosedSession = sessionId;
  hideTTYContextMenu();
  hideTTYRename();
  window.terminalApi.close(sessionId);
}

function initializeTTYContextMenu() {
  const menu = document.getElementById('ttyContextMenu');
  const input = document.getElementById('ttyRenameInput');

  menu.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const sessionId = ttyContextSessionId;
    if (!action || !sessionId) return;
    if (action === 'rename') beginTTYRename(sessionId);
    else if (action === 'auto-name') resetTTYName(sessionId);
    else if (action === 'close') closeTTYSession(sessionId);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    commitTTYRename();
  });

  document.addEventListener('pointerdown', (event) => {
    if (menu.contains(event.target) || document.getElementById('ttyRenamePopover').contains(event.target)) return;
    hideTTYContextMenu();
    hideTTYRename();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || (ttyContextSessionId === null && ttyRenameSessionId === null)) return;
    event.preventDefault();
    event.stopPropagation();
    hideTTYContextMenu();
    hideTTYRename();
    focusTerminal();
  }, true);

  window.addEventListener('resize', () => {
    hideTTYContextMenu();
    hideTTYRename();
  });
}

function switchTerminalSession(sessionId) {
  const nextSession = terminalSessions.get(sessionId);
  if (!nextSession) return;
  const sessionChanged = sessionId !== activeSessionId;
  const resumedFromBrowsing = sessionChanged && fileBrowserMode === 'browsing';
  if (sessionChanged && terminalSearchSessionId && terminalSearchSessionId !== sessionId) {
    closeTerminalSearch({ refocusTerminal: false });
  }
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

  if (ttyContextSessionId === sessionId) hideTTYContextMenu();
  if (ttyRenameSessionId === sessionId) hideTTYRename();
  if (terminalSearchSessionId === sessionId) closeTerminalSearch({ refocusTerminal: false });

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
  });
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
    scrollback: 10_000,
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
    failed: false
  };
  terminalSessions.set(sessionId, session);
  searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (terminalSearchSessionId === sessionId) updateTerminalSearchCount(resultIndex, resultCount);
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
