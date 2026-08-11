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
const terminalSessions = new Map();
let activeSessionId = null;
let nextSessionNumber = 1;
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
  networkUp: []
};
const imagePreviewCache = new Map();
let imagePreviewCacheChars = 0;

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

function renderProcesses(processes) {
  const list = document.getElementById('processList');
  list.replaceChildren();
  if (!Array.isArray(processes) || processes.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'process-empty hud-label';
    empty.textContent = 'PROCESS DATA N/A';
    list.append(empty);
    return;
  }

  processes.slice(0, 6).forEach((processInfo, index) => {
    const row = document.createElement('li');
    row.className = 'process-row';

    const rank = document.createElement('span');
    rank.className = 'process-rank';
    rank.textContent = String(index + 1).padStart(2, '0');

    const name = document.createElement('span');
    name.className = 'process-name';
    name.textContent = typeof processInfo.name === 'string' ? processInfo.name : 'UNKNOWN';
    name.title = name.textContent;

    const cpu = document.createElement('span');
    cpu.className = 'process-cpu';
    cpu.textContent = formatPercent(processInfo.cpuPercent, 1);

    row.append(rank, name, cpu);
    list.append(row);
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
  document.getElementById('memoryUsed').textContent = formatCapacity(sample.memory?.usedBytes);
  document.getElementById('memoryAvailable').textContent = formatCapacity(sample.memory?.availableBytes);
  setMeter('memoryMeter', sample.memory?.usePercent);
  setWarningState(document.getElementById('memoryValue'), numeric(sample.memory?.usePercent) > 90);

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
  renderProcesses(sample.processes);

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

function renderFileBrowser(result) {
  const list = document.getElementById('fileList');
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
    return;
  }
  const entries = Array.isArray(result.entries) ? [...result.entries] : [];
  if (result.parentPath) {
    entries.unshift({ name: '..', fullPath: result.parentPath, type: 'directory', parent: true });
  }

  if (entries.length === 0) {
    hideImagePreview('listing-empty');
    const empty = document.createElement('li');
    empty.className = 'file-empty hud-label';
    empty.textContent = 'DIRECTORY EMPTY';
    list.append(empty);
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
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.parent ? '..' : `${entry.name}${entry.type === 'directory' ? '/' : ''}`;
    row.append(marker, name);
    list.append(row);
  });
  reconcileImagePreviewRow(list);
}

async function refreshFileBrowser(directoryPath = null) {
  if (document.body.classList.contains('files-group-hidden') || fileRefreshInFlight) return;
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

  list.addEventListener('click', (event) => {
    const row = event.target.closest('.file-row');
    if (!row || row.dataset.type !== 'directory') return;
    browseDirectory(row.dataset.path);
  });

  list.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.file-row');
    if (!row || row.dataset.type === 'directory') return;
    insertDroppedPaths([row.dataset.path], 'browser');
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
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', row.dataset.path);
    event.dataTransfer.setData(internalFilePathMime, row.dataset.path);
    row.classList.add('is-dragging');
    document.body.classList.add('file-browser-dragging');
    document.body.dataset.fileBrowserDragStarted = 'true';
  });

  list.addEventListener('dragend', (event) => {
    event.target.closest('.file-row')?.classList.remove('is-dragging');
    document.body.classList.remove('file-browser-dragging');
  });

  modeChip.addEventListener('click', () => {
    if (fileBrowserMode === 'browsing') resumeLiveFileBrowser();
  });
  dotfilesToggle.addEventListener('click', toggleDotfiles);

  list.addEventListener('scroll', () => hideImagePreview('scroll'), { passive: true });
  window.addEventListener('resize', positionImagePreview);
  window.addEventListener('blur', () => hideImagePreview('blur'));

  updateFileBrowserMode('live');
  updateDotfilesState();
  startFileBrowserPolling();
  window.addEventListener('beforeunload', stopFileBrowserPolling, { once: true });
}

