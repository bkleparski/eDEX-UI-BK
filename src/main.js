'use strict';

const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { AssistantService } = require('./main/assistant/assistant-service');
const { PROVIDER_IDS } = require('./main/assistant/contracts');
const { LMStudioProvider } = require('./main/assistant/lmstudio-provider');
const { LocalCliBridge } = require('./main/assistant/local-cli-bridge');
const { OllamaProvider } = require('./main/assistant/ollama-provider');
const { OpenCodeGoProvider } = require('./main/assistant/opencode-go-provider');
const { OpenRouterProvider } = require('./main/assistant/openrouter-provider');
const { ProviderRegistry } = require('./main/assistant/provider-registry');
const { ConfigStore } = require('./main/config-store');
const { finiteNumber, safeLabel } = require('./main/format-utils');
const { MONITOR_INTERVAL_MS, createMonitoringSession, collectMonitoringSample } = require('./main/monitoring');
const { CUSTOM_THEME_ID_PREFIX, validateThemeFile } = require('./main/theme-file-validator');
const { collectTerminalMetadata, terminalWorkingDirectory } = require('./main/terminal-metadata');

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
const fileWatchers = new Map();
const fileWatcherCleanupRegistered = new WeakSet();
const FILE_WATCH_DEBOUNCE_MS = 200;
let configStore;
let providerRegistry;
let assistantService;
let localCliBridge;
let smokeTimeout;
let gracefulShutdownStarted = false;

const TERMINAL_METADATA_INTERVAL_MS = 500;
const MAX_TERMINALS_PER_WINDOW = 8;
const MAX_FILE_ENTRIES = 80;
const MAX_BATCH_ENTRIES = 200;
const THEMES_DIR_NAME = 'themes';
const MAX_THEME_FILES = 50;
const EXAMPLE_THEME_FILE_NAME = 'example-theme.json';
const EXAMPLE_THEME_CONTENT = {
  name: 'RINZLER',
  accent: { cyan: [210, 20, 20], cyanBright: [255, 130, 110], cyanDim: [110, 10, 10] },
  terminalColor: { foreground: [255, 90, 70], cursor: [255, 170, 140] }
};
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

    const session = { ...createMonitoringSession(), webContents: event.sender, timer: null };
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

function disposeFileWatcher(webContentsId) {
  const state = fileWatchers.get(webContentsId);
  if (!state) return;
  clearTimeout(state.debounceTimer);
  try {
    state.watcher?.close();
  } catch {
    // Watcher may already be in a broken/closed state — nothing more to clean up.
  }
  fileWatchers.delete(webContentsId);
}

// fs.watch (FSEvents on macOS) fires several events for a single file
// operation — this collapses a burst into one push, ~200ms after it settles.
function scheduleFileChangeNotification(webContentsId) {
  const state = fileWatchers.get(webContentsId);
  if (!state) return;
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    if (!state.sender.isDestroyed()) state.sender.send('files:changed', { cwd: state.watchedPath });
  }, FILE_WATCH_DEBOUNCE_MS);
}

// Keeps at most one fs.watch per window, pointed at whatever directory
// files:list just resolved — swaps it (close old, open new) whenever that
// directory changes. Returns whether a live watcher now covers
// `directoryPath`; the renderer falls back to fast polling when it doesn't
// (EMFILE/ENOSPC, network shares, or a watcher that later reports an error —
// directory removed, permissions changed, etc).
function ensureFileWatcher(event, directoryPath) {
  const webContentsId = event.sender.id;
  const existing = fileWatchers.get(webContentsId);
  if (existing && existing.watchedPath === directoryPath && existing.watcher) return true;

  disposeFileWatcher(webContentsId);
  if (!fileWatcherCleanupRegistered.has(event.sender)) {
    fileWatcherCleanupRegistered.add(event.sender);
    event.sender.once('destroyed', () => disposeFileWatcher(webContentsId));
  }

  const state = { watchedPath: directoryPath, watcher: null, debounceTimer: null, sender: event.sender };
  try {
    state.watcher = fs.watch(directoryPath, { persistent: false }, () => {
      scheduleFileChangeNotification(webContentsId);
    });
    state.watcher.on('error', () => disposeFileWatcher(webContentsId));
    fileWatchers.set(webContentsId, state);
    return true;
  } catch {
    // EMFILE, ENOSPC, or a path fs.watch can't cover (some network mounts).
    return false;
  }
}

