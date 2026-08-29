'use strict';

const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');
const pty = require('node-pty');
const { AssistantService } = require('./main/assistant/assistant-service');
const { LMStudioProvider } = require('./main/assistant/lmstudio-provider');
const { LocalCliBridge } = require('./main/assistant/local-cli-bridge');
const { OllamaProvider } = require('./main/assistant/ollama-provider');
const { configureCloudProviders, requireConfiguredCloudProvider, assistantErrorPayload } = require('./main/assistant/orchestration');
const { ProviderRegistry } = require('./main/assistant/provider-registry');
const { ConfigStore } = require('./main/config-store');
const {
  IMAGE_PREVIEW_MAX_BYTES, validDirectoryPath, validEntryPaths, validEntryName, pathExists,
  transferEntries, createImagePreviewCache, previewImageFile, listDirectoryFiles, listTerminalFiles
} = require('./main/files-operations');
const { safeLabel } = require('./main/format-utils');
const { MONITOR_INTERVAL_MS, createMonitoringSession, collectMonitoringSample } = require('./main/monitoring');
const {
  collectTerminalMetadata, defaultShell, shellSpawnArgs, win32ShellArgs, reportTerminalCwd
} = require('./main/terminal-metadata');
const { ensureThemesDirectory, readCustomThemes } = require('./main/themes');

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
const THEMES_DIR_NAME = 'themes';
const IMAGE_PREVIEW_MAX_SOURCE_DIMENSION = 480;
const imagePreviewCache = createImagePreviewCache();

if (isAutomatedTest) {
  const testKind = isSmokeTest ? 'smoke' : isAssistantVisualTest ? 'assistant' : isFilesTest ? 'files' : 'visual';
  app.setPath('userData', path.join(os.tmpdir(), `edex-ui-bk-${testKind}-${process.pid}`));
}

function isTrustedSender(event) {
  const senderUrl = event.senderFrame?.url;
  if (typeof senderUrl !== 'string') return false;

  // fileURLToPath handles platform differences a raw pathname comparison does
  // not: on Windows the URL pathname is /C:/... with forward slashes while
  // path.join produces C:\... with backslashes, so the old string equality
  // rejected every renderer there.
  let senderPath;
  try {
    senderPath = url.fileURLToPath(senderUrl);
  } catch {
    return false;
  }
  const expectedPath = path.join(__dirname, 'renderer', 'index.html');
  return path.relative(senderPath, expectedPath) === '';
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
    const shell = defaultShell();
    const resourcesRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
    const assistantBinPath = path.join(resourcesRoot, 'bin');
    const osc7ScriptPath = path.join(resourcesRoot, 'shell-integration', 'osc7-prompt.ps1');
    const spawnArgs = process.platform === 'win32' ? win32ShellArgs(shell, osc7ScriptPath) : shellSpawnArgs();
    const terminal = pty.spawn(shell, spawnArgs, {
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
      cwd: os.homedir(), cwdSource: null, cwdCheckedAt: 0, commandStartedAt: null, commandName: null
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

  // OSC 7 cwd reports (see osc7-cwd.js / terminal-metadata.js) — the
  // renderer already decoded the file:// URI, this just re-validates it as
  // untrusted text (it originated in terminal output) before it lands in
  // metadata state and out to renderTabLabel.
  ipcMain.on('terminal:report-cwd', (event, payload) => {
    const sessionId = validSessionId(payload?.sessionId);
    if (!isTrustedSender(event) || !sessionId || !terminals.get(event.sender.id)?.has(sessionId)) return;
    const state = terminalMetadataSessions.get(event.sender.id)?.states.get(sessionId);
    if (state) reportTerminalCwd(state, payload?.cwd);
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
    return previewImageFile(payload.filePath, imagePreviewCache, imagePreviewData);
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

function themesDirectory() {
  return path.join(app.getPath('userData'), THEMES_DIR_NAME);
}

function registerThemesIpc() {
  ipcMain.handle('themes:list-custom', (event) => {
    requireTrustedSender(event);
    return readCustomThemes(themesDirectory());
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
    configureCloudProviders(configStore, providerRegistry);
    return updated;
  });

  ipcMain.handle('assistant:list-models', async (event, payload = {}) => {
    requireTrustedSender(event);
    const provider = payload.provider;
    const config = configureCloudProviders(configStore, providerRegistry);
    requireConfiguredCloudProvider(provider, config);
    return providerRegistry.listModels(provider);
  });

  ipcMain.handle('assistant:test-provider', async (event, payload = {}) => {
    requireTrustedSender(event);
    const providerId = payload.provider;
    const config = configureCloudProviders(configStore, providerRegistry);
    requireConfiguredCloudProvider(providerId, config);
    const provider = providerRegistry.get(providerId);
    if (typeof provider.testConnection === 'function') return provider.testConnection();
    const models = await provider.listModels();
    return { ok: true, modelCount: models.length };
  });

  ipcMain.handle('assistant:start', async (event, payload = {}) => {
    requireTrustedSender(event);
    const config = configureCloudProviders(configStore, providerRegistry);
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
    // The inset traffic lights are a macOS convention (and trafficLightPosition
    // is a no-op everywhere else anyway) — Linux gets the platform's own
    // window chrome instead of an empty gap where the lights would be.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 27, y: 36 } } : {}),
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
  ensureThemesDirectory(themesDirectory());
  configStore = new ConfigStore(app.getPath('userData'));
  providerRegistry = new ProviderRegistry([new OllamaProvider(), new LMStudioProvider()]);
  configureCloudProviders(configStore, providerRegistry);
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
