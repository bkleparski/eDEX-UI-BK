'use strict';

// System telemetry collection — CPU/RAM/disk/network/processes via
// `systeminformation` (cross-platform) plus a few macOS-only CLI shell-outs
// (ioreg for GPU, top for per-process energy impact; lsof for connections is
// used on Linux too when it happens to be installed). Everything macOS-only
// degrades to "unavailable" on Linux (see IS_DARWIN/LSOF_PATH below) rather
// than failing loudly — Phase E3 is what actually exercises that path, in
// the Docker image (node:22-slim has none of ioreg/top/lsof). Pure Node, no
// Electron APIs, so both the Electron main process (src/main.js) and the
// standalone web server (src/server/index.js) share this one implementation
// instead of drifting apart.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const si = require('systeminformation');
const { finiteNumber, clampPercent, safeLabel, isIpv4 } = require('./format-utils');

const forceOfflineTest = process.env.EDEX_FORCE_OFFLINE_TEST === '1';
const IS_DARWIN = process.platform === 'darwin';

// `lsof` ships with macOS; on Linux (in particular node:22-slim, the Docker
// target) it's usually just not installed. Checked once at module load —
// it's a static fact about this host/image, not something that changes tick
// to tick — so a missing binary short-circuits collectNetworkConnections
// below instead of spawning a doomed-to-ENOENT process every
// NETWORK_CONNECTIONS_REFRESH_TICKS forever.
const LSOF_PATH = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}) || null;

const MONITOR_INTERVAL_MS = 1_000;
const PROCESS_REFRESH_TICKS = 3;
const DISK_REFRESH_TICKS = 10;
const CONNECTIVITY_REFRESH_TICKS = 7;
const BATTERY_REFRESH_TICKS = 30;
const PROCESS_LIST_LIMIT = 14;
const PROCESS_ENERGY_LIMIT = 40;
const PROCESS_ENERGY_REFRESH_TICKS = 9;
const GPU_REFRESH_TICKS = 3;
const NETWORK_CONNECTIONS_REFRESH_TICKS = 5;
const NETWORK_CONNECTIONS_LIMIT = 20;
const PUBLIC_IP_CACHE_MS = 5 * 60 * 1_000;
const PUBLIC_IP_TIMEOUT_MS = 3_000;
const PUBLIC_IP_ENDPOINT = 'https://api.ipify.org';

const publicIpCache = { value: null, expiresAt: 0, inFlight: null };

async function activeNetworkInterface() {
  const interfaces = await si.networkInterfaces();
  const interfaceName = await si.networkInterfaceDefault();
  const active = interfaces.find((item) => item.iface === interfaceName)
    || interfaces.find((item) => item.default && isIpv4(item.ip4))
    || interfaces.find((item) => !item.internal && !item.virtual && item.operstate === 'up' && isIpv4(item.ip4))
    || interfaces.find((item) => !item.internal && item.operstate === 'up' && isIpv4(item.ip4));
  return active || null;
}

async function fetchPublicIpv4() {
  if (forceOfflineTest) return null;
  const now = Date.now();
  if (publicIpCache.value && publicIpCache.expiresAt > now) return publicIpCache.value;
  if (publicIpCache.inFlight) return publicIpCache.inFlight;

  publicIpCache.inFlight = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PUBLIC_IP_TIMEOUT_MS);
    try {
      const response = await fetch(PUBLIC_IP_ENDPOINT, {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'text/plain' }
      });
      if (!response.ok) return null;
      const address = (await response.text()).trim();
      if (!isIpv4(address)) return null;
      publicIpCache.value = address;
      publicIpCache.expiresAt = Date.now() + PUBLIC_IP_CACHE_MS;
      return address;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      publicIpCache.inFlight = null;
    }
  })();

  return publicIpCache.inFlight;
}

