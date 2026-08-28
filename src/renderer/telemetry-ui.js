'use strict';

/* exported
  PROCESS_LIST_LIMIT, formatCapacity, formatPercent, formatProcessValue, formatRate,
  formatUptime, initializeMonitoring, initializeProcessSort, lastProcesses, numeric,
  processSortKey, pushHistory, renderCoreLoads, renderMonitoring, renderProcesses, setMeter,
  setProcessSortKey, setStackedMeter, setWarningState, sortProcesses, sparklinePoints,
  telemetryHistory, updateClock
*/

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

// Node-only export for unit tests (test/renderer/telemetry-ui.test.js). This
// file stays a plain global-scope <script> in the browser — `module` is
// undefined there, so this block never runs and browser behavior is
// unchanged. Only the pure, DOM-free functions are exported.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    numeric,
    formatPercent,
    formatCapacity,
    formatRate,
    formatUptime,
    sparklinePoints,
    pushHistory,
    sortProcesses
  };
}
