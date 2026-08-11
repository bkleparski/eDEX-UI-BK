'use strict';

const { app, BrowserWindow, ipcMain, net } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const si = require('systeminformation');

const isSmokeTest = process.env.EDEX_SMOKE_TEST === '1';
const isVisualTest = process.env.EDEX_VISUAL_TEST === '1';
const forceOfflineTest = process.env.EDEX_FORCE_OFFLINE_TEST === '1';
const isAutomatedTest = isSmokeTest || isVisualTest;
const visualTestWidth = Math.max(960, Number.parseInt(process.env.EDEX_VISUAL_WIDTH, 10) || 1440);
const visualTestHeight = Math.max(640, Number.parseInt(process.env.EDEX_VISUAL_HEIGHT, 10) || 900);
const minimumVisualTerminalWidth = visualTestWidth < 1200 ? 500 : 850;
const terminals = new Map();
const terminalMetadataSessions = new Map();
const monitoringSessions = new Map();
let smokeTimeout;
let gracefulShutdownStarted = false;

const MONITOR_INTERVAL_MS = 1_000;
const PROCESS_REFRESH_TICKS = 3;
const DISK_REFRESH_TICKS = 10;
const CONNECTIVITY_REFRESH_TICKS = 7;
const BATTERY_REFRESH_TICKS = 30;
const TERMINAL_METADATA_INTERVAL_MS = 500;
const PUBLIC_IP_CACHE_MS = 5 * 60 * 1_000;
const PUBLIC_IP_TIMEOUT_MS = 3_000;
const PUBLIC_IP_ENDPOINT = 'https://api.ipify.org';
const MAX_TERMINALS_PER_WINDOW = 8;
const MAX_FILE_ENTRIES = 80;
const publicIpCache = { value: null, expiresAt: 0, inFlight: null };

function isTrustedSender(event) {
  const senderUrl = event.senderFrame?.url;
  if (typeof senderUrl !== 'string') return false;

  const parsedUrl = new URL(senderUrl);
  const expectedPath = path.join(__dirname, 'renderer', 'index.html');
  return parsedUrl.protocol === 'file:' && decodeURIComponent(parsedUrl.pathname) === expectedPath;
}

function requireTrustedSender(event) {
  if (!isTrustedSender(event)) {
    throw new Error('Rejected IPC request from an untrusted renderer.');
  }
}

function validSessionId(value) {
  return typeof value === 'string' && /^tty-[0-9]{2}$/.test(value) ? value : null;
}

function disposeTerminalMetadata(webContentsId) {
  const metadataSession = terminalMetadataSessions.get(webContentsId);
  if (!metadataSession) return;
  clearInterval(metadataSession.timer);
  terminalMetadataSessions.delete(webContentsId);
}

function disposeTerminal(webContentsId, sessionId = null) {
  const clientTerminals = terminals.get(webContentsId);
  if (!clientTerminals) return;
  const targets = sessionId
    ? [[sessionId, clientTerminals.get(sessionId)]]
    : [...clientTerminals.entries()];

  for (const [targetSessionId, terminal] of targets) {
    if (!terminal) continue;
    clientTerminals.delete(targetSessionId);
    try {
      terminal.kill();
    } catch {
      // The shell may already have exited.
    }
  }

  if (clientTerminals.size === 0) {
    terminals.delete(webContentsId);
    disposeTerminalMetadata(webContentsId);
  }
}

function terminalWorkingDirectory(terminal) {
  return new Promise((resolve, reject) => {
    if (!terminal || !Number.isInteger(terminal.pid)) {
      reject(new Error('Terminal process unavailable'));
      return;
    }

    execFile('/usr/sbin/lsof', ['-a', '-p', String(terminal.pid), '-d', 'cwd', '-Fn'], {
      timeout: 1_000,
      maxBuffer: 64 * 1024
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const cwdLine = stdout.split('\n').find((line) => line.startsWith('n'));
      if (!cwdLine?.slice(1)) {
        reject(new Error('Terminal working directory unavailable'));
        return;
      }
      resolve(cwdLine.slice(1));
    });
  });
}

