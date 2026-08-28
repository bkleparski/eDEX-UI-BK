'use strict';

const { app, BrowserWindow, dialog, ipcMain, nativeImage, net, shell } = require('electron');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const si = require('systeminformation');
const { AssistantService } = require('./main/assistant/assistant-service');
const { PROVIDER_IDS } = require('./main/assistant/contracts');
const { LMStudioProvider } = require('./main/assistant/lmstudio-provider');
const { LocalCliBridge } = require('./main/assistant/local-cli-bridge');
const { OllamaProvider } = require('./main/assistant/ollama-provider');
const { OpenCodeGoProvider } = require('./main/assistant/opencode-go-provider');
const { OpenRouterProvider } = require('./main/assistant/openrouter-provider');
const { ProviderRegistry } = require('./main/assistant/provider-registry');
const { ConfigStore } = require('./main/config-store');

const isSmokeTest = process.env.EDEX_SMOKE_TEST === '1';
const isVisualTest = process.env.EDEX_VISUAL_TEST === '1';
const isAssistantVisualTest = process.env.EDEX_ASSISTANT_VISUAL_TEST === '1';
const forceOfflineTest = process.env.EDEX_FORCE_OFFLINE_TEST === '1';
const isFilesTest = process.env.EDEX_FILES_TEST === '1';
const isPanesTest = process.env.EDEX_PANES_TEST === '1';
const isAutomatedTest = isSmokeTest || isVisualTest || isAssistantVisualTest || isFilesTest || isPanesTest;
const visualTestWidth = Math.max(960, Number.parseInt(process.env.EDEX_VISUAL_WIDTH, 10) || 1440);
const visualTestHeight = Math.max(640, Number.parseInt(process.env.EDEX_VISUAL_HEIGHT, 10) || 900);
const minimumVisualTerminalWidthWithFilesPanel = visualTestWidth < 1200 ? 260 : 350;
const minimumVisualFileListHeight = visualTestHeight < 700 ? 24 : 30;
const visualBrowserRoot = path.join('/private/tmp', 'edex-ui-bk-phase13-browser');
const filesTestRoot = path.join('/private/tmp', 'edex-ui-bk-files-test');
const visualBrowserChild = path.join(visualBrowserRoot, 'child');
const visualBrowserFile = path.join(visualBrowserRoot, "O'Brien phase 11.txt");
const visualBrowserImage = path.join(visualBrowserChild, 'preview.svg');
const visualBrowserLargeImage = path.join(visualBrowserChild, 'too-large.png');
const terminals = new Map();
const terminalMetadataSessions = new Map();
const monitoringSessions = new Map();
const assistantRequests = new Map();
let configStore;
let providerRegistry;
let assistantService;
let localCliBridge;
let smokeTimeout;
let gracefulShutdownStarted = false;

const MONITOR_INTERVAL_MS = 1_000;
const PROCESS_REFRESH_TICKS = 3;
const DISK_REFRESH_TICKS = 10;
const CONNECTIVITY_REFRESH_TICKS = 7;
const BATTERY_REFRESH_TICKS = 30;
const PROCESS_LIST_LIMIT = 14;
const PROCESS_ENERGY_LIMIT = 40;
const PROCESS_ENERGY_REFRESH_TICKS = 9;
const GPU_REFRESH_TICKS = 3;
const TERMINAL_METADATA_INTERVAL_MS = 500;
const SLOW_COMMAND_THRESHOLD_MS = 15_000;
const PUBLIC_IP_CACHE_MS = 5 * 60 * 1_000;
const PUBLIC_IP_TIMEOUT_MS = 3_000;
const PUBLIC_IP_ENDPOINT = 'https://api.ipify.org';
const MAX_TERMINALS_PER_WINDOW = 8;
const MAX_FILE_ENTRIES = 80;
const MAX_BATCH_ENTRIES = 200;
const IMAGE_PREVIEW_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_SOURCE_DIMENSION = 480;
const IMAGE_PREVIEW_CACHE_LIMIT = 24;
const IMAGE_PREVIEW_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const IMAGE_PREVIEW_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml']
]);
const publicIpCache = { value: null, expiresAt: 0, inFlight: null };
const imagePreviewCache = new Map();
let imagePreviewCacheBytes = 0;

if (isAutomatedTest) {
  const testKind = isSmokeTest ? 'smoke' : isAssistantVisualTest ? 'assistant' : isFilesTest ? 'files' : 'visual';
  app.setPath('userData', path.join(os.tmpdir(), `edex-ui-bk-${testKind}-${process.pid}`));
}

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

// A foreground (non-idle) run that lasts long enough to matter, ending back
// at the shell prompt, is worth a notification — but only once it actually
// ends, so a still-running command never fires early and a killed pane never
// fires at all (it just disappears without the idle transition).
function detectCompletedCommand(state, processInfo, now) {
  if (!processInfo.idle) {
    if (state.commandStartedAt === null) state.commandStartedAt = now;
    state.commandName = processInfo.name;
    return null;
  }
  if (state.commandStartedAt === null) return null;
  const durationMs = now - state.commandStartedAt;
  const name = state.commandName;
  state.commandStartedAt = null;
  state.commandName = null;
  return durationMs >= SLOW_COMMAND_THRESHOLD_MS ? { name, durationMs } : null;
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
  const completedCommand = detectCompletedCommand(state, processInfo, now);

  return {
    processName: processInfo.name,
    command: processInfo.command,
    idle: processInfo.idle,
    cwd: state.cwd || null,
    label: processInfo.idle ? compactWorkingDirectory(state.cwd) : processInfo.name,
    completedCommand
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
          state = { cwd: null, cwdCheckedAt: 0, commandStartedAt: null, commandName: null };
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

function validDirectoryPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096
    || value.includes('\0') || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

// File-manager mutations arrive from the renderer, so every path is re-validated
// here and never trusted as-is. The renderer itself never touches the disk.
function validEntryPaths(value) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > MAX_BATCH_ENTRIES) return null;
  const resolved = list.map((item) => validDirectoryPath(item));
  return resolved.every(Boolean) ? [...new Set(resolved)] : null;
}

function validEntryName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 255 || name === '.' || name === '..') return null;
  if (name.includes('\0') || name.includes('/')) return null;
  return name;
}

async function pathExists(target) {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch {
    return false;
  }
}

// Finder-style "name copy.ext" suffixing so a collision never silently overwrites.
async function uniqueDestination(directory, name) {
  const target = path.join(directory, name);
  if (!await pathExists(target)) return target;
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  for (let index = 2; index <= 999; index += 1) {
    const candidate = path.join(directory, `${stem} ${index}${extension}`);
    if (!await pathExists(candidate)) return candidate;
  }
  throw new Error('Could not find a free name in the destination folder.');
}

async function transferEntries(sourcePaths, destinationDirectory, mode) {
  const destination = validDirectoryPath(destinationDirectory);
  if (!destination) throw new Error('Invalid destination folder.');
  const stats = await fs.promises.stat(destination).catch(() => null);
  if (!stats?.isDirectory()) throw new Error('Destination is not a folder.');

  const results = [];
  for (const source of sourcePaths) {
    const name = path.basename(source);
    try {
      if (source === destination || destination.startsWith(`${source}${path.sep}`)) {
        throw new Error('Cannot move a folder into itself.');
      }
      if (path.dirname(source) === destination && mode === 'move') {
        results.push({ path: source, status: 'skipped', reason: 'Already in destination.' });
        continue;
      }
      const target = await uniqueDestination(destination, name);
      if (mode === 'move') {
        try {
          await fs.promises.rename(source, target);
        } catch (error) {
          // EXDEV: crossing a volume boundary needs a copy followed by a delete.
          if (error.code !== 'EXDEV') throw error;
          await fs.promises.cp(source, target, { recursive: true, errorOnExist: true, force: false });
          await fs.promises.rm(source, { recursive: true, force: false });
        }
      } else {
        await fs.promises.cp(source, target, { recursive: true, errorOnExist: true, force: false });
      }
      results.push({ path: source, status: 'ok', target });
    } catch (error) {
      results.push({ path: source, status: 'error', reason: safeLabel(error.message, 'Operation failed.', 160) });
    }
  }
  return { status: results.some((item) => item.status === 'error') ? 'partial' : 'ok', results };
}

function cachedImagePreview(cacheKey) {
  const cached = imagePreviewCache.get(cacheKey);
  if (!cached) return null;
  imagePreviewCache.delete(cacheKey);
  imagePreviewCache.set(cacheKey, cached);
  return cached.response;
}

function cacheImagePreview(cacheKey, response) {
  const bytes = Buffer.byteLength(response.dataUri || '', 'utf8');
  if (bytes > IMAGE_PREVIEW_CACHE_MAX_BYTES) return;
  const existing = imagePreviewCache.get(cacheKey);
  if (existing) imagePreviewCacheBytes -= existing.bytes;
  imagePreviewCache.set(cacheKey, { response, bytes });
  imagePreviewCacheBytes += bytes;
  while (imagePreviewCache.size > IMAGE_PREVIEW_CACHE_LIMIT
    || imagePreviewCacheBytes > IMAGE_PREVIEW_CACHE_MAX_BYTES) {
    const oldestKey = imagePreviewCache.keys().next().value;
    const oldest = imagePreviewCache.get(oldestKey);
    imagePreviewCache.delete(oldestKey);
    imagePreviewCacheBytes -= oldest.bytes;
  }
}

async function readBoundedFile(fileHandle, size) {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await fileHandle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === size ? buffer : buffer.subarray(0, offset);
}

function imagePreviewData(buffer, mimeType) {
  try {
    const decoded = nativeImage.createFromBuffer(buffer);
    if (!decoded.isEmpty()) {
      const size = decoded.getSize();
      const scale = Math.min(1, IMAGE_PREVIEW_MAX_SOURCE_DIMENSION / Math.max(size.width, size.height));
      const preview = scale < 1
        ? decoded.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: 'good'
        })
        : decoded;
      const previewSize = preview.getSize();
      return { dataUri: preview.toDataURL(), width: previewSize.width, height: previewSize.height };
    }
  } catch {
    // Chromium can still render supported image formats directly from a data URI.
  }
  return { dataUri: `data:${mimeType};base64,${buffer.toString('base64')}`, width: null, height: null };
}