function focusTerminal() {
  const session = terminalSessions.get(activeSessionId);
  if (session) {
    requestAnimationFrame(() => {
      session.fitAddon.fit();
      session.terminal.focus();
    });
  }
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
    const filePath = dataTransfer.getData(internalFilePathMime) || dataTransfer.getData('text/plain');
    return typeof filePath === 'string' && filePath.length > 0 ? [filePath] : [];
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

function dataVisibilityState() {
  const systemVisible = !document.body.classList.contains('system-group-hidden');
  const filesVisible = !document.body.classList.contains('files-group-hidden');
  if (systemVisible && filesVisible) return 'both';
  if (systemVisible) return 'system-only';
  if (filesVisible) return 'files-only';
  return 'none';
}

function recordDataVisibilityState() {
  const state = dataVisibilityState();
  document.body.dataset.dataVisibilityState = state;
  if (!isVisualTest) return;

  const visited = new Set((document.body.dataset.dataVisibilityStates || '').split(',').filter(Boolean));
  visited.add(state);
  document.body.dataset.dataVisibilityStates = [...visited].join(',');

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const samples = JSON.parse(document.body.dataset.dataVisibilityGeometry || '{}');
    samples[state] = {
      panelVisible: getComputedStyle(document.getElementById('telemetryPanel')).display !== 'none',
      systemVisible: getComputedStyle(document.getElementById('systemGroup')).display !== 'none',
      filesVisible: getComputedStyle(document.querySelector('.files-section')).display !== 'none',
      terminalWidth: document.querySelector('.terminal-panel').getBoundingClientRect().width,
      terminalScreenWidth: document.querySelector('.terminal-instance:not([hidden]) .xterm-screen')?.getBoundingClientRect().width || 0,
      fileListHeight: document.getElementById('fileList').clientHeight,
      visibleProcessCount: [...document.querySelectorAll('#processList .process-row')]
        .filter((row) => row.getClientRects().length > 0).length
    };
    document.body.dataset.dataVisibilityGeometry = JSON.stringify(samples);
  }));
}

function syncDataPanelVisibility() {
  const systemVisible = !document.body.classList.contains('system-group-hidden');
  const filesVisible = !document.body.classList.contains('files-group-hidden');
  document.body.classList.toggle('telemetry-panel-hidden', !systemVisible && !filesVisible);
  recordDataVisibilityState();
  if (filesVisible) refreshFileBrowser();
  focusTerminal();
}

function updateDataGroupVisibility(group, visible) {
  const isSystem = group === 'system';
  const hiddenClass = isSystem ? 'system-group-hidden' : 'files-group-hidden';
  const button = document.getElementById(isSystem ? 'systemGroupToggle' : 'filesGroupToggle');
  const state = document.getElementById(isSystem ? 'systemGroupState' : 'filesGroupState');
  const counter = isSystem ? 'systemToggleCount' : 'filesToggleCount';
  document.body.dataset[counter] = String((Number(document.body.dataset[counter]) || 0) + 1);
  document.body.classList.toggle(hiddenClass, !visible);
  button.classList.toggle('is-on', visible);
  button.setAttribute('aria-pressed', String(visible));
  state.textContent = visible ? 'ON' : 'OFF';
  syncDataPanelVisibility();
}