function registerFilesIpc() {
  ipcMain.handle('files:list', async (event, payload = {}) => {
    requireTrustedSender(event);
    const sessionId = validSessionId(payload.sessionId);
    const showHidden = payload.showHidden === true;
    if (!sessionId) throw new Error('Invalid terminal session ID.');
    let result;
    if (payload.directoryPath !== null && payload.directoryPath !== undefined) {
      const directoryPath = validDirectoryPath(payload.directoryPath);
      if (!directoryPath) {
        return { status: 'error', sessionId, cwd: null, parentPath: null, entries: [], totalCount: 0, truncated: false };
      }
      result = await listDirectoryFiles(directoryPath, sessionId, showHidden);
    } else {
      const terminal = terminals.get(event.sender.id)?.get(sessionId);
      if (!terminal) {
        return { status: 'error', sessionId, cwd: null, parentPath: null, entries: [], totalCount: 0, truncated: false };
      }
      result = await listTerminalFiles(terminal, sessionId, showHidden);
    }
    // Keep the watcher pointed at whatever directory this call just
    // resolved — swaps it when the caller has moved elsewhere, and reports
    // back whether a live watcher is actually covering it (the renderer
    // falls back to fast polling when it isn't).
    result.watching = result.status === 'ok' ? ensureFileWatcher(event, result.cwd) : false;
    return result;
  });

  ipcMain.on('files:unwatch', (event) => {
    if (!isTrustedSender(event)) return;
    disposeFileWatcher(event.sender.id);
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

function themesDirectory() {
  return path.join(app.getPath('userData'), THEMES_DIR_NAME);
}

// Runs once at startup. Only seeds the example file the very first time the
// directory itself is created — a user who deletes the example later isn't
// fighting the app recreating it on every launch.
function ensureThemesDirectory() {
  const directory = themesDirectory();
  if (fs.existsSync(directory)) return;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, EXAMPLE_THEME_FILE_NAME),
      `${JSON.stringify(EXAMPLE_THEME_CONTENT, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    console.error(`Could not create themes directory: ${error.message}`);
  }
}

// The theme's own `name` is free text (any script, spaces) and isn't unique,
// so the persisted id — the string that ends up in localStorage and has to
// survive a rename/retitle — comes from the filename instead.
function sanitizeThemeIdStem(fileName) {
  const stem = path.basename(fileName, path.extname(fileName));
  const cleaned = stem.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
  return cleaned || 'theme';
}

// Re-reads the directory from disk on every call — the file set is tiny
// (MAX_THEME_FILES caps it) and local, so there's no cache to keep in sync
// and a file dropped in while the app is running is picked up on request.
// A malformed file is skipped with a warning; it never takes the app down.
function readCustomThemes() {
  const directory = themesDirectory();
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const themes = [];
  for (const entry of entries) {
    if (themes.length >= MAX_THEME_FILES) break;
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const validated = validateThemeFile(parsed);
      if (!validated) {
        console.warn(`Skipping invalid theme file: ${entry.name}`);
        continue;
      }
      themes.push({ id: `${CUSTOM_THEME_ID_PREFIX}${sanitizeThemeIdStem(entry.name)}`, ...validated });
    } catch (error) {
      console.warn(`Skipping unreadable theme file ${entry.name}: ${error.message}`);
    }
  }
  return themes;
}

function registerThemesIpc() {
  ipcMain.handle('themes:list-custom', (event) => {
    requireTrustedSender(event);
    return readCustomThemes();
  });
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
    require('./main/e2e/files-test').setupFixtures({ filesTestRoot });
  }

  if (isVisualTest) {
    require('./main/e2e/visual-test').setupFixtures({
      visualBrowserChild, visualBrowserRoot, visualBrowserFile, visualBrowserImage,
      visualBrowserLargeImage, IMAGE_PREVIEW_MAX_BYTES
    });
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
    smokeTimeout = require('./main/e2e/smoke-test').scheduleSmokeTimeout();
  }

  if (isVisualTest) {
    require('./main/e2e/visual-test').runVisualTest(window, {
      visualBrowserRoot, visualBrowserChild, visualBrowserFile, visualBrowserImage,
      visualBrowserLargeImage, visualTestWidth, visualTestHeight,
      minimumVisualTerminalWidthWithFilesPanel, minimumVisualFileListHeight, forceOfflineTest
    });
  }

  if (isAssistantVisualTest) {
    require('./main/e2e/assistant-test').runAssistantVisualTest(window);
  }

  if (isFilesTest) {
    require('./main/e2e/files-test').runFilesTest(window, { filesTestRoot });
  }

  if (isPanesTest) {
    require('./main/e2e/panes-test').runPanesTest(window);
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
  ensureThemesDirectory();
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
  registerThemesIpc();
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