function processIdentity(processTitle) {
  const command = safeLabel(processTitle, 'zsh', 180);
  const executable = command.trim().split(/\s+/)[0];
  const name = path.basename(executable).replace(/^-/, '').toLowerCase() || 'zsh';
  return { command, name, idle: /^(?:zsh|bash|sh|login)$/.test(name) };
}

function compactWorkingDirectory(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '~';
  const home = os.homedir();
  const displayPath = cwd === home ? '~' : cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
  if (displayPath.length <= 20) return displayPath;
  const segments = displayPath.split(path.sep).filter(Boolean);
  return segments.slice(-2).join(path.sep) || displayPath;
}

async function collectTerminalMetadata(terminal, state, now) {
  const processInfo = processIdentity(terminal.process);
  if (processInfo.idle && (!state.cwd || now - state.cwdCheckedAt >= 1_000)) {
    state.cwdCheckedAt = now;
    try {
      state.cwd = await terminalWorkingDirectory(terminal);
    } catch {
      // Preserve the last known directory if lsof is temporarily unavailable.
    }
  }

  return {
    processName: processInfo.name,
    command: processInfo.command,
    idle: processInfo.idle,
    cwd: state.cwd || null,
    label: processInfo.idle ? compactWorkingDirectory(state.cwd) : processInfo.name
  };
}

async function publishTerminalMetadata(webContentsId) {
  const metadataSession = terminalMetadataSessions.get(webContentsId);
  const clientTerminals = terminals.get(webContentsId);
  if (!metadataSession || metadataSession.inFlight || !clientTerminals || metadataSession.webContents.isDestroyed()) return;
  metadataSession.inFlight = true;
  const now = Date.now();
  try {
    const targets = [...clientTerminals.entries()].filter(([sessionId]) => (
      sessionId === metadataSession.activeSessionId || metadataSession.tick % 3 === 0
    ));
    const updates = (await Promise.all(targets.map(async ([sessionId, terminal]) => {
      try {
        let state = metadataSession.states.get(sessionId);
        if (!state) {
          state = { cwd: null, cwdCheckedAt: 0 };
          metadataSession.states.set(sessionId, state);
        }
        return { sessionId, ...(await collectTerminalMetadata(terminal, state, now)) };
      } catch {
        return null;
      }
    }))).filter(Boolean);
    if (updates.length > 0 && !metadataSession.webContents.isDestroyed()) {
      metadataSession.webContents.send('terminal:metadata', updates);
    }
    metadataSession.tick += 1;
  } finally {
    metadataSession.inFlight = false;
  }
}

function ensureTerminalMetadataSession(webContents, activeSessionId) {
  let metadataSession = terminalMetadataSessions.get(webContents.id);
  if (!metadataSession) {
    metadataSession = {
      webContents,
      activeSessionId,
      timer: null,
      inFlight: false,
      tick: 0,
      states: new Map()
    };
    terminalMetadataSessions.set(webContents.id, metadataSession);
    metadataSession.timer = setInterval(() => publishTerminalMetadata(webContents.id), TERMINAL_METADATA_INTERVAL_MS);
  } else {
    metadataSession.activeSessionId = activeSessionId;
  }
  setTimeout(() => publishTerminalMetadata(webContents.id), 80);
  return metadataSession;
}