function toggleDataGroup(group) {
  const hiddenClass = group === 'system' ? 'system-group-hidden' : 'files-group-hidden';
  updateDataGroupVisibility(group, document.body.classList.contains(hiddenClass));
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
  document.getElementById('systemGroupToggle').addEventListener('click', () => toggleDataGroup('system'));
  document.getElementById('filesGroupToggle').addEventListener('click', () => toggleDataGroup('files'));
  syncDataPanelVisibility();
  updateClock();
  const clockTimer = setInterval(updateClock, 1_000);
  window.addEventListener('beforeunload', () => clearInterval(clockTimer), { once: true });

  document.addEventListener('keydown', (event) => {
    if (bootActive || !event.metaKey || event.altKey || event.ctrlKey) return;
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
      && !document.body.classList.contains('files-group-hidden')) {
      event.preventDefault();
      event.stopPropagation();
      toggleDotfiles();
      return;
    }
    if (event.shiftKey) return;
    if (event.code === 'Digit1') {
      event.preventDefault();
      event.stopPropagation();
      toggleDataGroup('system');
    } else if (event.code === 'Digit2') {
      event.preventDefault();
      event.stopPropagation();
      toggleDataGroup('files');
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

function renderTerminalTabLabel(session) {
  if (!session) return;
  const context = session.manualName || session.autoContext || '~';
  session.tab.querySelector('.tty-context').textContent = context;
  session.tab.dataset.context = context;
  session.tab.dataset.manualName = session.manualName || '';
  session.tab.title = session.manualName || session.autoTitle || context;
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
  const tabRect = session.tab.getBoundingClientRect();
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
  session.tab.disabled = true;
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
  activeSessionId = sessionId;
  if (sessionChanged) resumeLiveFileBrowser({ refresh: false });
  if (resumedFromBrowsing) document.body.dataset.fileBrowserTabResumeObserved = 'true';
  for (const [id, session] of terminalSessions) {
    const active = id === sessionId;
    session.container.hidden = !active;
    session.tab.classList.toggle('is-active', active);
    session.tab.setAttribute('aria-selected', String(active));
    session.tab.tabIndex = active ? 0 : -1;
  }
  window.terminalApi.setActive(sessionId);
  updateShellStatus();
  refreshFileBrowser();
  focusTerminal();
}

function handleTerminalExit(sessionId) {
  const session = terminalSessions.get(sessionId);
  if (!session) return;
  const sessionOrder = [...terminalSessions.keys()];
  const exitIndex = sessionOrder.indexOf(sessionId);
  const wasActive = sessionId === activeSessionId;

  if (ttyContextSessionId === sessionId) hideTTYContextMenu();
  if (ttyRenameSessionId === sessionId) hideTTYRename();

  terminalSessions.delete(sessionId);
  session.tab.remove();
  session.terminal.dispose();
  session.container.remove();
  document.body.dataset.terminalExitCount = String((Number(document.body.dataset.terminalExitCount) || 0) + 1);

  if (isSmokeTest && !smokeCompleted) {
    smokeCompleted = true;
    window.terminalApi.reportSmokeResult(false);
    return;
  }
  if (rendererShuttingDown) return;

  const remainingIds = [...terminalSessions.keys()];
  if (remainingIds.length > 0) {
    if (wasActive) switchTerminalSession(remainingIds[Math.min(exitIndex, remainingIds.length - 1)]);
    else refreshFileBrowser();
    return;
  }

  activeSessionId = null;
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
    session.tab.dataset.processName = metadata.processName || '';
    if (metadata.processName === 'top') document.body.dataset.ttyTopObserved = 'true';
  });
}

function createTerminalTab(sessionId, sessionNumber) {
  const tab = document.createElement('button');
  tab.className = 'tty-tab hud-label';
  tab.type = 'button';
  tab.id = `${sessionId}-tab`;
  tab.dataset.sessionId = sessionId;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', `${sessionId}-panel`);
  const index = document.createElement('span');
  index.className = 'tty-index';
  index.textContent = String(sessionNumber).padStart(2, '0');
  const context = document.createElement('span');
  context.className = 'tty-context';
  context.textContent = '~';
  tab.append(index, context);
  tab.addEventListener('click', () => switchTerminalSession(sessionId));
  tab.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showTTYContextMenu(sessionId, event.clientX, event.clientY);
  });
  document.getElementById('ttyTabs').append(tab);
  return tab;
}

async function createTerminalSession() {
  if (terminalSessions.size >= maxTerminalSessions) {
    terminalSessions.get(activeSessionId)?.terminal.write('\r\n[TTY LIMIT: 8]\r\n');
    return null;
  }

  const sessionNumber = nextSessionNumber;
  nextSessionNumber += 1;
  const sessionId = `tty-${String(sessionNumber).padStart(2, '0')}`;
  const label = `TTY ${String(sessionNumber).padStart(2, '0')}`;
  const container = document.createElement('div');
  container.className = 'terminal-instance';
  container.id = `${sessionId}-panel`;
  container.setAttribute('role', 'tabpanel');
  container.setAttribute('aria-labelledby', `${sessionId}-tab`);
  container.setAttribute('aria-label', `${label}, terminal zsh`);
  document.getElementById('terminalSessions').append(container);

  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: '"Monaspace Neon NF", "SF Mono", Menlo, monospace',
    fontSize: 14,
    fontWeight: '400',
    letterSpacing: 0.2,
    lineHeight: 1.16,
    scrollback: 10_000,
    theme: terminalTheme
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();
  const session = {
    id: sessionId,
    terminal,
    fitAddon,
    container,
    tab: createTerminalTab(sessionId, sessionNumber),
    autoContext: '~',
    autoTitle: '~',
    manualName: null,
    closing: false,
    online: false,
    failed: false
  };
  terminalSessions.set(sessionId, session);
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

  const resizeObserver = new ResizeObserver(() => focusTerminal());
  resizeObserver.observe(document.querySelector('.terminal-surface'));
  window.addEventListener('beforeunload', () => {
    rendererShuttingDown = true;
    resizeObserver.disconnect();
  }, { once: true });
  await createTerminalSession();
}

initializeAudio();
initializeBoot();
initializeControls();
initializeTTYContextMenu();
initializeFileBrowser();
initializeFileDrop();
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