async function previewImageFile(filePath) {
  const normalizedPath = validDirectoryPath(filePath);
  const mimeType = normalizedPath ? IMAGE_PREVIEW_MIME_TYPES.get(path.extname(normalizedPath).toLowerCase()) : null;
  if (!normalizedPath || !mimeType) return { status: 'unsupported' };

  let fileHandle;
  try {
    fileHandle = await fs.promises.open(normalizedPath, 'r');
    const stats = await fileHandle.stat();
    if (!stats.isFile()) return { status: 'unsupported' };
    if (stats.size > IMAGE_PREVIEW_MAX_BYTES) {
      return { status: 'too-large', maxBytes: IMAGE_PREVIEW_MAX_BYTES, size: stats.size };
    }

    const cacheKey = `${normalizedPath}\0${stats.size}\0${stats.mtimeMs}`;
    const cached = cachedImagePreview(cacheKey);
    if (cached) return cached;

    const buffer = await readBoundedFile(fileHandle, stats.size);
    const image = imagePreviewData(buffer, mimeType);
    const response = {
      status: 'ok',
      ...image,
      path: normalizedPath,
      sourceBytes: buffer.length
    };
    cacheImagePreview(cacheKey, response);
    return response;
  } catch {
    return { status: 'error' };
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

async function enrichFileEntries(entries) {
  return Promise.all(entries.map(async (entry) => {
    try {
      const stats = await fs.promises.lstat(entry.fullPath);
      return {
        ...entry,
        sizeBytes: entry.type === 'file' ? Math.max(finiteNumber(stats.size, 0), 0) : null,
        modifiedMs: finiteNumber(stats.mtimeMs, null)
      };
    } catch {
      return { ...entry, sizeBytes: null, modifiedMs: null };
    }
  }));
}

async function listDirectoryFiles(cwd, sessionId, showHidden = false) {
  try {
    const directoryEntries = await fs.promises.readdir(cwd, { withFileTypes: true });
    const entries = directoryEntries
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .map((entry) => ({
        name: safeLabel(entry.name, 'UNKNOWN', 96),
        fullPath: path.join(cwd, entry.name),
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
      cwd,
      parentPath: cwd === path.parse(cwd).root ? null : path.dirname(cwd),
      entries: await enrichFileEntries(entries.slice(0, MAX_FILE_ENTRIES)),
      totalCount: entries.length,
      truncated: entries.length > MAX_FILE_ENTRIES
    };
  } catch {
    return {
      status: 'error',
      sessionId,
      cwd: null,
      parentPath: null,
      entries: [],
      totalCount: 0,
      truncated: false
    };
  }
}

async function listTerminalFiles(terminal, sessionId, showHidden = false) {
  try {
    return listDirectoryFiles(await terminalWorkingDirectory(terminal), sessionId, showHidden);
  } catch {
    return {
      status: 'error',
      sessionId,
      cwd: null,
      parentPath: null,
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
async function collectGpuMetric() {
  const stdout = await runCommand('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator', '-w', '0'], 2_000);
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

// `top` reports energy impact only from its second sample on, so this costs a
// second of wall time and runs on its own slow cadence, off the telemetry tick.
async function collectProcessEnergy() {
  const stdout = await runCommand('top', [
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

async function collectMonitoringSample(session) {
  const refreshProcesses = !session.cache.processes || session.tick % PROCESS_REFRESH_TICKS === 0;
  const refreshDisk = !session.cache.disk || session.tick % DISK_REFRESH_TICKS === 0;
  const refreshConnectivity = !session.cache.connectivity || session.tick % CONNECTIVITY_REFRESH_TICKS === 0;
  const refreshBattery = !session.cache.battery || session.tick % BATTERY_REFRESH_TICKS === 0;
  const refreshGpu = !session.cache.gpu || session.tick % GPU_REFRESH_TICKS === 0;
  refreshProcessEnergy(session);
  const [cpuResult, memoryResult, networkResult, diskResult, processesResult, connectivityResult, batteryResult, gpuResult] = await Promise.allSettled([
    si.currentLoad(),
    si.mem(),
    collectNetworkMetric(session.cache.connectivity?.interface),
    refreshDisk ? collectDiskMetric() : Promise.resolve(session.cache.disk),
    refreshProcesses ? collectProcessesMetric(session.cache.energyByPid) : Promise.resolve(session.cache.processes),
    refreshConnectivity ? collectConnectivityMetric() : Promise.resolve(session.cache.connectivity),
    refreshBattery ? collectBatteryMetric() : Promise.resolve(session.cache.battery),
    refreshGpu ? collectGpuMetric() : Promise.resolve(session.cache.gpu)
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
    gpu,
    processes: topProcessesForEveryColumn(processes || []),
    energyAvailable: Boolean(session.cache.energyByPid),
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
      cache: { disk: null, processes: null, connectivity: null, battery: null, energyByPid: null, energyError: null, gpu: null }
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
    const assistantBinPath = app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(__dirname, '..', 'resources', 'bin');
    const terminal = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: {
        ...process.env,
        SHELL: shell,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...localCliBridge?.environment(assistantBinPath)
      }
    });

    clientTerminals.set(sessionId, terminal);
    ensureTerminalMetadataSession(event.sender, sessionId).states.set(sessionId, {
      cwd: os.homedir(), cwdCheckedAt: 0, commandStartedAt: null, commandName: null
    });

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
      if (!event.sender.isDestroyed() && !gracefulShutdownStarted) {
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

  ipcMain.on('terminal:close', (event, payload) => {
    const sessionId = validSessionId(payload?.sessionId);
    if (!isTrustedSender(event) || !sessionId) return;
    const terminal = terminals.get(event.sender.id)?.get(sessionId);
    if (!terminal) return;
    try {
      terminal.kill();
    } catch {
      // The PTY may have exited between the renderer request and this handler.
    }
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
    const showHidden = payload.showHidden === true;
    if (!sessionId) throw new Error('Invalid terminal session ID.');
    if (payload.directoryPath !== null && payload.directoryPath !== undefined) {
      const directoryPath = validDirectoryPath(payload.directoryPath);
      if (!directoryPath) {
        return { status: 'error', sessionId, cwd: null, parentPath: null, entries: [], totalCount: 0, truncated: false };
      }
      return listDirectoryFiles(directoryPath, sessionId, showHidden);
    }
    const terminal = terminals.get(event.sender.id)?.get(sessionId);
    if (!terminal) {
      return { status: 'error', sessionId, cwd: null, parentPath: null, entries: [], totalCount: 0, truncated: false };
    }
    return listTerminalFiles(terminal, sessionId, showHidden);
  });

  ipcMain.handle('files:preview', async (event, payload = {}) => {
    requireTrustedSender(event);
    return previewImageFile(payload.filePath);
  });

  ipcMain.handle('files:open', async (event, payload = {}) => {
    requireTrustedSender(event);
    const [target] = validEntryPaths(payload.filePath) || [];
    if (!target) throw new Error('Invalid file path.');
    const message = await shell.openPath(target);
    if (message) throw new Error(safeLabel(message, 'Could not open the file.', 160));
    return { status: 'ok' };
  });

  ipcMain.handle('files:reveal', async (event, payload = {}) => {
    requireTrustedSender(event);
    const [target] = validEntryPaths(payload.filePath) || [];
    if (!target) throw new Error('Invalid file path.');
    shell.showItemInFolder(target);
    return { status: 'ok' };
  });

  ipcMain.handle('files:rename', async (event, payload = {}) => {
    requireTrustedSender(event);
    const [target] = validEntryPaths(payload.filePath) || [];
    const name = validEntryName(payload.name);
    if (!target || !name) throw new Error('Invalid rename request.');
    const destination = path.join(path.dirname(target), name);
    if (destination === target) return { status: 'ok', target };
    if (await pathExists(destination)) throw new Error('A file with that name already exists.');
    await fs.promises.rename(target, destination);
    return { status: 'ok', target: destination };
  });

  ipcMain.handle('files:trash', async (event, payload = {}) => {
    requireTrustedSender(event);
    const targets = validEntryPaths(payload.filePaths);
    if (!targets) throw new Error('Invalid delete request.');
    const results = [];
    for (const target of targets) {
      try {
        await shell.trashItem(target);
        results.push({ path: target, status: 'ok' });
      } catch (error) {
        results.push({ path: target, status: 'error', reason: safeLabel(error.message, 'Could not move to Trash.', 160) });
      }
    }
    return { status: results.some((item) => item.status === 'error') ? 'partial' : 'ok', results };
  });

  ipcMain.handle('files:transfer', async (event, payload = {}) => {
    requireTrustedSender(event);
    const targets = validEntryPaths(payload.filePaths);
    const mode = payload.mode === 'copy' ? 'copy' : 'move';
    if (!targets) throw new Error('Invalid transfer request.');
    return transferEntries(targets, payload.destination, mode);
  });

  ipcMain.handle('files:mkdir', async (event, payload = {}) => {
    requireTrustedSender(event);
    const parent = validDirectoryPath(payload.parentPath);
    const name = validEntryName(payload.name);
    if (!parent || !name) throw new Error('Invalid folder request.');
    const destination = path.join(parent, name);
    if (await pathExists(destination)) throw new Error('That folder already exists.');
    await fs.promises.mkdir(destination);
    return { status: 'ok', target: destination };
  });

  ipcMain.handle('files:choose-directory', async (event, payload = {}) => {
    requireTrustedSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = validDirectoryPath(payload.defaultPath);
    const result = await dialog.showOpenDialog(window, {
      title: 'Wybierz katalog docelowy',
      buttonLabel: 'Przenieś tutaj',
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {})
    });
    if (result.canceled || !result.filePaths.length) return { status: 'cancelled' };
    return { status: 'ok', directory: result.filePaths[0] };
  });

  ipcMain.handle('files:confirm', async (event, payload = {}) => {
    requireTrustedSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Anuluj', safeLabel(payload.confirmLabel, 'Potwierdź', 40)],
      defaultId: 1,
      cancelId: 0,
      message: safeLabel(payload.message, 'Potwierdzić operację?', 200),
      detail: safeLabel(payload.detail, '', 400) || undefined
    });
    return { confirmed: result.response === 1 };
  });
}

function configureCloudProviders() {
  const config = configStore.get();
  providerRegistry.register(new OpenRouterProvider({ apiKey: config.secrets.openRouterApiKey }));
  providerRegistry.register(new OpenCodeGoProvider({ apiKey: config.secrets.openCodeGoApiKey }));
  return config;
}

function assistantRequestMap(webContents) {
  let requests = assistantRequests.get(webContents.id);
  if (!requests) {
    requests = new Map();
    assistantRequests.set(webContents.id, requests);
    webContents.once('destroyed', () => disposeAssistantRequests(webContents.id));
  }
  return requests;
}

function disposeAssistantRequests(webContentsId) {
  const requests = assistantRequests.get(webContentsId);
  if (!requests) return;
  for (const controller of requests.values()) controller.abort();
  assistantRequests.delete(webContentsId);
}

function assistantErrorPayload(error) {
  return {
    type: 'error',
    code: error?.code || 'ASSISTANT_ERROR',
    message: typeof error?.message === 'string' ? error.message : 'Assistant request failed.',
    provider: error?.provider || null,
    status: error?.status || null,
    retryAfter: error?.retryAfter || null
  };
}

function requireConfiguredCloudProvider(provider, config) {
  if (provider === PROVIDER_IDS.OPENROUTER && !config.secrets.openRouterApiKey) {
    throw new Error('OpenRouter API key is not configured.');
  }
  if (provider === PROVIDER_IDS.OPENCODE_GO && !config.secrets.openCodeGoApiKey) {
    throw new Error('OpenCode Go API key is not configured.');
  }
}

function registerAssistantIpc() {
  ipcMain.handle('settings:get', (event) => {
    requireTrustedSender(event);
    return configStore.getPublic();
  });

  ipcMain.handle('settings:update', (event, patch) => {
    requireTrustedSender(event);
    const updated = configStore.update(patch);
    configureCloudProviders();
    return updated;
  });

  ipcMain.handle('assistant:list-models', async (event, payload = {}) => {
    requireTrustedSender(event);
    const provider = payload.provider;
    const config = configureCloudProviders();
    requireConfiguredCloudProvider(provider, config);
    return providerRegistry.listModels(provider);
  });

  ipcMain.handle('assistant:test-provider', async (event, payload = {}) => {
    requireTrustedSender(event);
    const providerId = payload.provider;
    const config = configureCloudProviders();
    requireConfiguredCloudProvider(providerId, config);
    const provider = providerRegistry.get(providerId);
    if (typeof provider.testConnection === 'function') return provider.testConnection();
    const models = await provider.listModels();
    return { ok: true, modelCount: models.length };
  });

  ipcMain.handle('assistant:start', async (event, payload = {}) => {
    requireTrustedSender(event);
    const config = configureCloudProviders();
    const provider = config.selection.hudProvider;
    const model = config.selection.models[provider];
    requireConfiguredCloudProvider(provider, config);
    if (!model) throw new Error(`No active model selected for ${provider}.`);
    const requestId = typeof payload.requestId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(payload.requestId)
      ? payload.requestId
      : `hud-${randomUUID()}`;
    const requests = assistantRequestMap(event.sender);
    if (requests.has(requestId)) throw new Error('Assistant request ID is already active.');
    const controller = new AbortController();
    requests.set(requestId, controller);
    const send = (assistantEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send('assistant:event', assistantEvent);
    };
    try {
      return await assistantService.run({
        requestId,
        conversationId: payload.conversationId,
        prompt: payload.prompt,
        mode: payload.mode,
        surface: 'hud',
        provider,
        model
      }, { signal: controller.signal, onEvent: send });
    } catch (error) {
      const failure = assistantErrorPayload(error);
      send({ requestId, ...failure });
      return { ok: false, requestId, error: failure };
    } finally {
      requests.delete(requestId);
    }
  });

  ipcMain.on('assistant:cancel', (event, payload = {}) => {
    if (!isTrustedSender(event) || typeof payload.requestId !== 'string') return;
    assistantRequests.get(event.sender.id)?.get(payload.requestId)?.abort();
  });

  ipcMain.on('assistant:reset', (event, payload = {}) => {
    if (!isTrustedSender(event) || typeof payload.conversationId !== 'string') return;
    assistantService.resetConversation(payload.conversationId);
  });

  ipcMain.handle('assistant:open-source', async (event, payload = {}) => {
    requireTrustedSender(event);
    let target;
    try {
      target = new URL(payload.url);
    } catch {
      throw new Error('Invalid source URL.');
    }
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported source URL.');
    await shell.openExternal(target.href);
    return { opened: true };
  });
}

function createWindow() {
  if (isFilesTest) {
    fs.rmSync(filesTestRoot, { recursive: true, force: true });
    fs.mkdirSync(filesTestRoot, { recursive: true });
    fs.writeFileSync(path.join(filesTestRoot, 'alpha.txt'), 'alpha fixture\n');
    fs.writeFileSync(path.join(filesTestRoot, 'beta.txt'), 'beta fixture\n');
    fs.writeFileSync(path.join(filesTestRoot, 'gamma.log'), 'gamma fixture\n');
    fs.mkdirSync(path.join(filesTestRoot, 'nested'), { recursive: true });
  }

  if (isVisualTest) {
    fs.mkdirSync(visualBrowserChild, { recursive: true });
    for (let index = 0; index < 90; index += 1) {
      fs.mkdirSync(path.join(visualBrowserRoot, `.hidden-${String(index).padStart(3, '0')}`), { recursive: true });
    }
    ['Desktop', 'Documents', 'Downloads', 'Pictures'].forEach((directoryName) => {
      fs.mkdirSync(path.join(visualBrowserRoot, directoryName), { recursive: true });
    });
    fs.writeFileSync(visualBrowserFile, 'phase 11 drag fixture\n');
    fs.writeFileSync(path.join(visualBrowserChild, 'inside.txt'), 'phase 11 browsing fixture\n');
    fs.writeFileSync(visualBrowserImage, `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
      <rect width="320" height="180" fill="#02080a"/>
      <path d="M0 135 L78 72 L132 108 L206 38 L320 126 V180 H0 Z" fill="#087f9c" opacity=".64"/>
      <path d="M0 145 L78 82 L132 118 L206 48 L320 136" fill="none" stroke="#00e5ff" stroke-width="4"/>
      <rect x="18" y="18" width="284" height="144" fill="none" stroke="#8ff8ff" stroke-width="2"/>
      <text x="30" y="54" fill="#8ff8ff" font-family="monospace" font-size="22">EDEX PREVIEW</text>
      <text x="30" y="78" fill="#00e5ff" font-family="monospace" font-size="12">PHASE 12 / 320x180</text>
    </svg>`);
    fs.writeFileSync(visualBrowserLargeImage, '');
    fs.truncateSync(visualBrowserLargeImage, IMAGE_PREVIEW_MAX_BYTES + 1);
  }

  const window = new BrowserWindow({
    width: isVisualTest || isAssistantVisualTest ? visualTestWidth : 1440,
    height: isVisualTest || isAssistantVisualTest ? visualTestHeight : 900,
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
    isAutomatedTest
      ? { query: { test: isSmokeTest ? 'smoke' : isAssistantVisualTest ? 'assistant' : isFilesTest ? 'files' : isPanesTest ? 'panes' : 'visual' } }
      : undefined
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
          const dispatchTestFileDrag = (shouldDrop) => {
            const target = document.querySelector('.terminal-surface');
            const transfer = new DataTransfer();
            transfer.setData('application/x-edex-ui-bk-test-paths', JSON.stringify([
              '/tmp/eDEX drag one.txt',
              "/tmp/O'Brien [v2].log"
            ]));
            const dispatch = (type) => target.dispatchEvent(new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
            dispatch('dragenter');
            dispatch('dragover');
            if (shouldDrop) dispatch('drop');
          };
          const dispatchPanelFileDrag = (row) => {
            const target = document.querySelector('.terminal-surface');
            const transfer = new DataTransfer();
            row.dispatchEvent(new DragEvent('dragstart', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
            const dispatch = (type, dispatchTarget = target) => dispatchTarget.dispatchEvent(new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
            dispatch('dragenter');
            dispatch('dragover');
            dispatch('drop');
            dispatch('dragend', row);
          };
          const openRow = (row) => {
            if (!row) return;
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          };
          const dispatchPreviewPointer = (row, type = 'pointerover') => {
            const rect = row.getBoundingClientRect();
            row.dispatchEvent(new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: rect.right - 8,
              clientY: rect.top + (rect.height / 2),
              relatedTarget: null
            }));
          };
          const dispatchPreviewDragCycle = (row) => {
            const transfer = new DataTransfer();
            row.dispatchEvent(new DragEvent('dragstart', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
            row.dispatchEvent(new DragEvent('dragend', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
          };
          const dispatchTTYContextMenu = (tab, clientX = null, clientY = null) => {
            const rect = tab.getBoundingClientRect();
            const event = new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: clientX ?? rect.right - 2,
              clientY: clientY ?? rect.bottom - 2
            });
            const accepted = tab.dispatchEvent(event);
            document.body.dataset.ttyNativeMenuPrevented = String(!accepted && event.defaultPrevented);
          };
          const dismissTTYMenuWithEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true
          }));
          const submitTTYRename = (name) => {
            const input = document.getElementById('ttyRenameInput');
            input.value = name;
            input.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              bubbles: true,
              cancelable: true
            }));
          };
          press('KeyT');
          press('Digit1');
          setTimeout(() => press('Digit2'), 200);
          setTimeout(() => press('Digit2'), 400);
          setTimeout(() => press('Digit2'), 600);
          setTimeout(() => press('Digit1'), 3_000);
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
              && document.getElementById('shellStatusText').textContent === 'LINK ONLINE'
              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.type === 'directory'),
            () => {
              const backgroundTab = document.querySelector('.tty-tab[data-session-id="tty-01"]');
              dispatchTTYContextMenu(backgroundTab, window.innerWidth - 2, window.innerHeight - 2);
              waitFor(
                () => document.body.dataset.ttyContextMenuOpen === 'true'
                  && document.body.dataset.ttyContextSessionId === 'tty-01',
                () => {
                  const menuRect = document.getElementById('ttyContextMenu').getBoundingClientRect();
                  document.body.dataset.ttyContextViewportSafe = String(
                    menuRect.left >= 0 && menuRect.top >= 0
                      && menuRect.right <= window.innerWidth && menuRect.bottom <= window.innerHeight
                  );
                  dismissTTYMenuWithEscape();
                  waitFor(
                    () => document.body.dataset.ttyContextMenuOpen === 'false',
                    () => {
                      document.body.dataset.ttyContextEscapeClosed = 'true';
                      dispatchTTYContextMenu(backgroundTab);
                      document.querySelector('#ttyContextMenu [data-action="rename"]').click();
                      waitFor(
                        () => document.body.dataset.ttyRenameOpen === 'true',
                        () => {
                          document.getElementById('ttyRenameInput').value = 'CANCELLED NAME';
                          dismissTTYMenuWithEscape();
                          waitFor(
                            () => document.body.dataset.ttyRenameOpen === 'false'
                              && backgroundTab.dataset.manualName === '',
                            () => {
                              document.body.dataset.ttyRenameEscapeCancelled = 'true';
                              dispatchTTYContextMenu(backgroundTab);
                              document.querySelector('#ttyContextMenu [data-action="rename"]').click();
                              waitFor(
                                () => document.body.dataset.ttyRenameOpen === 'true',
                                () => {
                                  submitTTYRename('OPS CONTROL');
                                  waitFor(
                                    () => backgroundTab.dataset.manualName === 'OPS CONTROL'
                                      && document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId === 'tty-02',
                                    () => {
                                      setTimeout(() => {
                                        if (backgroundTab.dataset.manualName === 'OPS CONTROL'
                                          && backgroundTab.querySelector('.tty-context').textContent === 'OPS CONTROL') {
                                          document.body.dataset.ttyManualNamePersisted = 'true';
                                        }
                                        dispatchTTYContextMenu(backgroundTab);
                                        waitFor(
                                          () => !document.querySelector('#ttyContextMenu [data-action="auto-name"]').hidden,
                                          () => {
                                            document.querySelector('#ttyContextMenu [data-action="auto-name"]').click();
                                            waitFor(
                                              () => Number(document.body.dataset.ttyAutoNameResetCount || 0) === 1
                                                && backgroundTab.dataset.manualName === '',
                                              () => {
                                                dispatchTTYContextMenu(backgroundTab);
                                                document.querySelector('.terminal-surface').dispatchEvent(new PointerEvent('pointerdown', {
                                                  bubbles: true,
                                                  cancelable: true
                                                }));
                                                waitFor(
                                                  () => document.body.dataset.ttyContextMenuOpen === 'false',
                                                  () => {
                                                    document.body.dataset.ttyContextOutsideClosed = 'true';
                                                    dispatchTTYContextMenu(backgroundTab);
                                                    document.querySelector('#ttyContextMenu [data-action="rename"]').click();
                                                    waitFor(
                                                      () => document.body.dataset.ttyRenameOpen === 'true',
                                                      () => {
                                                        submitTTYRename('PINNED OPERATIONS ALPHA EXTRA');
                                                        waitFor(
                                                          () => backgroundTab.dataset.manualName === 'PINNED OPERATIONS ALPHA',
                                                          () => {
                                                            dispatchTTYContextMenu(backgroundTab);
                                                            waitFor(
                                                              () => !document.querySelector('#ttyContextMenu [data-action="auto-name"]').hidden,
                                                              () => document.querySelector('#ttyContextMenu [data-action="close"]').click()
                                                            );
                                                          }
                                                        );
                                                      }
                                                    );
                                                  }
                                                );
                                              }
                                            );
                                          }
                                        );
                                      }, 1_250);
                                    }
                                  );
                                }
                              );
                            }
                          );
                        }
                      );
                    }
                  );
                }
              );
            }
          );
          waitFor(
            () => Number(document.body.dataset.terminalExitCount || 0) >= 1
              && document.querySelectorAll('#ttyTabs .tty-tab').length === 1
              && document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId === 'tty-02',
            () => {
              document.body.dataset.ttyBackgroundClosePreservedActive = 'true';
              const directory = [...document.querySelectorAll('#fileList .file-row')]
                .find((row) => row.dataset.type === 'directory');
              openRow(directory);
              window.terminalApi.write('tty-02', '/usr/bin/top -l 2 -s 1 >/dev/null\\r');
              waitFor(
                () => document.body.dataset.ttyTopObserved === 'true'
                  && document.body.dataset.fileBrowserMode === 'browsing',
                () => {
                  dispatchTTYContextMenu(document.querySelector('.tty-tab[data-session-id="tty-02"]'));
                  document.querySelector('#ttyContextMenu [data-action="close"]').click();
                }
              );
            }
          );
          waitFor(
            () => document.querySelector('#ttyTabs .tty-tab.is-active')?.dataset.sessionId === 'tty-03'
              && document.getElementById('shellStatusText').textContent === 'LINK ONLINE'
              && Number(document.body.dataset.terminalRespawnCount || 0) === 1
              && document.body.dataset.fileBrowserMode === 'live',
            () => {
              document.body.dataset.ttySoleCloseRespawned = 'true';
              window.terminalApi.write('tty-03', ${JSON.stringify(`cd '${visualBrowserRoot.replace(/'/g, `'\\''`)}'\r`)});
              setTimeout(() => {
                window.terminalApi.write('tty-03', "printf '__EDEX_DROP_OK__<%s><%s>\\\\n' ");
                dispatchTestFileDrag(true);
                setTimeout(() => window.terminalApi.write('tty-03', '\\r'), 100);
              }, 750);
            }
          );
          waitFor(
            () => document.body.dataset.fileBrowserMode === 'live'
              && document.getElementById('fileBrowserCwd').title === ${JSON.stringify(visualBrowserRoot)}
              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.path === ${JSON.stringify(visualBrowserChild)})
              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.name === 'Desktop')
              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.name === 'Documents')
              && ![...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.name.startsWith('.hidden-'))
              && document.getElementById('fileBrowserCount').textContent === '6 ITEMS',
            () => {
              document.body.dataset.dotfilesLiveFiltered = 'true';
              const child = [...document.querySelectorAll('#fileList .file-row')]
                .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserChild)});
              openRow(child);
              waitFor(
                () => document.body.dataset.fileBrowserMode === 'browsing'
                  && document.getElementById('fileBrowserCwd').title === ${JSON.stringify(visualBrowserChild)},
                () => {
                  document.body.dataset.fileBrowserDescended = 'true';
                  openRow(document.querySelector('#fileList .file-row--parent'));
                  waitFor(
                    () => document.body.dataset.fileBrowserMode === 'browsing'
                      && document.getElementById('fileBrowserCwd').title === ${JSON.stringify(visualBrowserRoot)},
                    () => {
                      document.body.dataset.fileBrowserAscended = 'true';
                      press('Period', true);
                      waitFor(
                        () => document.body.dataset.dotfilesVisible === 'true'
                          && document.getElementById('dotfilesToggle').textContent === 'DOTS SHOWN'
                          && document.getElementById('fileBrowserCount').textContent === '96+ ITEMS'
                          && [...document.querySelectorAll('#fileList .file-row')]
                            .some((row) => row.dataset.name.startsWith('.hidden-')),
                        () => {
                          document.body.dataset.dotfilesShownObserved = 'true';
                          press('Period', true);
                          waitFor(
                            () => document.body.dataset.dotfilesVisible === 'false'
                              && document.getElementById('dotfilesToggle').textContent === 'DOTS HIDDEN'
                              && document.getElementById('fileBrowserCount').textContent === '6 ITEMS'
                              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.name === 'Desktop')
                              && [...document.querySelectorAll('#fileList .file-row')].some((row) => row.dataset.name === 'Documents')
                              && ![...document.querySelectorAll('#fileList .file-row')]
                                .some((row) => row.dataset.name.startsWith('.hidden-')),
                            () => {
                              document.body.dataset.dotfilesHiddenRestored = 'true';
                              const file = [...document.querySelectorAll('#fileList .file-row')]
                                .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserFile)});
                              window.terminalApi.write('tty-03', "printf '__EDEX_PANEL_DROP_OK__<%s>\\\\n' ");
                              dispatchPanelFileDrag(file);
                              setTimeout(() => window.terminalApi.write('tty-03', '\\r'), 100);
                              waitFor(
                                () => document.body.dataset.panelDropShellVerified === 'true',
                                () => {
                                  document.getElementById('fileBrowserMode').click();
                                  waitFor(
                                    () => document.body.dataset.fileBrowserMode === 'live',
                                    () => {
                                      document.body.dataset.fileBrowserLiveResumed = 'true';
                                      setTimeout(() => {
                                        const liveChild = [...document.querySelectorAll('#fileList .file-row')]
                                          .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserChild)});
                                        openRow(liveChild);
                                        waitFor(
                                          () => document.body.dataset.fileBrowserMode === 'browsing'
                                            && document.getElementById('fileBrowserCwd').title === ${JSON.stringify(visualBrowserChild)}
                                            && [...document.querySelectorAll('#fileList .file-row')]
                                              .some((row) => row.dataset.path === ${JSON.stringify(visualBrowserImage)}),
                                          () => {
                                            const largeRow = [...document.querySelectorAll('#fileList .file-row')]
                                              .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserLargeImage)});
                                            dispatchPreviewPointer(largeRow);
                                            waitFor(
                                              () => document.getElementById('fileImagePreview').dataset.state === 'message'
                                                && document.getElementById('fileImagePreviewMessage').textContent === 'FILE TOO LARGE',
                                              () => {
                                                document.body.dataset.imagePreviewTooLargeObserved = 'true';
                                                dispatchPreviewPointer(largeRow, 'pointerout');
                                                const previewRow = [...document.querySelectorAll('#fileList .file-row')]
                                                  .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserImage)});
                                                dispatchPreviewPointer(previewRow);
                                                waitFor(
                                                  () => document.body.dataset.imagePreviewVisible === 'true'
                                                    && document.getElementById('fileImagePreview').dataset.state === 'image',
                                                  () => {
                                                    document.body.dataset.imagePreviewFirstObserved = 'true';
                                                    dispatchPreviewDragCycle(previewRow);
                                                    waitFor(
                                                      () => document.body.dataset.imagePreviewHiddenByDrag === 'true'
                                                        && document.body.dataset.imagePreviewVisible === 'false',
                                                      () => {
                                                        const cachedRow = [...document.querySelectorAll('#fileList .file-row')]
                                                          .find((row) => row.dataset.path === ${JSON.stringify(visualBrowserImage)});
                                                        dispatchPreviewPointer(cachedRow);
                                                        waitFor(
                                                          () => document.body.dataset.imagePreviewVisible === 'true',
                                                          () => {
                                                            const preview = document.getElementById('fileImagePreview');
                                                            const image = document.getElementById('fileImagePreviewImage');
                                                            const previewRect = preview.getBoundingClientRect();
                                                            const imageRect = image.getBoundingClientRect();
                                                            document.body.dataset.imagePreviewFinalGeometry = JSON.stringify({
                                                              state: preview.dataset.state,
                                                              hidden: preview.hidden,
                                                              left: previewRect.left,
                                                              top: previewRect.top,
                                                              right: previewRect.right,
                                                              bottom: previewRect.bottom,
                                                              width: previewRect.width,
                                                              height: previewRect.height,
                                                              imageWidth: imageRect.width,
                                                              imageHeight: imageRect.height,
                                                              viewportWidth: window.innerWidth,
                                                              viewportHeight: window.innerHeight
                                                            });
                                                            document.body.dataset.imagePreviewFinalObserved = 'true';
                                                            dispatchPreviewPointer(cachedRow, 'pointerout');
                                                            openRow(document.querySelector('#fileList .file-row--parent'));
                                                            waitFor(
                                                              () => document.getElementById('fileBrowserCwd').title === ${JSON.stringify(visualBrowserRoot)}
                                                                && [...document.querySelectorAll('#fileList .file-row')]
                                                                  .some((row) => row.dataset.name === 'Documents'),
                                                              () => {
                                                                const documentsRow = [...document.querySelectorAll('#fileList .file-row')]
                                                                  .find((row) => row.dataset.name === 'Documents');
                                                                documentsRow.scrollIntoView({ block: 'end' });
                                                                document.body.dataset.dotfilesScreenshotReady = 'true';
                                                                const activeTab = document.querySelector('#ttyTabs .tty-tab.is-active');
                                                                dispatchTTYContextMenu(activeTab);
                                                                waitFor(
                                                                  () => document.body.dataset.ttyContextMenuOpen === 'true'
                                                                    && document.body.dataset.ttyContextSessionId === 'tty-03',
                                                                  () => {
                                                                    document.body.dataset.ttyFinalMenuReady = 'true';
                                                                  }
                                                                );
                                                              }
                                                            );
                                                          }
                                                        );
                                                      }
                                                    );
                                                  }
                                                );
                                              }
                                            );
                                          }
                                        );
                                      }, 300);
                                    }
                                  );
                                }
                              );
                            }
                          );
                        }
                      );
                    }
                  );
                }
              );
            }
          );
          setTimeout(() => dispatchTestFileDrag(false), 10_500);
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
            ttyContextMenuOpen: document.body.dataset.ttyContextMenuOpen === 'true',
            ttyContextSessionId: document.body.dataset.ttyContextSessionId || null,
            ttyNativeMenuPrevented: document.body.dataset.ttyNativeMenuPrevented === 'true',
            ttyContextViewportSafe: document.body.dataset.ttyContextViewportSafe === 'true',
            ttyContextEscapeClosed: document.body.dataset.ttyContextEscapeClosed === 'true',
            ttyContextOutsideClosed: document.body.dataset.ttyContextOutsideClosed === 'true',
            ttyRenameEscapeCancelled: document.body.dataset.ttyRenameEscapeCancelled === 'true',
            ttyManualNamePersisted: document.body.dataset.ttyManualNamePersisted === 'true',
            ttyRenameCount: Number(document.body.dataset.ttyRenameCount || 0),
            ttyAutoNameResetCount: Number(document.body.dataset.ttyAutoNameResetCount || 0),
            ttyContextCloseCount: Number(document.body.dataset.ttyContextCloseCount || 0),
            ttyBackgroundClosePreservedActive: document.body.dataset.ttyBackgroundClosePreservedActive === 'true',
            ttySoleCloseRespawned: document.body.dataset.ttySoleCloseRespawned === 'true',
            ttyFinalMenuReady: document.body.dataset.ttyFinalMenuReady === 'true',
            ttyContextMenuGeometry: (() => {
              const menu = document.getElementById('ttyContextMenu');
              const rect = menu.getBoundingClientRect();
              return {
                hidden: menu.hidden,
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                actions: [...menu.querySelectorAll('[data-action]')]
                  .filter((item) => getComputedStyle(item).display !== 'none')
                  .map((item) => item.textContent.trim())
              };
            })(),
            dropPathApiSupported: document.body.dataset.dropPathApiSupported === 'true',
            dropTargetObserved: document.body.dataset.dropTargetObserved === 'true',
            dropIndicatorCleared: document.body.dataset.dropIndicatorCleared === 'true',
            dropIndicatorVisible: document.querySelector('.terminal-panel').classList.contains('is-file-drop-target'),
            dropPathCount: Number(document.body.dataset.dropPathCount || 0),
            dropSessionId: document.body.dataset.dropSessionId || null,
            dropQuotedPayload: document.body.dataset.dropQuotedPayload || '',
            dropShellVerified: document.body.dataset.dropShellVerified === 'true',
            panelDropPathCount: Number(document.body.dataset.panelDropPathCount || 0),
            panelDropSessionId: document.body.dataset.panelDropSessionId || null,
            panelDropQuotedPayload: document.body.dataset.panelDropQuotedPayload || '',
            panelDropShellVerified: document.body.dataset.panelDropShellVerified === 'true',
            systemGroupOn: !document.body.classList.contains('system-group-hidden'),
            filesGroupOn: !document.getElementById('filesPanel').hidden,
            systemToggleCount: Number(document.body.dataset.systemToggleCount || 0),
            filesToggleCount: Number(document.body.dataset.filesToggleCount || 0),
            dataVisibilityStates: document.body.dataset.dataVisibilityStates || '',
            dataVisibilityGeometry: JSON.parse(document.body.dataset.dataVisibilityGeometry || '{}'),
            scanlinesToggleCount: Number(document.body.dataset.scanlinesToggleCount || 0),
            soundEnabled: document.body.dataset.soundEnabled === 'true',
            soundToggleCount: Number(document.body.dataset.soundToggleCount || 0),
            fileBrowserReady: document.body.dataset.fileBrowserReady === 'true',
            fileBrowserCwd: document.getElementById('fileBrowserCwd').textContent,
            fileBrowserCwdPath: document.getElementById('fileBrowserCwd').title,
            fileCount: document.querySelectorAll('#fileList .file-row').length,
            fileBrowserMode: document.body.dataset.fileBrowserMode,
            fileBrowserDescended: document.body.dataset.fileBrowserDescended === 'true',
            fileBrowserAscended: document.body.dataset.fileBrowserAscended === 'true',
            fileBrowserLiveResumed: document.body.dataset.fileBrowserLiveResumed === 'true',
            fileBrowserTabResumeObserved: document.body.dataset.fileBrowserTabResumeObserved === 'true',
            fileBrowserDragStarted: document.body.dataset.fileBrowserDragStarted === 'true',
            fileBrowserParentFirst: document.querySelector('#fileList .file-row:first-child')?.classList.contains('file-row--parent') || false,
            dotfilesVisible: document.body.dataset.dotfilesVisible === 'true',
            dotfilesToggleCount: Number(document.body.dataset.dotfilesToggleCount || 0),
            dotfilesLiveFiltered: document.body.dataset.dotfilesLiveFiltered === 'true',
            dotfilesShownObserved: document.body.dataset.dotfilesShownObserved === 'true',
            dotfilesHiddenRestored: document.body.dataset.dotfilesHiddenRestored === 'true',
            dotfilesScreenshotReady: document.body.dataset.dotfilesScreenshotReady === 'true',
            dotfilesChip: document.getElementById('dotfilesToggle').textContent,
            imagePreviewVisible: document.body.dataset.imagePreviewVisible === 'true',
            imagePreviewFinalObserved: document.body.dataset.imagePreviewFinalObserved === 'true',
            imagePreviewFirstObserved: document.body.dataset.imagePreviewFirstObserved === 'true',
            imagePreviewTooLargeObserved: document.body.dataset.imagePreviewTooLargeObserved === 'true',
            imagePreviewHiddenByDrag: document.body.dataset.imagePreviewHiddenByDrag === 'true',
            imagePreviewCacheHit: document.body.dataset.imagePreviewCacheHit === 'true',
            imagePreviewRequestCount: Number(document.body.dataset.imagePreviewRequestCount || 0),
            imagePreviewDwellMs: Number(document.body.dataset.imagePreviewDwellMs || 0),
            imagePreviewNaturalWidth: Number(document.body.dataset.imagePreviewNaturalWidth || 0),
            imagePreviewNaturalHeight: Number(document.body.dataset.imagePreviewNaturalHeight || 0),
            imagePreviewGeometry: (() => {
              const captured = document.body.dataset.imagePreviewFinalGeometry;
              if (captured) return JSON.parse(captured);
              const preview = document.getElementById('fileImagePreview');
              const image = document.getElementById('fileImagePreviewImage');
              const previewRect = preview.getBoundingClientRect();
              const imageRect = image.getBoundingClientRect();
              return {
                state: preview.dataset.state,
                hidden: preview.hidden,
                left: previewRect.left,
                top: previewRect.top,
                right: previewRect.right,
                bottom: previewRect.bottom,
                width: previewRect.width,
                height: previewRect.height,
                imageWidth: imageRect.width,
                imageHeight: imageRect.height,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight
              };
            })(),
            fileHeadingGeometry: (() => {
              const header = document.querySelector('.file-section-heading').getBoundingClientRect();
              const title = document.getElementById('filesSectionTitle').getBoundingClientRect();
              const mode = document.getElementById('fileBrowserMode').getBoundingClientRect();
              const dots = document.getElementById('dotfilesToggle').getBoundingClientRect();
              const session = document.getElementById('fileBrowserSession').getBoundingClientRect();
              const count = document.getElementById('fileBrowserCount').getBoundingClientRect();
              return {
                header: { left: header.left, top: header.top, right: header.right, bottom: header.bottom },
                title: { left: title.left, top: title.top, right: title.right, bottom: title.bottom, height: title.height },
                items: [mode, dots, session, count].map((rect) => ({
                  left: rect.left,
                  top: rect.top,
                  right: rect.right,
                  bottom: rect.bottom
                }))
              };
            })(),
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
            cspImageDataOnly: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("img-src 'self' data:"),
            gridColumns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns,
            telemetryGeometry: (() => {
              const panel = document.getElementById('telemetryPanel').getBoundingClientRect();
              const column = document.querySelector('.telemetry-column');
              const diskDetails = document.querySelector('#diskSection .metric-pairs').getBoundingClientRect();
              const networkHeading = document.querySelector('.network-section .section-heading').getBoundingClientRect();
              return {
                width: panel.width,
                height: panel.height,
                columnClientHeight: column.clientHeight,
                columnScrollHeight: column.scrollHeight,
                diskDetailsClearance: networkHeading.top - diskDetails.bottom
              };
            })(),
            filesPanelGeometry: (() => {
              const filesPanel = document.getElementById('filesPanel');
              const panel = filesPanel.getBoundingClientRect();
              const list = document.getElementById('fileList');
              return {
                hidden: filesPanel.hidden,
                width: panel.width,
                fileListClientHeight: list.clientHeight,
                fileListScrollHeight: list.scrollHeight
              };
            })(),
            terminalGeometry: (() => {
              const screen = document.querySelector('.terminal-tab-view:not([hidden]) .terminal-instance.is-active-pane .xterm-screen').getBoundingClientRect();
              return { width: screen.width, height: screen.height };
            })()
          })`);
          diagnostics.packaged = app.isPackaged;
          // The TTY context menu is a diagnostic artefact, not something the
          // README should advertise — dismiss it before the frame is captured.
          await window.webContents.executeJavaScript(`(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await new Promise((resolve) => setTimeout(resolve, 300));
          })()`);
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
          const ttyMenu = diagnostics.ttyContextMenuGeometry;
          if (!diagnostics.ttyContextMenuOpen || diagnostics.ttyContextSessionId !== 'tty-03'
            || !diagnostics.ttyNativeMenuPrevented || !diagnostics.ttyContextViewportSafe
            || !diagnostics.ttyContextEscapeClosed || !diagnostics.ttyContextOutsideClosed
            || !diagnostics.ttyRenameEscapeCancelled || !diagnostics.ttyManualNamePersisted
            || diagnostics.ttyRenameCount !== 2 || diagnostics.ttyAutoNameResetCount !== 1
            || diagnostics.ttyContextCloseCount !== 2 || !diagnostics.ttyBackgroundClosePreservedActive
            || !diagnostics.ttySoleCloseRespawned || !diagnostics.ttyFinalMenuReady
            || ttyMenu.hidden || ttyMenu.actions.join(',') !== 'RENAME,CLOSE'
            || ttyMenu.left < 0 || ttyMenu.top < 0
            || ttyMenu.right > ttyMenu.viewportWidth || ttyMenu.bottom > ttyMenu.viewportHeight) {
            throw new Error('TTY context menu, rename/auto-name, dismissal or close lifecycle failed');
          }
          const expectedDropPayload = "'/tmp/eDEX drag one.txt' '/tmp/O'\\''Brien [v2].log' ";
          if (!diagnostics.dropPathApiSupported || !diagnostics.dropTargetObserved
            || !diagnostics.dropIndicatorCleared || !diagnostics.dropIndicatorVisible
            || diagnostics.dropPathCount !== 2 || diagnostics.dropSessionId !== diagnostics.activeTerminal
            || diagnostics.dropQuotedPayload !== expectedDropPayload || !diagnostics.dropShellVerified) {
            throw new Error('File drag/drop path insertion, shell quoting or active-session routing failed');
          }
          const expectedPanelDropPayload = `'${visualBrowserFile.replace(/'/g, `'\\''`)}' `;
          if (!diagnostics.panelDropShellVerified || diagnostics.panelDropPathCount !== 1
            || diagnostics.panelDropSessionId !== diagnostics.activeTerminal
            || diagnostics.panelDropQuotedPayload !== expectedPanelDropPayload
            || !diagnostics.fileBrowserDragStarted) {
            throw new Error('FILE SYSTEM drag/drop did not use the shared shell-quoting and active-session route');
          }
          if (!diagnostics.systemGroupOn || !diagnostics.filesGroupOn || diagnostics.shortcutCount !== 6
            || diagnostics.systemToggleCount !== 2 || diagnostics.filesToggleCount !== 3
            || diagnostics.scanlinesToggleCount < 3 || diagnostics.scanlinesEnabled
            || diagnostics.soundToggleCount < 3 || diagnostics.soundEnabled) {
            throw new Error('HUD shortcut test did not restore the expected state');
          }
          const visibility = diagnostics.dataVisibilityGeometry;
          const expectedVisibilityStates = ['system-visible', 'system-hidden'];
          if (expectedVisibilityStates.some((state) => !diagnostics.dataVisibilityStates.split(',').includes(state))
            || !visibility['system-visible']?.panelVisible || !visibility['system-visible']?.systemVisible
            || visibility['system-hidden']?.panelVisible || visibility['system-hidden']?.systemVisible
            || visibility['system-hidden']?.terminalWidth < visibility['system-visible']?.terminalWidth + 250
            || visibility['system-hidden']?.terminalScreenWidth < visibility['system-visible']?.terminalScreenWidth + 250
            || visibility['system-visible']?.visibleProcessCount < 3) {
            throw new Error('SYSTEM panel visibility toggle or terminal refit is invalid');
          }
          if (!diagnostics.fileBrowserReady || diagnostics.fileBrowserMode !== 'browsing'
            || diagnostics.fileBrowserCwdPath !== visualBrowserRoot
            || diagnostics.fileCount < 1 || !diagnostics.fileBrowserParentFirst
            || !diagnostics.fileBrowserDescended || !diagnostics.fileBrowserAscended
            || !diagnostics.fileBrowserLiveResumed || !diagnostics.fileBrowserTabResumeObserved) {
            throw new Error('FILE SYSTEM LIVE/BROWSING navigation or parent-row behavior failed');
          }
          if (diagnostics.dotfilesVisible || diagnostics.dotfilesToggleCount !== 2
            || !diagnostics.dotfilesLiveFiltered || !diagnostics.dotfilesShownObserved
            || !diagnostics.dotfilesHiddenRestored || !diagnostics.dotfilesScreenshotReady
            || diagnostics.dotfilesChip !== 'DOTS HIDDEN') {
            throw new Error('Dotfile filtering, visible count or Cmd+Shift+. toggle failed');
          }
          const fileHeading = diagnostics.fileHeadingGeometry;
          const fileHeadingItems = [fileHeading.title, ...fileHeading.items];
          if (fileHeading.title.height > 12 || fileHeadingItems.some((item) => (
            item.left < fileHeading.header.left || item.right > fileHeading.header.right
              || item.top < fileHeading.header.top || item.bottom > fileHeading.header.bottom
          ))) {
            throw new Error('FILE SYSTEM heading wrapped or clipped its status metadata');
          }
          const preview = diagnostics.imagePreviewGeometry;
          if (diagnostics.imagePreviewVisible || !diagnostics.imagePreviewFinalObserved || !diagnostics.imagePreviewFirstObserved
            || !diagnostics.imagePreviewTooLargeObserved || !diagnostics.imagePreviewHiddenByDrag
            || !diagnostics.imagePreviewCacheHit || diagnostics.imagePreviewRequestCount !== 2
            || diagnostics.imagePreviewDwellMs < 180
            || diagnostics.imagePreviewNaturalWidth !== 320 || diagnostics.imagePreviewNaturalHeight !== 180
            || preview.hidden || preview.state !== 'image'
            || preview.imageWidth < 150 || preview.imageWidth > 240 || preview.imageHeight < 80 || preview.imageHeight > 220
            || preview.width > 258 || preview.height > 260
            || preview.left < 0 || preview.top < 0
            || preview.right > preview.viewportWidth || preview.bottom > preview.viewportHeight) {
            throw new Error('Image hover preview debounce, cache, drag hiding, dimensions or viewport clamping failed');
          }
          if (!diagnostics.cspLocked || !diagnostics.cspImageDataOnly
            || diagnostics.diskValue === '--' || diagnostics.diskUsed === '--'
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
          if (diagnostics.telemetryGeometry.width < 300 || diagnostics.telemetryGeometry.width > 340
            || diagnostics.telemetryGeometry.columnScrollHeight > diagnostics.telemetryGeometry.columnClientHeight + 2
            || diagnostics.telemetryGeometry.diskDetailsClearance < 6
            || diagnostics.filesPanelGeometry.hidden
            || diagnostics.filesPanelGeometry.fileListClientHeight < minimumVisualFileListHeight
            || diagnostics.terminalGeometry.width < minimumVisualTerminalWidthWithFilesPanel || diagnostics.terminalGeometry.height < 100) {
            throw new Error('Two-column layout has invalid geometry or scroll ownership');
          }
          const screenshotPath = path.join(
            os.tmpdir(),
            `edex-ui-bk-phase14-${visualTestWidth}x${visualTestHeight}${app.isPackaged ? '-packaged' : forceOfflineTest ? '-offline' : ''}.png`
          );
          fs.writeFileSync(screenshotPath, screenshot.toPNG());
          console.log(`Visual test screenshot: ${screenshotPath}`);

          // Crop of the WYGLĄD section alone: the theme controls document well
          // on their own, and no provider list means no offline error banner.
          const themeRect = await window.webContents.executeJavaScript(`(async () => {
            document.getElementById('settingsToggle').click();
            await new Promise((resolve) => setTimeout(resolve, 700));
            const section = document.querySelector('#settingsDialog .theme-section');
            if (!section) return null;
            const rect = section.getBoundingClientRect();
            return {
              x: Math.round(rect.left) - 12,
              y: Math.round(rect.top) - 12,
              width: Math.round(rect.width) + 24,
              height: Math.round(rect.height) + 24
            };
          })()`);
          if (themeRect) {
            const themeShotPath = path.join(os.tmpdir(), 'edex-ui-bk-theme-section.png');
            fs.writeFileSync(themeShotPath, (await window.webContents.capturePage(themeRect)).toPNG());
            console.log(`Theme section screenshot: ${themeShotPath}`);
          }
          process.exitCode = 0;
        } catch (error) {
          console.error(`Visual test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 17_500);
    });
  }

  if (isAssistantVisualTest) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const assistantGeometry = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const started = Date.now();
            let submitted = false;
            let resized = false;
            let panelReadyAt = 0;
            let resizeSettledAt = 0;
            let resizeEvidence = null;
            const inspect = () => {
              const toggle = document.getElementById('assistantToggle');
              if (toggle.getAttribute('aria-expanded') !== 'true') {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                  code: 'Digit3', key: '3', metaKey: true, bubbles: true, cancelable: true
                }));
              }
              const panel = document.getElementById('assistantPanel');
              const model = document.getElementById('hudModel');
              const terminalScreen = document.querySelector('.terminal-instance:not([hidden]) .xterm-screen');
              if (!panel.hidden && !model.disabled && model.value && terminalScreen && panelReadyAt === 0) {
                panelReadyAt = Date.now();
              }
              if (!resized && panelReadyAt > 0 && Date.now() - panelReadyAt > 500) {
                const handle = document.getElementById('assistantResizer');
                const handleRect = handle.getBoundingClientRect();
                const initialPanelWidth = panel.getBoundingClientRect().width;
                const initialTerminalPanelWidth = document.querySelector('.terminal-panel').getBoundingClientRect().width;
                const initialTerminalScreenWidth = terminalScreen.getBoundingClientRect().width;
                const fallbackStoredAbsent = localStorage.getItem('edex.assistant.width.v1') === null;
                const pointerId = 41;
                const startX = handleRect.left + (handleRect.width / 2);
                handle.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', button: 0, buttons: 1,
                  clientX: startX, clientY: handleRect.top + 40
                }));
                handle.dispatchEvent(new PointerEvent('pointermove', {
                  bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', buttons: 1,
                  clientX: startX - 120, clientY: handleRect.top + 40
                }));
                handle.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', button: 0,
                  clientX: startX - 120, clientY: handleRect.top + 40
                }));
                const dragWidth = panel.getBoundingClientRect().width;
                handle.focus();
                handle.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true
                }));
                resizeEvidence = {
                  initialPanelWidth,
                  initialTerminalPanelWidth,
                  initialTerminalScreenWidth,
                  fallbackStoredAbsent,
                  shortcutVisible: [...document.querySelectorAll('.shortcut-legend span')]
                    .some((item) => item.textContent.replace(/\s+/g, ' ').trim() === '⌘3 AI'
                      && getComputedStyle(item).display !== 'none'),
                  dragWidth,
                  keyboardWidth: panel.getBoundingClientRect().width,
                  keyboardFocus: document.activeElement === handle
                };
                resized = true;
                resizeSettledAt = Date.now();
              }
              if (resized && !submitted && Date.now() - resizeSettledAt > 350) {
                const handle = document.getElementById('assistantResizer');
                resizeEvidence.finalPanelWidth = panel.getBoundingClientRect().width;
                resizeEvidence.finalTerminalScreenWidth = terminalScreen.getBoundingClientRect().width;
                resizeEvidence.keyboardFocusAfterFit = document.activeElement === handle;
                resizeEvidence.storedWidth = Number(localStorage.getItem('edex.assistant.width.v1'));
                resizeEvidence.ariaNow = Number(handle.getAttribute('aria-valuenow'));
                resizeEvidence.ariaMin = Number(handle.getAttribute('aria-valuemin'));
                resizeEvidence.ariaMax = Number(handle.getAttribute('aria-valuemax'));
                document.getElementById('assistantPrompt').value = 'Reply with exactly HUD_OK.';
                document.getElementById('assistantForm').requestSubmit();
                submitted = true;
              }
              const assistantBody = document.querySelector('.chat-message[data-role="assistant"] .chat-message__body');
              if (submitted && document.getElementById('assistantCancel').hidden && assistantBody?.textContent.trim()) {
                const panelRect = panel.getBoundingClientRect();
                const terminalRect = document.querySelector('.terminal-panel').getBoundingClientRect();
                resolve({
                  panel: { left: panelRect.left, top: panelRect.top, right: panelRect.right, bottom: panelRect.bottom, width: panelRect.width },
                  terminalWidth: terminalRect.width,
                  provider: document.getElementById('hudProvider').value,
                  model: model.value,
                  responseLength: assistantBody.textContent.trim().length,
                  resize: resizeEvidence,
                  viewport: { width: innerWidth, height: innerHeight }
                });
              } else if (Date.now() - started > 90_000) reject(new Error('Assistant HUD inference did not complete'));
              else setTimeout(inspect, 200);
            };
            inspect();
          })`);
          await window.webContents.executeJavaScript("document.getElementById('assistantResizer').focus()");
          await new Promise((resolve) => setTimeout(resolve, 300));
          const assistantScreenshot = await window.webContents.capturePage();
          const assistantScreenshotPath = path.join(os.tmpdir(), 'edex-ui-bk-assistant-hud.png');
          fs.writeFileSync(assistantScreenshotPath, assistantScreenshot.toPNG());

          const cancellationStatus = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const prompt = document.getElementById('assistantPrompt');
            prompt.value = 'Generate a numbered list with one thousand detailed items.';
            document.getElementById('assistantForm').requestSubmit();
            const started = Date.now();
            let cancelled = false;
            const inspect = () => {
              const cancel = document.getElementById('assistantCancel');
              if (!cancelled && !cancel.hidden) {
                cancel.click();
                cancelled = true;
              }
              const status = document.getElementById('assistantStatus');
              if (cancelled && cancel.hidden) resolve({ state: status.dataset.state, text: status.textContent });
              else if (Date.now() - started > 15_000) reject(new Error('Assistant cancellation did not settle'));
              else setTimeout(inspect, 100);
            };
            inspect();
          })`);

          const settingsGeometry = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            document.getElementById('settingsToggle').click();
            const started = Date.now();
            const inspect = () => {
              const dialog = document.getElementById('settingsDialog');
              const localProvider = document.getElementById('localProvider');
              if (!dialog.hidden && localProvider.value === 'ollama') {
                localProvider.value = 'lmstudio';
                localProvider.dispatchEvent(new Event('change', { bubbles: true }));
              }
              const localModel = document.getElementById('localModel');
              if (!dialog.hidden && localProvider.value === 'lmstudio' && !localModel.disabled && localModel.value) {
                const rect = dialog.querySelector('.settings-panel').getBoundingClientRect();
                resolve({
                  left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
                  width: rect.width, height: rect.height,
                  model: localModel.value,
                  secretsHidden: ['braveApiKey', 'openRouterApiKey', 'openCodeGoApiKey']
                    .every((id) => document.getElementById(id).value === ''),
                  viewport: { width: innerWidth, height: innerHeight }
                });
              } else if (Date.now() - started > 15_000) reject(new Error('Assistant settings models did not load'));
              else setTimeout(inspect, 200);
            };
            inspect();
          })`);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const settingsScreenshot = await window.webContents.capturePage();
          const settingsScreenshotPath = path.join(os.tmpdir(), 'edex-ui-bk-assistant-settings.png');
          fs.writeFileSync(settingsScreenshotPath, settingsScreenshot.toPNG());

          const reloadComplete = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
          window.webContents.reload();
          await reloadComplete;
          const restoredWidth = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const pressAI = () => document.dispatchEvent(new KeyboardEvent('keydown', {
              code: 'Digit3', key: '3', metaKey: true, bubbles: true, cancelable: true
            }));
            const started = Date.now();
            let cycled = false;
            const inspect = () => {
              const panel = document.getElementById('assistantPanel');
              const stored = Number(localStorage.getItem('edex.assistant.width.v1'));
              if (panel.hidden && !cycled) pressAI();
              if (!panel.hidden && panel.getBoundingClientRect().width > 0 && !cycled) {
                pressAI();
                if (!panel.hidden) return reject(new Error('Command 3 did not close assistant'));
                pressAI();
                cycled = true;
              }
              if (cycled && !panel.hidden && panel.getBoundingClientRect().width > 0) {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve({
                  panelWidth: panel.getBoundingClientRect().width,
                  storedWidth: stored,
                  ariaNow: Number(document.getElementById('assistantResizer').getAttribute('aria-valuenow')),
                  toggleCount: Number(document.body.dataset.assistantToggleCount),
                  panelOpen: document.body.dataset.assistantPanelOpen
                })));
              } else if (Date.now() - started > 10_000) reject(new Error('Assistant width did not restore'));
              else setTimeout(inspect, 100);
            };
            inspect();
          })`);

          const nativeResizeBefore = await window.webContents.executeJavaScript(`(() => {
            const handle = document.getElementById('assistantResizer');
            const rect = handle.getBoundingClientRect();
            const y = rect.top + Math.min(80, rect.height / 2);
            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(y),
              width: document.getElementById('assistantPanel').getBoundingClientRect().width,
              hit: document.elementFromPoint(rect.left + rect.width / 2, y)?.id || ''
            };
          })()`);
          await window.webContents.sendInputEvent({ type: 'mouseDown', x: nativeResizeBefore.x, y: nativeResizeBefore.y, button: 'left', clickCount: 1 });
          await window.webContents.sendInputEvent({ type: 'mouseMove', x: nativeResizeBefore.x - 48, y: nativeResizeBefore.y, movementX: -48, movementY: 0 });
          await window.webContents.sendInputEvent({ type: 'mouseUp', x: nativeResizeBefore.x - 48, y: nativeResizeBefore.y, button: 'left', clickCount: 1 });
          await new Promise((resolve) => setTimeout(resolve, 180));
          const nativeResizeAfter = await window.webContents.executeJavaScript(`(() => ({
            width: document.getElementById('assistantPanel').getBoundingClientRect().width,
            stored: Number(localStorage.getItem('edex.assistant.width.v1')),
            resizing: document.body.classList.contains('assistant-resizing')
          }))()`);
          const systemLayoutBefore = await window.webContents.executeJavaScript(`(() => ({
            systemVisible: getComputedStyle(document.querySelector('.system-group')).display !== 'none',
            telemetry: document.getElementById('telemetryPanel').getBoundingClientRect().width,
            terminal: document.querySelector('.terminal-panel').getBoundingClientRect().width,
            assistant: document.getElementById('assistantPanel').getBoundingClientRect().width,
            columns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns
          }))()`);
          await window.webContents.executeJavaScript("document.getElementById('systemGroupToggle').click()");
          await new Promise((resolve) => setTimeout(resolve, 180));
          const systemLayoutAfter = await window.webContents.executeJavaScript(`(() => ({
            systemVisible: getComputedStyle(document.querySelector('.system-group')).display !== 'none',
            telemetry: document.getElementById('telemetryPanel').getBoundingClientRect().width,
            terminal: document.querySelector('.terminal-panel').getBoundingClientRect().width,
            assistant: document.getElementById('assistantPanel').getBoundingClientRect().width,
            columns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns
          }))()`);

          const minimumAssistantTestTerminalWidth = assistantGeometry.viewport.width <= 1180 ? 300 : 400;
          if (assistantGeometry.panel.width < 300 || assistantGeometry.terminalWidth < minimumAssistantTestTerminalWidth
            || assistantGeometry.panel.left < 0 || assistantGeometry.panel.right > assistantGeometry.viewport.width
            || !assistantGeometry.model || assistantGeometry.provider !== 'ollama' || assistantGeometry.responseLength < 1) {
            throw new Error('Assistant HUD geometry or dynamic Ollama model is invalid');
          }
          const resize = assistantGeometry.resize;
          if (!resize.fallbackStoredAbsent || !resize.shortcutVisible
            || Math.abs(resize.initialPanelWidth - resize.initialTerminalPanelWidth) > 2
            || resize.dragWidth <= resize.initialPanelWidth + 80
            || Math.abs(resize.keyboardWidth - (resize.dragWidth - 16)) > 2
            || Math.abs(resize.finalPanelWidth - resize.keyboardWidth) > 2
            || resize.finalTerminalScreenWidth >= resize.initialTerminalScreenWidth - 60
            || !resize.keyboardFocus || !resize.keyboardFocusAfterFit
            || resize.storedWidth !== Math.round(resize.finalPanelWidth)
            || resize.ariaNow !== Math.round(resize.finalPanelWidth)
            || resize.ariaNow < resize.ariaMin || resize.ariaNow > resize.ariaMax) {
            throw new Error(`Assistant splitter drag, keyboard control, ARIA state or xterm fit is invalid: ${JSON.stringify(resize)}`);
          }
          if (Math.abs(restoredWidth.panelWidth - resize.finalPanelWidth) > 2
            || restoredWidth.storedWidth !== resize.storedWidth
            || restoredWidth.ariaNow !== resize.ariaNow
            || restoredWidth.toggleCount !== 3 || restoredWidth.panelOpen !== 'true') {
            throw new Error('Assistant width did not persist across renderer reload');
          }
          if (nativeResizeBefore.hit !== 'assistantResizer'
            || nativeResizeAfter.width <= nativeResizeBefore.width + 10
            || nativeResizeAfter.stored !== Math.round(nativeResizeAfter.width)
            || nativeResizeAfter.resizing) {
            throw new Error(`Native mouse hit-test or resize failed: ${JSON.stringify({ nativeResizeBefore, nativeResizeAfter })}`);
          }
          if (Math.abs(systemLayoutAfter.assistant - systemLayoutBefore.assistant) > 2
            || systemLayoutAfter.systemVisible || systemLayoutAfter.telemetry !== 0
            || systemLayoutAfter.terminal <= systemLayoutBefore.terminal + 250) {
            throw new Error(`SYS toggle did not collapse the telemetry column: ${JSON.stringify({ systemLayoutBefore, systemLayoutAfter })}`);
          }
          await window.webContents.executeJavaScript("document.getElementById('filesGroupToggle').click()");
          await new Promise((resolve) => setTimeout(resolve, 180));
          const telemetryHiddenLayout = await window.webContents.executeJavaScript(`(() => {
            const workspace = document.querySelector('.workspace');
            const columns = getComputedStyle(workspace).gridTemplateColumns.trim().split(/\\s+/);
            return {
              telemetryVisible: getComputedStyle(document.getElementById('telemetryPanel')).display !== 'none',
              assistantHidden: document.getElementById('assistantPanel').hidden,
              filesHidden: document.getElementById('filesPanel').hidden,
              terminal: document.querySelector('.terminal-panel').getBoundingClientRect().width,
              files: document.getElementById('filesPanel').getBoundingClientRect().width,
              columns
            };
          })()`);
          if (telemetryHiddenLayout.telemetryVisible || telemetryHiddenLayout.columns.length !== 2
            || !telemetryHiddenLayout.assistantHidden || telemetryHiddenLayout.filesHidden
            || telemetryHiddenLayout.terminal < minimumAssistantTestTerminalWidth
            || telemetryHiddenLayout.files < 300) {
            throw new Error(`FILES toggle did not close AI and take over the split: ${JSON.stringify(telemetryHiddenLayout)}`);
          }
          await window.webContents.executeJavaScript("document.getElementById('filesGroupToggle').click()");
          await window.webContents.executeJavaScript("document.getElementById('systemGroupToggle').click()");
          if (cancellationStatus.state !== 'error' || cancellationStatus.text !== 'ABORTED') {
            throw new Error(`Assistant cancellation returned ${cancellationStatus.text || 'no status'}`);
          }
          if (settingsGeometry.left < 0 || settingsGeometry.top < 0
            || settingsGeometry.right > settingsGeometry.viewport.width || settingsGeometry.bottom > settingsGeometry.viewport.height
            || !settingsGeometry.model || !settingsGeometry.secretsHidden) {
            throw new Error('Settings geometry, dynamic LM Studio model or secret boundary is invalid');
          }
          console.log(`Assistant HUD visual test passed: ${assistantGeometry.model}; LM Studio ${settingsGeometry.model}.`);
          console.log(`Assistant HUD screenshot: ${assistantScreenshotPath}`);
          console.log(`Assistant settings screenshot: ${settingsScreenshotPath}`);
          process.exitCode = 0;
        } catch (error) {
          console.error(`Assistant HUD visual test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 2_000);
    });
  }

  if (isFilesTest) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const report = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const started = Date.now();
            const root = ${JSON.stringify(filesTestRoot)};
            const rows = () => [...document.querySelectorAll('#fileList .file-row')];
            const rowFor = (name) => rows().find((row) => row.dataset.name === name);
            const click = (row, init = {}) => row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
            const evidence = {};
            const step = async () => {
              document.getElementById('filesGroupToggle').click();
              await new Promise((r) => setTimeout(r, 400));
              window.__edexBrowse(root);
              await new Promise((r) => setTimeout(r, 700));
              if (!rowFor('alpha.txt')) throw new Error('fixture not listed');

              // 1. single click selects instead of navigating
              click(rowFor('alpha.txt'));
              evidence.singleSelect = document.body.dataset.fileSelectionCount === '1';
              evidence.stillInRoot = document.getElementById('fileBrowserCwd').title === root;

              // 2. cmd+click extends the selection
              click(rowFor('beta.txt'), { metaKey: true });
              evidence.metaSelect = document.body.dataset.fileSelectionCount === '2';

              // 3. context menu opens for the selection
              rowFor('beta.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
              evidence.menuOpen = document.body.dataset.fileContextMenuOpen === 'true';
              evidence.menuHidesRename = document.querySelector('#fileContextMenu [data-file-action="rename"]').hidden;
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
              evidence.menuClosed = document.body.dataset.fileContextMenuOpen === 'false';

              // 4. rename through the popover
              click(rowFor('alpha.txt'));
              rowFor('alpha.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
              document.querySelector('#fileContextMenu [data-file-action="rename"]').click();
              const input = document.getElementById('fileRenameInput');
              input.value = 'renamed.txt';
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
              await new Promise((r) => setTimeout(r, 900));
              evidence.renamed = Boolean(rowFor('renamed.txt')) && !rowFor('alpha.txt');

              // 5. new folder
              window.__edexNewFolder('created-dir');
              await new Promise((r) => setTimeout(r, 900));
              evidence.folderCreated = Boolean(rowFor('created-dir'));

              // 6. sorting toggles direction
              document.querySelector('.file-sort-btn[data-sort-key="name"]').click();
              document.querySelector('.file-sort-btn[data-sort-key="name"]').click();
              evidence.sortActive = document.querySelector('.file-sort-btn[data-sort-key="name"]').classList.contains('is-active');

              // 7. filter narrows the listing
              document.getElementById('fileFilterToggle').click();
              const filter = document.getElementById('fileFilterInput');
              filter.value = 'beta';
              filter.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise((r) => setTimeout(r, 200));
              evidence.filtered = rows().length === 1 && Boolean(rowFor('beta.txt'));
              filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
              await new Promise((r) => setTimeout(r, 200));
              evidence.filterCleared = rows().length > 1;

              // 8. trash removes the selection
              click(rowFor('beta.txt'));
              await window.filesApi.trash([root + '/beta.txt']);
              window.__edexBrowse(root);
              await new Promise((r) => setTimeout(r, 900));
              evidence.trashed = !rowFor('beta.txt');

              // 9. motyw: akcent przemalowuje tokeny HUD, kroj/rozmiar ida do xterm
              const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
              window.themeApi.set({ accent: 'amber', terminalColor: 'mint', terminalFont: 'jetbrains', terminalFontSize: 14 });
              await new Promise((r) => setTimeout(r, 250));
              evidence.accentToken = cssVar('--cyan-rgb') === '255 176 60';
              evidence.accentOnBody = document.body.dataset.themeAccent === 'amber';
              const opts = window.__edexTerminalOptions();
              evidence.xtermFont = String(opts.fontFamily).includes('JetBrains Mono');
              evidence.xtermSize = opts.fontSize === 14;
              evidence.xtermColor = String(opts.foreground).toLowerCase() === '#9fe8c4';
              evidence.themePersisted = JSON.parse(localStorage.getItem('edex-ui-bk.theme.v1')).accent === 'amber';
              window.themeApi.reset();
              await new Promise((r) => setTimeout(r, 200));
              evidence.themeReset = cssVar('--cyan-rgb') === '0 229 255';

              if (Date.now() - started > 25_000) throw new Error('files test timed out');
              resolve(evidence);
            };
            step().catch(reject);
          })`);
          console.log(`File manager diagnostics: ${JSON.stringify(report)}`);
          const failures = Object.entries(report).filter(([, value]) => value !== true).map(([key]) => key);
          if (failures.length) throw new Error(`failed checks: ${failures.join(', ')}`);
          console.log('File manager test passed: selection, context menu, rename, mkdir, sort, filter and trash all work.');
          process.exitCode = 0;
        } catch (error) {
          console.error(`File manager test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 3_500);
    });
  }

  if (isPanesTest) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // Captured while the three-pane layout is still on screen — the run
          // tears it down again a step later.
          const screenshotPath = (async () => {
            for (let attempt = 0; attempt < 80; attempt += 1) {
              const ready = await window.webContents.executeJavaScript(
                "document.body.dataset.paneScreenshotReady === 'true'"
              );
              if (ready) {
                const target = path.join(os.tmpdir(), 'edex-ui-bk-split-panes.png');
                fs.writeFileSync(target, (await window.webContents.capturePage()).toPNG());
                return target;
              }
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            return null;
          })();

          const report = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
            const started = Date.now();
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const press = (code, modifiers = {}) => document.dispatchEvent(new KeyboardEvent('keydown', {
              code, metaKey: true, bubbles: true, cancelable: true, ...modifiers
            }));
            const view = () => document.querySelector('.terminal-tab-view:not([hidden])');
            const panes = () => [...view().querySelectorAll('.terminal-instance')];
            const tabs = () => [...document.querySelectorAll('#ttyTabs .tty-tab')];
            const activePane = () => document.body.dataset.activePaneId;
            const evidence = {};
            const step = async () => {
              evidence.startsWithOnePane = panes().length === 1 && tabs().length === 1;

              // 1. cmd+D splits the pane side by side inside the same tab
              press('KeyD');
              await wait(900);
              evidence.splitAddsPane = panes().length === 2 && tabs().length === 1;
              evidence.splitIsHorizontal = view().querySelector('.terminal-split')?.dataset.direction === 'row';
              evidence.splitHasSplitter = view().querySelectorAll('.terminal-splitter').length === 1;
              evidence.newPaneFocused = activePane() === panes()[1].dataset.sessionId;
              evidence.tabCountsPanes = tabs()[0].dataset.paneCount === '2';

              // 2. shift+cmd+D stacks the focused pane, nesting a second split
              press('KeyD', { shiftKey: true });
              await wait(900);
              evidence.stackAddsPane = panes().length === 3;
              evidence.nestedSplitIsVertical = Boolean(
                view().querySelector('.terminal-split[data-direction="row"] .terminal-split[data-direction="column"]')
              );

              // 2b. shift+cmd+enter zooms the focused (nested) pane — the split
              // tree must stay put, only visibility/fit changes — then zooms
              // back out again.
              const zoomedId = activePane();
              const siblings = () => panes().filter((pane) => pane.dataset.sessionId !== zoomedId);
              press('Enter', { shiftKey: true });
              await wait(300);
              evidence.zoomMarksTabView = view().classList.contains('is-zoomed');
              evidence.zoomHidesSiblings = siblings().every((pane) => pane.getBoundingClientRect().width === 0);
              const zoomedRect = document.querySelector(
                '.terminal-instance[data-session-id="' + zoomedId + '"]'
              ).getBoundingClientRect();
              evidence.zoomFillsTabView = Math.abs(zoomedRect.width - view().getBoundingClientRect().width) < 2;
              evidence.zoomChipMarked = Boolean(
                document.querySelector('.tty-pane-chip[data-session-id="' + zoomedId + '"]')?.classList.contains('is-zoomed')
              );
              press('Enter', { shiftKey: true });
              await wait(300);
              evidence.zoomExitClearsClass = !view().classList.contains('is-zoomed');
              evidence.zoomExitRestoresSiblings = siblings().every((pane) => pane.getBoundingClientRect().width > 0);
              evidence.zoomExitRefits = panes().every((pane) => {
                const screen = pane.querySelector('.xterm-screen');
                const paneRect = pane.getBoundingClientRect();
                return screen && Math.abs(screen.getBoundingClientRect().width - paneRect.width) < 20;
              });

              // Geometric nav is meaningless against zero-size hidden panes,
              // so ⌥⌘→ must drop the zoom before it walks the grid.
              press('Enter', { shiftKey: true });
              await wait(300);
              press('ArrowRight', { altKey: true });
              await wait(300);
              evidence.zoomExitsOnArrowNav = !view().classList.contains('is-zoomed');

              // 3. alt+cmd+arrows walk the pane grid
              const leftPaneId = panes()[0].dataset.sessionId;
              press('ArrowLeft', { altKey: true });
              await wait(200);
              evidence.navigatesLeft = activePane() === leftPaneId;
              press('ArrowRight', { altKey: true });
              await wait(200);
              evidence.navigatesBack = activePane() !== leftPaneId;

              // 4. dragging a splitter re-weights the pair
              const splitter = view().querySelector('.terminal-splitter[data-direction="row"]');
              const split = splitter.parentElement;
              const rect = split.getBoundingClientRect();
              const before = splitter.previousElementSibling;
              splitter.setPointerCapture = () => {};
              splitter.releasePointerCapture = () => {};
              splitter.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true, pointerId: 1,
                clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
              }));
              splitter.dispatchEvent(new PointerEvent('pointermove', {
                bubbles: true, pointerId: 1,
                clientX: rect.left + rect.width * 0.3, clientY: rect.top + rect.height / 2
              }));
              splitter.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
              await wait(200);
              evidence.splitterResizes = Math.abs(Number.parseFloat(before.style.flex) - 0.3) < 0.06;
              evidence.splitterCounted = document.body.dataset.paneResizeCount === '1';

              document.body.dataset.paneScreenshotReady = 'true';
              await wait(400);

              // 5. every pane owns a chip in the bar, and its context menu
              //    closes that pane alone — not the whole tab
              const chips = () => [...document.querySelectorAll('.tty-tab-group .tty-pane-chip')];
              evidence.chipPerPane = chips().length === 3;
              evidence.chipsCarryNames = chips().every(
                (chip) => chip.querySelector('.tty-pane-name').textContent.trim().length > 0
              );
              evidence.tabKeepsOnlyNumber = document.querySelector('#ttyTabs .tty-tab .tty-context').hidden;
              const victim = chips().find((chip) => !chip.classList.contains('is-active'));
              const victimId = victim.dataset.sessionId;
              victim.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true, clientX: 300, clientY: 140
              }));
              evidence.chipMenuTargetsItsPane = document.body.dataset.ttyContextSessionId === victimId;
              document.querySelector('#ttyContextMenu [data-action="close"]').click();
              await wait(1_400);
              evidence.chipCloseRemovesOnlyThatPane = panes().length === 2
                && !panes().some((pane) => pane.dataset.sessionId === victimId)
                && tabs().length === 1;

              // 6. shift+cmd+W closes the focused pane and the tree collapses
              press('KeyW', { shiftKey: true });
              await wait(1_400);
              evidence.closeRemovesPane = panes().length === 1 && tabs().length === 1;
              evidence.treeCollapsed = view().querySelectorAll('.terminal-split').length === 0;
              evidence.chipsGoneWhenUnsplit = chips().length === 0;
              evidence.focusMovedToSibling = Boolean(terminalPaneAlive(activePane()));

              // 7. cmd+T still opens a separate tab, hiding the split view
              press('KeyT');
              await wait(900);
              evidence.newTabOpens = tabs().length === 2 && panes().length === 1;
              evidence.previousTabHidden = document.querySelectorAll('.terminal-tab-view[hidden]').length === 1;

              // 8. a background command-completion notification (the real IPC
              // payload main.js would send once a 15s+ foreground process goes
              // back to idle — simulated directly here, since actually waiting
              // 15s for a real one is not worth the wall-clock cost) badges the
              // inactive tab, never the active one, and clears on switch.
              const hiddenPaneId = document.querySelector('.terminal-tab-view[hidden] .terminal-instance').dataset.sessionId;
              const hiddenTabButton = tabs().find((btn) => btn.dataset.sessionId === hiddenPaneId);
              const activeTabButton = tabs().find((btn) => btn.classList.contains('is-active'));
              const completedCommand = { name: 'sleep', durationMs: 20_000 };

              updateTerminalMetadata([{ sessionId: hiddenPaneId, completedCommand }]);
              await wait(100);
              evidence.notifiesInactiveTab = hiddenTabButton.classList.contains('has-notification');
              evidence.commandCompletedCounted = document.body.dataset.commandCompletedCount === '1';

              updateTerminalMetadata([{ sessionId: activePane(), completedCommand }]);
              await wait(100);
              evidence.noNotifyForActiveSession = !activeTabButton.classList.contains('has-notification')
                && document.body.dataset.commandCompletedCount === '1';

              hiddenTabButton.click();
              await wait(300);
              evidence.notificationClearsOnSwitch = !hiddenTabButton.classList.contains('has-notification');

              if (Date.now() - started > 25_000) throw new Error('panes test timed out');
              resolve(evidence);
            };
            function terminalPaneAlive(id) {
              return id && document.querySelector('.terminal-instance[data-session-id="' + id + '"].is-active-pane');
            }
            step().catch(reject);
          })`);
          console.log(`Split panes diagnostics: ${JSON.stringify(report)}`);
          const failures = Object.entries(report).filter(([, value]) => value !== true).map(([key]) => key);
          if (failures.length) throw new Error(`failed checks: ${failures.join(', ')}`);
          const capturedPath = await screenshotPath;
          if (capturedPath) console.log(`Split panes screenshot: ${capturedPath}`);
          console.log('Split panes test passed: split, stack, navigate, resize, close and tabs all work.');
          process.exitCode = 0;
        } catch (error) {
          console.error(`Split panes test failed: ${error.message}`);
          process.exitCode = 1;
        }
        app.quit();
      }, 3_500);
    });
  }
}