async function listTerminalFiles(terminal, sessionId) {
  try {
    const cwd = await terminalWorkingDirectory(terminal);
    const directoryEntries = await fs.promises.readdir(cwd, { withFileTypes: true });
    const entries = directoryEntries
      .map((entry) => ({
        name: safeLabel(entry.name, 'UNKNOWN', 96),
        type: entry.isDirectory() ? 'directory'
          : entry.isSymbolicLink() ? 'link'
            : entry.isFile() ? 'file' : 'other'
      }))
      .sort((left, right) => {
        const leftDirectory = left.type === 'directory' ? 0 : 1;
        const rightDirectory = right.type === 'directory' ? 0 : 1;
        return leftDirectory - rightDirectory || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      });

    return {
      status: 'ok',
      sessionId,
      cwd: safeLabel(cwd, '/', 240),
      entries: entries.slice(0, MAX_FILE_ENTRIES),
      totalCount: entries.length,
      truncated: entries.length > MAX_FILE_ENTRIES
    };
  } catch {
    return {
      status: 'error',
      sessionId,
      cwd: null,
      entries: [],
      totalCount: 0,
      truncated: false
    };
  }
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampPercent(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.min(Math.max(number, 0), 100);
}

function safeLabel(value, fallback = 'N/A', maxLength = 36) {
  if (typeof value !== 'string') return fallback;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return label ? label.slice(0, maxLength) : fallback;
}

function isIpv4(value) {
  if (typeof value !== 'string') return false;
  const octets = value.trim().split('.');
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

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
      const response = await net.fetch(PUBLIC_IP_ENDPOINT, {
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

function selectPrimaryDisk(fileSystems) {
  if (!Array.isArray(fileSystems) || fileSystems.length === 0) return null;
  if (process.platform === 'darwin') {
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

async function collectProcessesMetric() {
  const result = await si.processes();
  if (!Array.isArray(result.list)) throw new Error('No process list');

  return result.list
    .map((processInfo) => ({
      name: safeLabel(path.basename(processInfo.name || ''), 'UNKNOWN', 34),
      cpuPercent: Math.max(finiteNumber(processInfo.cpu, 0), 0),
      memoryPercent: clampPercent(processInfo.mem) ?? 0
    }))
    .filter((processInfo) => processInfo.name !== 'UNKNOWN')
    .sort((left, right) => right.cpuPercent - left.cpuPercent || right.memoryPercent - left.memoryPercent)
    .slice(0, 6);
}

function rejectedMessage(result) {
  return result.status === 'rejected' ? safeLabel(result.reason?.message, 'Unavailable', 80) : null;
}

async function collectMonitoringSample(session) {
  const refreshProcesses = !session.cache.processes || session.tick % PROCESS_REFRESH_TICKS === 0;
  const refreshDisk = !session.cache.disk || session.tick % DISK_REFRESH_TICKS === 0;
  const refreshConnectivity = !session.cache.connectivity || session.tick % CONNECTIVITY_REFRESH_TICKS === 0;
  const refreshBattery = !session.cache.battery || session.tick % BATTERY_REFRESH_TICKS === 0;
  const [cpuResult, memoryResult, networkResult, diskResult, processesResult, connectivityResult, batteryResult] = await Promise.allSettled([
    si.currentLoad(),
    si.mem(),
    collectNetworkMetric(session.cache.connectivity?.interface),
    refreshDisk ? collectDiskMetric() : Promise.resolve(session.cache.disk),
    refreshProcesses ? collectProcessesMetric() : Promise.resolve(session.cache.processes),
    refreshConnectivity ? collectConnectivityMetric() : Promise.resolve(session.cache.connectivity),
    refreshBattery ? collectBatteryMetric() : Promise.resolve(session.cache.battery)
  ]);

  const cpu = cpuResult.status === 'fulfilled' ? {
    loadPercent: clampPercent(cpuResult.value.currentLoad),
    cores: Array.isArray(cpuResult.value.cpus)
      ? cpuResult.value.cpus.slice(0, 32).map((core) => clampPercent(core.load))
      : []
  } : null;

  const memory = memoryResult.status === 'fulfilled' ? (() => {
    const totalBytes = Math.max(finiteNumber(memoryResult.value.total, 0), 0);
    const availableBytes = Math.max(finiteNumber(memoryResult.value.available, 0), 0);
    const usedBytes = Math.max(totalBytes - availableBytes, 0);
    return {
      totalBytes,
      usedBytes,
      availableBytes,
      usePercent: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : null
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

  const errors = {
    cpu: rejectedMessage(cpuResult),
    memory: rejectedMessage(memoryResult),
    network: rejectedMessage(networkResult),
    disk: rejectedMessage(diskResult),
    processes: rejectedMessage(processesResult),
    connectivity: rejectedMessage(connectivityResult),
    battery: rejectedMessage(batteryResult)
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
    processes: processes || [],
    errors
  };
}

async function publishMonitoringSample(webContentsId) {
  const session = monitoringSessions.get(webContentsId);
  if (!session || session.inFlight || session.webContents.isDestroyed()) return null;
  session.inFlight = true;
  try {
    const sample = await collectMonitoringSample(session);
    if (!session.webContents.isDestroyed()) session.webContents.send('monitoring:data', sample);
    return sample;
  } finally {
    session.inFlight = false;
  }
}

function disposeMonitoring(webContentsId) {
  const session = monitoringSessions.get(webContentsId);
  if (!session) return;
  clearInterval(session.timer);
  monitoringSessions.delete(webContentsId);
}

function registerMonitoringIpc() {
  ipcMain.handle('monitoring:start', async (event) => {
    requireTrustedSender(event);
    const webContentsId = event.sender.id;
    if (monitoringSessions.has(webContentsId)) return publishMonitoringSample(webContentsId);

    const session = {
      webContents: event.sender,
      timer: null,
      inFlight: false,
      tick: 0,
      cache: { disk: null, processes: null, connectivity: null, battery: null }
    };
    monitoringSessions.set(webContentsId, session);
    event.sender.once('destroyed', () => disposeMonitoring(webContentsId));

    const initialSample = await publishMonitoringSample(webContentsId);
    if (!monitoringSessions.has(webContentsId)) return initialSample;
    session.timer = setInterval(() => publishMonitoringSample(webContentsId), MONITOR_INTERVAL_MS);
    return initialSample;
  });

  ipcMain.on('monitoring:stop', (event) => {
    if (!isTrustedSender(event)) return;
    disposeMonitoring(event.sender.id);
  });
}

function registerTerminalIpc() {
  ipcMain.handle('terminal:start', (event, options = {}) => {
    requireTrustedSender(event);
    const sessionId = validSessionId(options.sessionId);
    if (!sessionId) throw new Error('Invalid terminal session ID.');

    let clientTerminals = terminals.get(event.sender.id);
    if (!clientTerminals) {
      clientTerminals = new Map();
      terminals.set(event.sender.id, clientTerminals);
      event.sender.once('destroyed', () => disposeTerminal(event.sender.id));
    }

    if (clientTerminals.has(sessionId)) {
      return { started: true, sessionId };
    }

    if (clientTerminals.size >= MAX_TERMINALS_PER_WINDOW) throw new Error('Terminal session limit reached.');

    const cols = Number.isInteger(options.cols) ? Math.min(Math.max(options.cols, 2), 500) : 80;
    const rows = Number.isInteger(options.rows) ? Math.min(Math.max(options.rows, 1), 300) : 24;
    const shell = '/bin/zsh';
    const terminal = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: {
        ...process.env,
        SHELL: shell,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    });

    clientTerminals.set(sessionId, terminal);
    ensureTerminalMetadataSession(event.sender, sessionId).states.set(sessionId, { cwd: os.homedir(), cwdCheckedAt: 0 });

    terminal.onData((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('terminal:data', { sessionId, data });
      }
    });

    terminal.onExit(({ exitCode, signal }) => {
      clientTerminals.delete(sessionId);
      const metadataSession = terminalMetadataSessions.get(event.sender.id);
      metadataSession?.states.delete(sessionId);
      if (clientTerminals.size === 0) {
        terminals.delete(event.sender.id);
        disposeTerminalMetadata(event.sender.id);
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send('terminal:exit', { sessionId, exitCode, signal });
      }
    });

    return { started: true, sessionId, pid: terminal.pid, shell };
  });

  ipcMain.on('terminal:write', (event, payload) => {
    const sessionId = validSessionId(payload?.sessionId);
    const data = payload?.data;
    if (!isTrustedSender(event) || !sessionId || typeof data !== 'string' || data.length > 64 * 1024) return;
    terminals.get(event.sender.id)?.get(sessionId)?.write(data);
  });

  ipcMain.on('terminal:resize', (event, payload) => {
    const sessionId = validSessionId(payload?.sessionId);
    if (!isTrustedSender(event) || !sessionId || !Number.isInteger(payload.cols) || !Number.isInteger(payload.rows)) return;
    const cols = Math.min(Math.max(payload.cols, 2), 500);
    const rows = Math.min(Math.max(payload.rows, 1), 300);
    terminals.get(event.sender.id)?.get(sessionId)?.resize(cols, rows);
  });

  ipcMain.on('terminal:set-active', (event, payload) => {
    const sessionId = validSessionId(payload?.sessionId);
    if (!isTrustedSender(event) || !sessionId || !terminals.get(event.sender.id)?.has(sessionId)) return;
    const metadataSession = ensureTerminalMetadataSession(event.sender, sessionId);
    metadataSession.activeSessionId = sessionId;
  });

  ipcMain.on('terminal:smoke-result', (event, result) => {
    if (!isSmokeTest) return;
    requireTrustedSender(event);
    clearTimeout(smokeTimeout);
    process.exitCode = result?.ok === true ? 0 : 1;
    if (result?.ok === true) {
      console.log('PTY smoke test passed: xterm renderer received output from /bin/zsh through node-pty.');
    } else {
      console.error('PTY smoke test failed.');
    }
    app.quit();
  });
}

function registerFilesIpc() {
  ipcMain.handle('files:list', async (event, payload = {}) => {
    requireTrustedSender(event);
    const sessionId = validSessionId(payload.sessionId);
    if (!sessionId) throw new Error('Invalid terminal session ID.');
    const terminal = terminals.get(event.sender.id)?.get(sessionId);
    if (!terminal) {
      return { status: 'error', sessionId, cwd: null, entries: [], totalCount: 0, truncated: false };
    }
    return listTerminalFiles(terminal, sessionId);
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: isVisualTest ? visualTestWidth : 1440,
    height: isVisualTest ? visualTestHeight : 900,
    minWidth: 960,
    minHeight: 640,
    center: true,
    frame: true,
    fullscreen: false,
    fullscreenable: true,
    resizable: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 27, y: 36 },
    show: !isAutomatedTest,
    backgroundColor: '#02080a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    isAutomatedTest ? { query: { test: isSmokeTest ? 'smoke' : 'visual' } } : undefined
  );

  if (isSmokeTest) {
    smokeTimeout = setTimeout(() => {
      console.error('PTY smoke test timed out.');
      process.exitCode = 1;
      app.quit();
    }, 15_000);
  }

  if (isVisualTest) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        window.webContents.executeJavaScript(`(() => {
          const press = (code, shiftKey = false) => document.dispatchEvent(new KeyboardEvent('keydown', {
            code,
            metaKey: true,
            shiftKey,
            bubbles: true,
            cancelable: true
          }));
          press('KeyT');
          press('Digit1');
          setTimeout(() => press('Digit2'), 250);
          setTimeout(() => press('Digit1'), 500);
          setTimeout(() => press('Digit2'), 750);
          if (document.body.classList.contains('scanlines-on')) press('KeyL', true);
          press('KeyL', true);
          press('KeyL', true);
          if (document.body.dataset.soundEnabled === 'true') press('KeyS', true);
          press('KeyS', true);
          press('KeyS', true);
          const waitFor = (condition, action, attempt = 0) => {
            if (condition()) action();
            else if (attempt < 40) setTimeout(() => waitFor(condition, action, attempt + 1), 250);
          };
          waitFor(
            () => document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId === 'tty-02'
              && document.getElementById('shellStatusText').textContent === 'LINK ONLINE',
            () => window.terminalApi.write('tty-02', '/usr/bin/top -l 2 -s 1 >/dev/null; exit\\r')
          );
          waitFor(
            () => Number(document.body.dataset.terminalExitCount || 0) >= 1,
            () => window.terminalApi.write('tty-01', 'exit\\r')
          );
          waitFor(
            () => document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId === 'tty-03'
              && document.getElementById('shellStatusText').textContent === 'LINK ONLINE',
            () => window.terminalApi.write('tty-03', 'cd /tmp\\r')
          );
        })()`).catch((error) => console.error(`Visual shortcut setup failed: ${error.message}`));
      }, 2_000);

      setTimeout(async () => {
        try {
          const diagnostics = await window.webContents.executeJavaScript(`({
            fonts: {
              terminal: document.fonts.check('14px "Monaspace Neon NF"'),
              headings: document.fonts.check('600 14px Orbitron'),
              labels: document.fonts.check('500 11px "Chakra Petch"')
            },
            bootComplete: document.body.classList.contains('boot-complete'),
            windowMode: {
              fullscreen: ${window.isFullScreen()},
              fullscreenable: ${window.isFullScreenable()},
              resizable: ${window.isResizable()},
              bounds: ${JSON.stringify(window.getBounds())}
            },
            scanlinesEnabled: document.body.classList.contains('scanlines-on'),
            shellStatus: document.getElementById('shellStatusText').textContent,
            hostname: document.getElementById('hudHostname').textContent,
            date: document.getElementById('hudDate').textContent,
            clock: document.getElementById('hudClock').textContent.trim(),
            uptime: document.getElementById('uptimeValue').textContent,
            batteryPresent: document.body.dataset.batteryPresent === 'true',
            batteryHidden: document.getElementById('powerStatus').hidden,
            batteryValue: document.getElementById('batteryValue').textContent,
            batteryLabel: document.getElementById('powerLabel').textContent,
            terminalSessionCount: document.querySelectorAll('#ttyTabs .tty-tab').length,
            activeTerminal: document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId || null,
            activeTerminalLabel: document.querySelector('#ttyTabs .tty-tab.is-active')?.textContent.trim() || null,
            terminalTopObserved: document.body.dataset.ttyTopObserved === 'true',
            terminalExitCount: Number(document.body.dataset.terminalExitCount || 0),
            terminalRespawnCount: Number(document.body.dataset.terminalRespawnCount || 0),
            terminalOfflineMarker: document.querySelector('.terminal-instance:not([hidden])')?.textContent.includes('SHELL OFFLINE') || false,
            systemGroupOn: !document.body.classList.contains('system-group-hidden'),
            filesGroupOn: !document.body.classList.contains('files-group-hidden'),
            systemToggleCount: Number(document.body.dataset.systemToggleCount || 0),
            filesToggleCount: Number(document.body.dataset.filesToggleCount || 0),
            dataVisibilityStates: document.body.dataset.dataVisibilityStates || '',
            dataVisibilityGeometry: JSON.parse(document.body.dataset.dataVisibilityGeometry || '{}'),
            scanlinesToggleCount: Number(document.body.dataset.scanlinesToggleCount || 0),
            soundEnabled: document.body.dataset.soundEnabled === 'true',
            soundToggleCount: Number(document.body.dataset.soundToggleCount || 0),
            fileBrowserReady: document.body.dataset.fileBrowserReady === 'true',
            fileBrowserCwd: document.getElementById('fileBrowserCwd').textContent,
            fileCount: document.querySelectorAll('#fileList .file-row').length,
            shortcutCount: document.querySelectorAll('.shortcut-legend kbd').length,
            monitoringReady: document.body.dataset.monitoringReady === 'true',
            monitoringSamples: Number(document.body.dataset.monitoringSamples || 0),
            monitoringStatus: document.getElementById('monitoringStatusText').textContent,
            cpuValue: document.getElementById('cpuValue').textContent,
            memoryValue: document.getElementById('memoryValue').textContent,
            networkDown: document.getElementById('networkDown').textContent,
            networkState: document.body.dataset.networkState,
            networkLan: document.getElementById('networkLan').textContent,
            networkPublic: document.getElementById('networkPublic').textContent,
            networkPing: document.getElementById('networkPing').textContent,
            diskValue: document.getElementById('diskValue').textContent,
            diskUsed: document.getElementById('diskUsed').textContent,
            diskAvailable: document.getElementById('diskAvailable').textContent,
            diskWarning: document.getElementById('diskSection').classList.contains('is-warning'),
            processCount: document.querySelectorAll('#processList .process-row').length,
            cspLocked: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("connect-src 'none'"),
            gridColumns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,
            telemetryGeometry: (() => {
              const panel = document.getElementById('telemetryPanel').getBoundingClientRect();
              const column = document.querySelector('.telemetry-column');
              const list = document.getElementById('fileList');
              const diskDetails = document.querySelector('#diskSection .metric-pairs').getBoundingClientRect();
              const networkHeading = document.querySelector('.network-section .section-heading').getBoundingClientRect();
              return {
                width: panel.width,
                height: panel.height,
                columnClientHeight: column.clientHeight,
                columnScrollHeight: column.scrollHeight,
                fileListClientHeight: list.clientHeight,
                fileListScrollHeight: list.scrollHeight,
                diskDetailsClearance: networkHeading.top - diskDetails.bottom
              };
            })(),
            terminalGeometry: (() => {
              const screen = document.querySelector('.terminal-instance:not([hidden]) .xterm-screen').getBoundingClientRect();
              return { width: screen.width, height: screen.height };
            })()
          })`);
          diagnostics.packaged = app.isPackaged;
          const screenshot = await window.webContents.capturePage();
          console.log(`Visual diagnostics: ${JSON.stringify(diagnostics)}`);
          if (!diagnostics.monitoringReady || diagnostics.monitoringSamples < 2) {
            throw new Error('Monitoring did not provide at least two samples');
          }
          if (diagnostics.windowMode.fullscreen || !diagnostics.windowMode.fullscreenable
            || !diagnostics.windowMode.resizable || diagnostics.windowMode.bounds.width !== visualTestWidth
            || diagnostics.windowMode.bounds.height !== visualTestHeight) {
            throw new Error('Window did not start with the requested resizable macOS dimensions');
          }
          if (diagnostics.terminalSessionCount !== 1 || diagnostics.activeTerminal !== 'tty-03'
            || !diagnostics.activeTerminalLabel.includes('03') || !diagnostics.activeTerminalLabel.includes('tmp')
            || !diagnostics.terminalTopObserved
            || diagnostics.terminalExitCount !== 2 || diagnostics.terminalRespawnCount !== 1
            || diagnostics.terminalOfflineMarker || diagnostics.shellStatus !== 'LINK ONLINE') {
            throw new Error('PTY exit lifecycle did not close tabs and respawn the final session');
          }
          if (!diagnostics.systemGroupOn || !diagnostics.filesGroupOn || diagnostics.shortcutCount !== 5
            || diagnostics.systemToggleCount !== 2 || diagnostics.filesToggleCount !== 2
            || diagnostics.scanlinesToggleCount < 3 || diagnostics.scanlinesEnabled
            || diagnostics.soundToggleCount < 3 || diagnostics.soundEnabled) {
            throw new Error('HUD shortcut test did not restore the expected state');
          }
          const visibility = diagnostics.dataVisibilityGeometry;
          const expectedVisibilityStates = ['both', 'files-only', 'none', 'system-only'];
          if (expectedVisibilityStates.some((state) => !diagnostics.dataVisibilityStates.split(',').includes(state))
            || !visibility.both?.panelVisible || !visibility.both?.systemVisible || !visibility.both?.filesVisible
            || !visibility['files-only']?.panelVisible || visibility['files-only']?.systemVisible || !visibility['files-only']?.filesVisible
            || !visibility['system-only']?.panelVisible || !visibility['system-only']?.systemVisible || visibility['system-only']?.filesVisible
            || visibility.none?.panelVisible || visibility.none?.systemVisible || visibility.none?.filesVisible
            || visibility.none?.terminalWidth < visibility.both?.terminalWidth + 250
            || visibility.none?.terminalScreenWidth < visibility.both?.terminalScreenWidth + 250
            || visibility['files-only']?.fileListHeight < 200
            || visibility['system-only']?.visibleProcessCount < 3) {
            throw new Error('Independent SYSTEM/FILES visibility combinations or terminal refit are invalid');
          }
          if (!diagnostics.fileBrowserReady || !diagnostics.fileBrowserCwd.includes('tmp') || diagnostics.fileCount < 1) {
            throw new Error('File browser did not follow the active PTY working directory');
          }
          if (!diagnostics.cspLocked || diagnostics.diskValue === '--' || diagnostics.diskUsed === '--'
            || diagnostics.diskAvailable === '--') {
            throw new Error('Disk instrument or strict renderer CSP is not ready');
          }
          if (forceOfflineTest) {
            if (diagnostics.networkState !== 'offline' || diagnostics.networkLan !== '—'
              || diagnostics.networkPublic !== '—' || diagnostics.networkPing !== '—') {
              throw new Error('Offline network degradation did not produce safe placeholders');
            }
          } else if (diagnostics.networkState !== 'online'
            || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(diagnostics.networkLan)
            || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(diagnostics.networkPublic)
            || !/^\d+ms$/.test(diagnostics.networkPing)) {
            throw new Error('LAN/public IPv4, state or ping monitoring is not ready');
          }
          if (diagnostics.batteryPresent === diagnostics.batteryHidden
            || (diagnostics.batteryPresent && !/^\d+%$/.test(diagnostics.batteryValue))) {
            throw new Error('Battery visibility does not match machine capabilities');
          }
          if (diagnostics.telemetryGeometry.width < 320 || diagnostics.telemetryGeometry.width > 340
            || diagnostics.telemetryGeometry.columnScrollHeight > diagnostics.telemetryGeometry.columnClientHeight + 2
            || diagnostics.telemetryGeometry.fileListClientHeight < 30
            || diagnostics.telemetryGeometry.diskDetailsClearance < 6
            || diagnostics.terminalGeometry.width < minimumVisualTerminalWidth || diagnostics.terminalGeometry.height < 100) {
            throw new Error('Two-column layout has invalid geometry or scroll ownership');
          }
          const screenshotPath = path.join(
            os.tmpdir(),
            `edex-ui-bk-phase9-${visualTestWidth}x${visualTestHeight}${app.isPackaged ? '-packaged' : forceOfflineTest ? '-offline' : ''}.png`
          );
          fs.writeFileSync(screenshotPath, screenshot.toPNG());
          console.log(`Visual test screenshot: ${screenshotPath}`);
          process.exitCode = 0;
        } catch (error) {
          console.error(`Visual test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 13_500);
    });
  }
}

app.whenReady().then(() => {
  registerTerminalIpc();
  registerFilesIpc();
  registerMonitoringIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (gracefulShutdownStarted) return;
  event.preventDefault();
  gracefulShutdownStarted = true;
  clearTimeout(smokeTimeout);
  for (const webContentsId of terminals.keys()) {
    disposeTerminal(webContentsId);
  }
  for (const webContentsId of monitoringSessions.keys()) {
    disposeMonitoring(webContentsId);
  }
  setTimeout(() => app.exit(process.exitCode || 0), 250);
});