async function collectConnectivityMetric() {
  if (forceOfflineTest) {
    return { state: 'offline', interface: null, lanIpv4: null, publicIpv4: null, latencyMs: null };
  }

  const [interfaceResult, publicIpResult, latencyResult] = await Promise.allSettled([
    activeNetworkInterface(),
    fetchPublicIpv4(),
    si.inetLatency('1.1.1.1')
  ]);
  const active = interfaceResult.status === 'fulfilled' ? interfaceResult.value : null;
  const publicIpv4 = publicIpResult.status === 'fulfilled' && isIpv4(publicIpResult.value) ? publicIpResult.value : null;
  const rawLatency = latencyResult.status === 'fulfilled' ? finiteNumber(latencyResult.value) : null;
  const latencyMs = rawLatency !== null && rawLatency >= 0 ? Math.round(rawLatency) : null;
  const online = Boolean(publicIpv4 || latencyMs !== null);

  return {
    state: online ? 'online' : 'offline',
    interface: online ? safeLabel(active?.iface, null, 18) : null,
    lanIpv4: online && isIpv4(active?.ip4) ? active.ip4 : null,
    publicIpv4: online ? publicIpv4 : null,
    latencyMs: online ? latencyMs : null
  };
}

async function collectBatteryMetric() {
  const battery = await si.battery();
  if (!battery?.hasBattery) return { hasBattery: false };
  return {
    hasBattery: true,
    percent: clampPercent(battery.percent),
    isCharging: battery.isCharging === true || battery.acConnected === true
  };
}

async function collectNetworkMetric(preferredInterface = null) {
  const activeInterface = preferredInterface ? null : await activeNetworkInterface();
  const interfaceName = preferredInterface || activeInterface?.iface || '';

  const stats = await si.networkStats(interfaceName || undefined);
  const active = stats.find((item) => item.iface === interfaceName) || stats[0];
  if (!active) throw new Error('No active network interface');

  return {
    interface: safeLabel(active.iface || interfaceName, 'N/A', 18),
    downBytesPerSecond: Math.max(finiteNumber(active.rx_sec, 0), 0),
    upBytesPerSecond: Math.max(finiteNumber(active.tx_sec, 0), 0)
  };
}

// Already platform-branched from Phase E1 — macOS's real data volume lives
// at /System/Volumes/Data (the visible "/" is a thin read-only system
// volume), Linux (bare metal or the Docker image) just has "/".
function selectPrimaryDisk(fileSystems) {
  if (!Array.isArray(fileSystems) || fileSystems.length === 0) return null;
  if (IS_DARWIN) {
    return fileSystems.find((disk) => disk.mount === '/System/Volumes/Data')
      || fileSystems.find((disk) => disk.mount === '/');
  }
  return fileSystems.find((disk) => disk.mount === '/') || fileSystems[0];
}

async function collectDiskMetric() {
  const disk = selectPrimaryDisk(await si.fsSize());
  if (!disk) throw new Error('No file system data');

  return {
    mount: safeLabel(disk.mount, 'N/A', 32),
    usedBytes: Math.max(finiteNumber(disk.used, 0), 0),
    availableBytes: Math.max(finiteNumber(disk.available, 0), 0),
    totalBytes: Math.max(finiteNumber(disk.size, 0), 0),
    usePercent: clampPercent(disk.use)
  };
}

function runCommand(command, args, timeout = 8_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// Per-process GPU use needs root on macOS, but the accelerator's own counters
// are world-readable — so the HUD reports GPU load for the device, not per app.
// `ioreg` is macOS-only (no Linux equivalent wired up — a generic path would
// mean a different tool per GPU vendor); collectMonitoringSample doesn't
// track this rejection as an error (see the `errors` object below), so on
// Linux the GPU block just stays cached null and the renderer already knows
// to hide it (see telemetry-ui.js's `hasGpu`).
async function collectGpuMetric() {
  if (!IS_DARWIN) throw new Error('GPU metrics are macOS-only.');
  const stdout = await runCommand('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator', '-w', '0'], 2_000);
  const statistics = stdout.match(/"PerformanceStatistics"\s*=\s*\{([^}]*)\}/);
  if (!statistics) throw new Error('No accelerator statistics');
  const readPercent = (label) => {
    const match = statistics[1].match(new RegExp(`"${label}"\\s*=\\s*(\\d+)`));
    return match ? clampPercent(Number(match[1])) : null;
  };
  const utilizationPercent = readPercent('Device Utilization %');
  if (utilizationPercent === null) throw new Error('No GPU utilization');
  return {
    utilizationPercent,
    rendererPercent: readPercent('Renderer Utilization %'),
    tilerPercent: readPercent('Tiler Utilization %')
  };
}

