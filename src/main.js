'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const si = require('systeminformation');

const isSmokeTest = process.env.EDEX_SMOKE_TEST === '1';
const isVisualTest = process.env.EDEX_VISUAL_TEST === '1';
const isAutomatedTest = isSmokeTest || isVisualTest;
const terminals = new Map();
const monitoringSessions = new Map();
let smokeTimeout;
let gracefulShutdownStarted = false;

const MONITOR_INTERVAL_MS = 1_000;
const PROCESS_REFRESH_TICKS = 3;
const DISK_REFRESH_TICKS = 10;
const MAX_TERMINALS_PER_WINDOW = 8;
const MAX_FILE_ENTRIES = 80;

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

  if (clientTerminals.size === 0) terminals.delete(webContentsId);
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

async function collectNetworkMetric() {
  let interfaceName = await si.networkInterfaceDefault();

  if (!interfaceName) {
    const interfaces = await si.networkInterfaces();
    const preferred = interfaces.find((item) => item.default)
      || interfaces.find((item) => !item.internal && !item.virtual && item.operstate === 'up')
      || interfaces.find((item) => !item.internal && item.operstate === 'up');
    interfaceName = preferred?.iface || '';
  }

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
  const [cpuResult, memoryResult, networkResult, diskResult, processesResult] = await Promise.allSettled([
    si.currentLoad(),
    si.mem(),
    collectNetworkMetric(),
    refreshDisk ? collectDiskMetric() : Promise.resolve(session.cache.disk),
    refreshProcesses ? collectProcessesMetric() : Promise.resolve(session.cache.processes)
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
  if (diskResult.status === 'fulfilled') session.cache.disk = disk;
  if (processesResult.status === 'fulfilled') session.cache.processes = processes;

  const errors = {
    cpu: rejectedMessage(cpuResult),
    memory: rejectedMessage(memoryResult),
    network: rejectedMessage(networkResult),
    disk: rejectedMessage(diskResult),
    processes: rejectedMessage(processesResult)
  };
  const errorCount = Object.values(errors).filter(Boolean).length;
  session.tick += 1;

  return {
    timestamp: Date.now(),
    status: errorCount === 0 ? 'ok' : errorCount === 5 ? 'error' : 'partial',
    session: {
      hostname: safeLabel(os.hostname().replace(/\.local$/i, ''), 'LOCALHOST', 36),
      uptimeSeconds: Math.max(Math.floor(os.uptime()), 0)
    },
    cpu,
    memory,
    network,
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
      cache: { disk: null, processes: null }
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

    terminal.onData((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('terminal:data', { sessionId, data });
      }
    });

    terminal.onExit(({ exitCode, signal }) => {
      clientTerminals.delete(sessionId);
      if (clientTerminals.size === 0) terminals.delete(event.sender.id);
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
    width: 1440,
    height: 900,
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
          press('Digit1');
          if (document.body.classList.contains('scanlines-on')) press('KeyL', true);
          press('KeyL', true);
          press('KeyL', true);
          if (document.body.dataset.soundEnabled === 'true') press('KeyS', true);
          press('KeyS', true);
          press('KeyS', true);
          setTimeout(() => window.terminalApi.write('tty-02', 'exit\\r'), 500);
          setTimeout(() => window.terminalApi.write('tty-01', 'exit\\r'), 1_300);
          const changeRespawnedSessionDirectory = (attempt = 0) => {
            const activeTab = document.querySelector('#ttyTabs .tty-tab.is-active')?.textContent;
            const shellOnline = document.getElementById('shellStatusText').textContent === 'LINK ONLINE';
            if (activeTab === 'TTY 03' && shellOnline) {
              window.terminalApi.write('tty-03', 'cd /tmp\\r');
            } else if (attempt < 20) {
              setTimeout(() => changeRespawnedSessionDirectory(attempt + 1), 250);
            }
          };
          setTimeout(changeRespawnedSessionDirectory, 2_200);
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
            terminalSessionCount: document.querySelectorAll('#ttyTabs .tty-tab').length,
            activeTerminal: document.querySelector('#ttyTabs .tty-tab.is-active')?.textContent || null,
            terminalExitCount: Number(document.body.dataset.terminalExitCount || 0),
            terminalRespawnCount: Number(document.body.dataset.terminalRespawnCount || 0),
            terminalOfflineMarker: document.querySelector('.terminal-instance:not([hidden])')?.textContent.includes('SHELL OFFLINE') || false,
            telemetryPanelOn: !document.body.classList.contains('telemetry-panel-hidden'),
            telemetryToggleCount: Number(document.body.dataset.telemetryToggleCount || 0),
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
            diskValue: document.getElementById('diskValue').textContent,
            processCount: document.querySelectorAll('#processList .process-row').length,
            gridColumns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,
            telemetryGeometry: (() => {
              const panel = document.getElementById('telemetryPanel').getBoundingClientRect();
              const column = document.querySelector('.telemetry-column');
              const list = document.getElementById('fileList');
              return {
                width: panel.width,
                height: panel.height,
                columnClientHeight: column.clientHeight,
                columnScrollHeight: column.scrollHeight,
                fileListClientHeight: list.clientHeight,
                fileListScrollHeight: list.scrollHeight
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
            || !diagnostics.windowMode.resizable || diagnostics.windowMode.bounds.width !== 1440
            || diagnostics.windowMode.bounds.height !== 900) {
            throw new Error('Window did not start as a resizable 1440x900 macOS window');
          }
          if (diagnostics.terminalSessionCount !== 1 || diagnostics.activeTerminal !== 'TTY 03'
            || diagnostics.terminalExitCount !== 2 || diagnostics.terminalRespawnCount !== 1
            || diagnostics.terminalOfflineMarker || diagnostics.shellStatus !== 'LINK ONLINE') {
            throw new Error('PTY exit lifecycle did not close tabs and respawn the final session');
          }
          if (!diagnostics.telemetryPanelOn || diagnostics.shortcutCount !== 4
            || diagnostics.telemetryToggleCount !== 2
            || diagnostics.scanlinesToggleCount < 3 || diagnostics.scanlinesEnabled
            || diagnostics.soundToggleCount < 3 || diagnostics.soundEnabled) {
            throw new Error('HUD shortcut test did not restore the expected state');
          }
          if (!diagnostics.fileBrowserReady || !diagnostics.fileBrowserCwd.includes('tmp') || diagnostics.fileCount < 1) {
            throw new Error('File browser did not follow the active PTY working directory');
          }
          if (diagnostics.telemetryGeometry.width < 320 || diagnostics.telemetryGeometry.width > 340
            || diagnostics.telemetryGeometry.columnScrollHeight > diagnostics.telemetryGeometry.columnClientHeight + 2
            || diagnostics.telemetryGeometry.fileListClientHeight < 30
            || diagnostics.terminalGeometry.width < 850 || diagnostics.terminalGeometry.height < 100) {
            throw new Error('Two-column layout has invalid geometry or scroll ownership');
          }
          const screenshotPath = path.join(
            os.tmpdir(),
            app.isPackaged ? 'edex-ui-bk-phase6-packaged.png' : 'edex-ui-bk-phase6.png'
          );
          fs.writeFileSync(screenshotPath, screenshot.toPNG());
          console.log(`Visual test screenshot: ${screenshotPath}`);
          process.exitCode = 0;
        } catch (error) {
          console.error(`Visual test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 10_500);
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