// The npm package was renamed from `edex-ui-bk` to `ebartnet-ui`, which moves the
// Electron userData directory. Carry the existing configuration over once so the
// stored provider credentials survive the rename.
function migrateLegacyUserData() {
  if (isAutomatedTest) return;
  const currentPath = app.getPath('userData');
  const legacyPath = path.join(path.dirname(currentPath), 'edex-ui-bk');
  if (legacyPath === currentPath) return;
  const currentConfig = path.join(currentPath, 'config.json');
  const legacyConfig = path.join(legacyPath, 'config.json');
  try {
    if (fs.existsSync(currentConfig) || !fs.existsSync(legacyConfig)) return;
    fs.mkdirSync(currentPath, { recursive: true });
    fs.copyFileSync(legacyConfig, currentConfig);
    fs.chmodSync(currentConfig, 0o600);
  } catch (error) {
    console.error(`Could not migrate legacy configuration: ${error.message}`);
  }
}

app.whenReady().then(async () => {
  migrateLegacyUserData();
  configStore = new ConfigStore(app.getPath('userData'));
  providerRegistry = new ProviderRegistry([new OllamaProvider(), new LMStudioProvider()]);
  configureCloudProviders();
  assistantService = new AssistantService({ registry: providerRegistry, configStore });
  localCliBridge = new LocalCliBridge({ userDataPath: app.getPath('userData'), assistantService, configStore });
  try {
    await localCliBridge.start();
  } catch (error) {
    console.error(`Local assistant CLI bridge unavailable: ${error.message}`);
  }
  registerTerminalIpc();
  registerFilesIpc();
  registerMonitoringIpc();
  registerAssistantIpc();
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
  for (const webContentsId of assistantRequests.keys()) {
    disposeAssistantRequests(webContentsId);
  }
  localCliBridge?.stop().catch((error) => console.error(`Cannot stop local assistant CLI bridge: ${error.message}`));
  setTimeout(() => app.exit(process.exitCode || 0), 250);
});
