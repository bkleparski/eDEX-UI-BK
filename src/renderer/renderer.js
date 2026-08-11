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
const dropTestMime = 'application/x-edex-ui-bk-test-paths';
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
let fileDragDepth = 0;
let dropTestOutput = '';
let rendererShuttingDown = false;
const telemetryHistory = {
  cpu: [],
  networkDown: [],
  networkUp: []
};

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

  if (!ready) return;
  if (!Array.isArray(result.entries) || result.entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'file-empty hud-label';
    empty.textContent = 'DIRECTORY EMPTY';
    list.append(empty);
    return;
  }

  result.entries.forEach((entry) => {
    const row = document.createElement('li');
    row.className = `file-row file-row--${entry.type}`;
    const marker = document.createElement('span');
    marker.className = 'file-marker';
    marker.textContent = fileTypeMarker(entry.type);
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = `${entry.name}${entry.type === 'directory' ? '/' : ''}`;
    name.title = entry.name;
    row.append(marker, name);
    list.append(row);
  });
}

async function refreshFileBrowser() {
  if (document.body.classList.contains('files-group-hidden') || fileRefreshInFlight) return;
  const requestedSessionId = activeSessionId;
  if (!requestedSessionId) {
    renderFileBrowser(null);
    return;
  }

  fileRefreshInFlight = true;
  try {
    const result = await window.filesApi.list(requestedSessionId);
    if (requestedSessionId === activeSessionId) renderFileBrowser(result);
  } catch {
    if (requestedSessionId === activeSessionId) renderFileBrowser(null);
  } finally {
    fileRefreshInFlight = false;
  }
}

function initializeFileBrowser() {
  fileRefreshTimer = setInterval(refreshFileBrowser, 1_500);
  window.addEventListener('beforeunload', () => clearInterval(fileRefreshTimer), { once: true });
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
  return types.includes('Files') || (isVisualTest && types.includes(dropTestMime));
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
}

function insertDroppedPaths(paths) {
  const session = terminalSessions.get(activeSessionId);
  if (!session?.online || paths.length === 0) return false;
  const payload = `${paths.map(quoteShellPath).join(' ')} `;
  window.terminalApi.write(activeSessionId, payload);
  document.body.dataset.dropPathCount = String(paths.length);
  document.body.dataset.dropSessionId = activeSessionId;
  document.body.dataset.dropQuotedPayload = payload;
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
    const paths = droppedFilePaths(event.dataTransfer);
    clearFileDropTarget();
    insertDroppedPaths(paths);
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

function switchTerminalSession(sessionId) {
  const nextSession = terminalSessions.get(sessionId);
  if (!nextSession) return;
  activeSessionId = sessionId;
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
    session.tab.querySelector('.tty-context').textContent = context;
    session.tab.dataset.processName = metadata.processName || '';
    session.tab.dataset.context = context;
    session.tab.title = metadata.idle ? metadata.cwd || metadata.command || context : metadata.command || context;
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
      window.terminalApi.write(sessionId, `printf '${smokeMarker}\\n'\r`);
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