function parseHostPort(part) {
  if (typeof part !== 'string' || part.length === 0) return { host: null, port: null };
  const bracketed = part.match(/^\[(.+)\]:(\d+|\*)$/);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] === '*' ? null : Number(bracketed[2]) };
  const separatorIndex = part.lastIndexOf(':');
  if (separatorIndex === -1) return { host: part === '*' ? null : part, port: null };
  const host = part.slice(0, separatorIndex);
  const port = part.slice(separatorIndex + 1);
  return { host: host === '*' ? null : host, port: port === '*' ? null : Number(port) };
}

function connectionSortWeight(state) {
  if (state === 'ESTABLISHED') return 0;
  if (state === 'LISTEN') return 2;
  return 1;
}

// Per-user `lsof -i` needs no root and triggers no TCC prompt on macOS — it
// only surfaces sockets owned by the current user, which is exactly what a
// HelpDesk technician wants to see on their own machine. On Linux this is
// best-effort: lsof isn't installed in the Docker image (node:22-slim) or on
// a lot of minimal distros, so LSOF_PATH is null there and this returns an
// empty list rather than spawning a binary that doesn't exist.
async function collectNetworkConnections() {
  if (forceOfflineTest || !LSOF_PATH) return [];

  const stdout = await runCommand(LSOF_PATH, ['-i', '-n', '-P', '-F', 'pcnPT'], 3_000);
  const rows = [];
  let currentPid = null;
  let currentCommand = null;
  let protocol = null;
  let address = null;
  let state = null;

  const flush = () => {
    if (!Number.isInteger(currentPid) || !protocol || !address) return;
    const [localPart, remotePart] = address.split('->');
    const local = parseHostPort(localPart);
    const remote = remotePart ? parseHostPort(remotePart) : { host: null, port: null };
    rows.push({
      processName: safeLabel(currentCommand, 'UNKNOWN', 34),
      pid: currentPid,
      protocol,
      localPort: local.port,
      remoteAddress: remote.host,
      remotePort: remote.port,
      state: safeLabel(state, protocol === 'UDP' ? 'OPEN' : 'LISTEN', 16)
    });
  };

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      flush();
      currentPid = Number(value);
      protocol = null;
      address = null;
      state = null;
    } else if (tag === 'c') {
      currentCommand = value;
    } else if (tag === 'f') {
      flush();
      protocol = null;
      address = null;
      state = null;
    } else if (tag === 'P') {
      protocol = value;
    } else if (tag === 'n') {
      address = value;
    } else if (tag === 'T' && value.startsWith('ST=')) {
      state = value.slice(3);
    }
  }
  flush();

  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = `${row.pid}\0${row.protocol}\0${row.localPort}\0${row.remoteAddress}\0${row.remotePort}\0${row.state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return deduped
    .sort((left, right) => connectionSortWeight(left.state) - connectionSortWeight(right.state))
    .slice(0, NETWORK_CONNECTIONS_LIMIT);
}

// `top` reports energy impact only from its second sample on, so this costs a
// second of wall time and runs on its own slow cadence, off the telemetry tick.
// BSD `top`'s `-o power -stats pid,power` is macOS-specific — GNU top (Linux)
// has no equivalent concept, so this never runs there; energyAvailable stays
// false forever and the renderer hides the ENERGY sort button accordingly.
async function collectProcessEnergy() {
  if (!IS_DARWIN) throw new Error('Energy impact is macOS-only.');
  const stdout = await runCommand('/usr/bin/top', [
    '-l', '2', '-s', '1', '-n', String(PROCESS_ENERGY_LIMIT),
    '-o', 'power', '-stats', 'pid,power'
  ]);
  const samples = stdout.split(/^Processes:/m);
  const energyByPid = new Map();
  for (const line of (samples[samples.length - 1] || stdout).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+([\d.]+)\s*$/);
    if (match) energyByPid.set(Number(match[1]), Math.max(Number(match[2]), 0));
  }
  if (energyByPid.size === 0) throw new Error('No energy impact reported');
  return energyByPid;
}

async function collectProcessesMetric(energyByPid) {
  const result = await si.processes();
  if (!Array.isArray(result.list)) throw new Error('No process list');

  return result.list
    .map((processInfo) => ({
      name: safeLabel(path.basename(processInfo.name || ''), 'UNKNOWN', 34),
      cpuPercent: Math.max(finiteNumber(processInfo.cpu, 0), 0),
      memoryPercent: clampPercent(processInfo.mem) ?? 0,
      energyImpact: energyByPid?.get(processInfo.pid) ?? null
    }))
    .filter((processInfo) => processInfo.name !== 'UNKNOWN')
    .sort((left, right) => right.cpuPercent - left.cpuPercent || right.memoryPercent - left.memoryPercent);
}

// The renderer re-sorts by whichever column is selected, so the payload carries
// the leaders of every column — otherwise a memory hog with idle CPU would never
// reach the list to be sorted into view.
function topProcessesForEveryColumn(processes) {
  const selected = new Map();
  const take = (key) => [...processes]
    .sort((left, right) => (right[key] ?? 0) - (left[key] ?? 0))
    .slice(0, PROCESS_LIST_LIMIT)
    .forEach((processInfo) => selected.set(processInfo, true));
  take('cpuPercent');
  take('memoryPercent');
  take('energyImpact');
  return [...selected.keys()];
}

function rejectedMessage(result) {
  return result.status === 'rejected' ? safeLabel(result.reason?.message, 'Unavailable', 80) : null;
}

// Fire-and-forget: the energy sampler takes a second, so a tick never waits for
// it — it publishes into the cache and the next process refresh picks it up.
function refreshProcessEnergy(session) {
  if (session.energyInFlight) return;
  if (session.cache.energyByPid && session.tick % PROCESS_ENERGY_REFRESH_TICKS !== 0) return;
  session.energyInFlight = true;
  collectProcessEnergy()
    .then((energyByPid) => {
      session.cache.energyByPid = energyByPid;
      session.cache.energyError = null;
    })
    .catch((error) => {
      session.cache.energyError = safeLabel(error?.message, 'Unavailable', 80);
    })
    .finally(() => {
      session.energyInFlight = false;
    });
}

// Per-consumer state: one of these per Electron webContents, or per web
// client connection — never shared across consumers.
function createMonitoringSession() {
  return {
    tick: 0,
    inFlight: false,
    energyInFlight: false,
    cache: { disk: null, processes: null, connectivity: null, battery: null, energyByPid: null, energyError: null, gpu: null, connections: null }
  };
}

async function collectMonitoringSample(session) {
  const refreshProcesses = !session.cache.processes || session.tick % PROCESS_REFRESH_TICKS === 0;
  const refreshDisk = !session.cache.disk || session.tick % DISK_REFRESH_TICKS === 0;
  const refreshConnectivity = !session.cache.connectivity || session.tick % CONNECTIVITY_REFRESH_TICKS === 0;
  const refreshBattery = !session.cache.battery || session.tick % BATTERY_REFRESH_TICKS === 0;
  const refreshGpu = !session.cache.gpu || session.tick % GPU_REFRESH_TICKS === 0;
  const refreshConnections = !session.cache.connections || session.tick % NETWORK_CONNECTIONS_REFRESH_TICKS === 0;
  refreshProcessEnergy(session);
  const [cpuResult, memoryResult, networkResult, diskResult, processesResult, connectivityResult, batteryResult, gpuResult, connectionsResult] = await Promise.allSettled([
    si.currentLoad(),
    si.mem(),
    collectNetworkMetric(session.cache.connectivity?.interface),
    refreshDisk ? collectDiskMetric() : Promise.resolve(session.cache.disk),
    refreshProcesses ? collectProcessesMetric(session.cache.energyByPid) : Promise.resolve(session.cache.processes),
    refreshConnectivity ? collectConnectivityMetric() : Promise.resolve(session.cache.connectivity),
    refreshBattery ? collectBatteryMetric() : Promise.resolve(session.cache.battery),
    refreshGpu ? collectGpuMetric() : Promise.resolve(session.cache.gpu),
    refreshConnections ? collectNetworkConnections() : Promise.resolve(session.cache.connections)
  ]);

  const cpu = cpuResult.status === 'fulfilled' ? {
    loadPercent: clampPercent(cpuResult.value.currentLoad),
    cores: Array.isArray(cpuResult.value.cpus)
      ? cpuResult.value.cpus.slice(0, 32).map((core) => clampPercent(core.load))
      : []
  } : null;

  const memory = memoryResult.status === 'fulfilled' ? (() => {
    const raw = memoryResult.value;
    const totalBytes = Math.max(finiteNumber(raw.total, 0), 0);
    const availableBytes = Math.max(finiteNumber(raw.available, 0), 0);
    const usedBytes = Math.max(totalBytes - availableBytes, 0);
    // macOS reports its page cache through buffcache; `cached` stays zero there.
    const cachedBytes = Math.max(finiteNumber(raw.buffcache, 0) || finiteNumber(raw.cached, 0), 0);
    const freeBytes = Math.max(finiteNumber(raw.free, 0), 0);
    const swapTotalBytes = Math.max(finiteNumber(raw.swaptotal, 0), 0);
    const swapUsedBytes = Math.max(finiteNumber(raw.swapused, 0), 0);
    const share = (value) => (totalBytes > 0 ? clampPercent((value / totalBytes) * 100) : null);
    return {
      totalBytes,
      usedBytes,
      availableBytes,
      cachedBytes,
      freeBytes,
      swapTotalBytes,
      swapUsedBytes,
      usePercent: share(usedBytes),
      cachedPercent: share(cachedBytes),
      freePercent: share(freeBytes),
      availablePercent: share(availableBytes),
      swapPercent: swapTotalBytes > 0 ? clampPercent((swapUsedBytes / swapTotalBytes) * 100) : null
    };
  })() : null;

  const network = networkResult.status === 'fulfilled' ? networkResult.value : null;
  const disk = diskResult.status === 'fulfilled' ? diskResult.value : session.cache.disk;
  const processes = processesResult.status === 'fulfilled' ? processesResult.value : session.cache.processes;
  const connectivity = connectivityResult.status === 'fulfilled' ? connectivityResult.value : session.cache.connectivity;
  const battery = batteryResult.status === 'fulfilled' ? batteryResult.value : session.cache.battery;
  if (diskResult.status === 'fulfilled') session.cache.disk = disk;
  if (processesResult.status === 'fulfilled') session.cache.processes = processes;
  if (connectivityResult.status === 'fulfilled') session.cache.connectivity = connectivity;
  if (batteryResult.status === 'fulfilled') session.cache.battery = battery;

  const gpu = gpuResult.status === 'fulfilled' ? gpuResult.value : session.cache.gpu || null;
  if (gpuResult.status === 'fulfilled') session.cache.gpu = gpu;
  const connections = connectionsResult.status === 'fulfilled' ? connectionsResult.value : session.cache.connections || [];
  if (connectionsResult.status === 'fulfilled') session.cache.connections = connections;
  const errors = {
    cpu: rejectedMessage(cpuResult),
    memory: rejectedMessage(memoryResult),
    network: rejectedMessage(networkResult),
    disk: rejectedMessage(diskResult),
    processes: rejectedMessage(processesResult),
    connectivity: rejectedMessage(connectivityResult),
    battery: rejectedMessage(batteryResult),
    connections: rejectedMessage(connectionsResult)
  };
  const errorCount = Object.values(errors).filter(Boolean).length;
  session.tick += 1;

  return {
    timestamp: Date.now(),
    status: errorCount === 0 ? 'ok' : errorCount === Object.keys(errors).length ? 'error' : 'partial',
    session: {
      hostname: safeLabel(os.hostname().replace(/\.local$/i, ''), 'LOCALHOST', 36),
      uptimeSeconds: Math.max(Math.floor(os.uptime()), 0)
    },
    cpu,
    memory,
    network,
    connectivity: connectivity || { state: 'offline', interface: null, lanIpv4: null, publicIpv4: null, latencyMs: null },
    battery: battery || { hasBattery: false },
    disk: disk || null,
    gpu,
    connections,
    processes: topProcessesForEveryColumn(processes || []),
    energyAvailable: Boolean(session.cache.energyByPid),
    // Static per-process capability, not per-sample data — an empty
    // `connections` array is ambiguous (no sockets open right now vs. no way
    // to ever list them), so the renderer needs this to tell "CONN has
    // nothing to show today" from "CONN doesn't work here" (see
    // telemetry-ui.js's connectionsAvailable handling).
    connectionsAvailable: Boolean(LSOF_PATH),
    errors
  };
}

module.exports = {
  MONITOR_INTERVAL_MS,
  createMonitoringSession,
  collectMonitoringSample
};
