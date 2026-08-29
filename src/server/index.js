'use strict';

// EBARTNET-UI as a plain web page — a Node http+ws server that
// serves the same renderer files Electron loads from disk, but swaps the
// `contextBridge` transport for a WebSocket. The renderer code itself never
// changes: it always talks to `window.terminalApi` / `window.monitoringApi` /
// etc, it just doesn't know (or care) whether those are backed by IPC or a
// socket. See src/renderer/web-preload.js for the client half of this bridge.
//
// Electron is completely untouched by this file — src/preload.js is never
// loaded here, and web-preload.js is never loaded by Electron (only this
// server injects it into the HTML it serves).

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { AssistantService } = require('../main/assistant/assistant-service');
const { LMStudioProvider } = require('../main/assistant/lmstudio-provider');
const { OllamaProvider } = require('../main/assistant/ollama-provider');
const { configureCloudProviders, requireConfiguredCloudProvider, assistantErrorPayload } = require('../main/assistant/orchestration');
const { ProviderRegistry } = require('../main/assistant/provider-registry');
const { ConfigStore } = require('../main/config-store');
const {
  validDirectoryPath, validEntryPaths, validEntryName, pathExists, transferEntries, removeEntries,
  createImagePreviewCache, defaultImagePreviewEncode, previewImageFile, listDirectoryFiles, listTerminalFiles
} = require('../main/files-operations');
const { createMonitoringSession, collectMonitoringSample, MONITOR_INTERVAL_MS } = require('../main/monitoring');
const { collectTerminalMetadata, defaultShell } = require('../main/terminal-metadata');
const { ensureThemesDirectory, readCustomThemes } = require('../main/themes');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const RENDERER_ROOT = path.join(PROJECT_ROOT, 'src', 'renderer');
const NODE_MODULES_ROOT = path.join(PROJECT_ROOT, 'node_modules');

// Bare metal (macOS/Linux) defaults to loopback-only — remote access is
// meant to go through something in front of this (Cloudflare Tunnel, an SSH
// tunnel), never a direct exposed bind. The Docker image (Dockerfile) sets
// EDEX_WEB_BIND=0.0.0.0 itself, because inside a container 127.0.0.1 isn't
// reachable from the host at all — the port mapping in docker-compose.yml
// (127.0.0.1:3040:3040) is what keeps that loopback-only property from the
// host's point of view.
const HOST = process.env.EDEX_WEB_BIND || '127.0.0.1';
const PORT = Number.parseInt(process.env.EDEX_WEB_PORT, 10) || 3040;
const TOKEN = process.env.EDEX_WEB_TOKEN || crypto.randomUUID();
const SHELL = process.env.EDEX_WEB_SHELL || defaultShell();
const TOKEN_COOKIE = 'edex_web_token';
const TERMINAL_METADATA_INTERVAL_MS = 500;
const MAX_TERMINALS_PER_CONNECTION = 8;
const FILE_WATCH_DEBOUNCE_MS = 200;

// Electron keeps its config/themes under Electron's own userData directory
// (~/Library/Application Support/EBARTNET-UI); the web server has no such
// thing, so it gets its own on-disk home instead — same shape (config.json +
// themes/), same ConfigStore/themes.js code, different root.
const DATA_DIR = process.env.EDEX_WEB_DATA
  ? path.resolve(process.env.EDEX_WEB_DATA)
  : path.join(os.homedir(), '.ebartnet-ui-web');
const THEMES_DIR = path.join(DATA_DIR, 'themes');

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2']
]);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
ensureThemesDirectory(THEMES_DIR);

// One shared instance for the whole process — settings and assistant
// conversations are server-wide, not per-browser-tab (there's exactly one
// "web" user; each connection is just another tab open on the same session,
// same as two Electron windows would share one app-wide config on disk).
// LocalCliBridge (Electron's `search --lms` CLI shortcut, wired into the PTY
// environment) has no web equivalent and is intentionally left out — see the
// phase report.
const configStore = new ConfigStore(DATA_DIR);
const providerRegistry = new ProviderRegistry([new OllamaProvider(), new LMStudioProvider()]);
const assistantService = new AssistantService({ registry: providerRegistry, configStore });

function validSessionId(value) {
  return typeof value === 'string' && /^tty-[0-9]{2}$/.test(value) ? value : null;
}

// --- Auth -------------------------------------------------------------
// A single shared token, printed on stdout at startup (or pinned via
// EDEX_WEB_TOKEN). It is accepted as a `?token=` query param on first visit,
// then remembered via an HttpOnly cookie so later navigations/reloads and
// the WS upgrade don't need to carry it in the URL.

function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

function timingSafeTokenEquals(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const expected = Buffer.from(TOKEN);
  const actual = Buffer.from(candidate);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function extractRequestToken(req, requestUrl) {
  const queryToken = requestUrl.searchParams.get('token');
  if (timingSafeTokenEquals(queryToken)) return queryToken;
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies.get(TOKEN_COOKIE);
  if (timingSafeTokenEquals(cookieToken)) return cookieToken;
  return null;
}

// --- Static file serving + CSP/script-injection transform on index.html ---

function safeJoin(rootDir, requestPath) {
  const normalized = path.normalize(path.join(rootDir, requestPath));
  if (normalized !== rootDir && !normalized.startsWith(rootDir + path.sep)) return null;
  return normalized;
}

function resolveStaticPath(pathname) {
  if (pathname.startsWith('/node_modules/')) {
    return safeJoin(NODE_MODULES_ROOT, pathname.slice('/node_modules/'.length));
  }
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  return safeJoin(RENDERER_ROOT, relative);
}

// The Electron CSP has `connect-src 'none'` (nothing in that renderer ever
// makes a network call) and no injected script tag (Electron loads
// src/preload.js itself, out of band, via webPreferences.preload). Neither
// holds for the browser: the renderer now needs to open a WebSocket, and it
// needs *something* to define window.terminalApi etc before renderer.js and
// friends run. Both are rewritten here, in flight, straight from disk —
// index.html on disk (and the Electron build) is untouched.
function transformIndexHtml(html) {
  const withCsp = html.replace(
    "connect-src 'none';",
    "connect-src 'self' ws:;"
  );
  return withCsp.replace(
    '<script src="../../node_modules/@xterm/xterm/lib/xterm.js"></script>',
    '<script src="/web-preload.js"></script>\n    <script src="../../node_modules/@xterm/xterm/lib/xterm.js"></script>'
  );
}

function serveStatic(req, res, pathname) {
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    res.writeHead(400).end('Bad request.');
    return;
  }
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      res.writeHead(404).end('Not found.');
      return;
    }
    if (path.basename(filePath) === 'index.html') {
      fs.readFile(filePath, 'utf8', (readError, html) => {
        if (readError) {
          res.writeHead(500).end('Internal error.');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(transformIndexHtml(html));
      });
      return;
    }
    const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

// --- HTTP server --------------------------------------------------------

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const token = extractRequestToken(req, requestUrl);
  if (!token) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('Unauthorized.');
    return;
  }
  if (requestUrl.searchParams.has('token')) {
    res.setHeader('set-cookie', `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
  }
  serveStatic(req, res, requestUrl.pathname);
});

// --- WebSocket bridge -----------------------------------------------------
// One connection's worth of state lives entirely in `connectionState` below
// — nothing is shared across browser tabs/clients, same as one Electron
// BrowserWindow's worth of state living under one webContents id in
// src/main.js.

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname !== '/ws' || !extractRequestToken(req, requestUrl)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws, frame) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function pushEvent(ws, event, payload) {
  send(ws, { event, payload });
}

function createConnectionState(ws) {
  return {
    ws,
    terminals: new Map(),
    metadataStates: new Map(),
    activeSessionId: null,
    metadataTick: 0,
    metadataTimer: null,
    metadataInFlight: false,
    monitoring: null,
    monitoringTimer: null,
    monitoringInFlight: false,
    fileWatcher: null,
    imagePreviewCache: createImagePreviewCache(),
    assistantRequests: new Map()
  };
}

// --- File watching (fs.watch → files:changed push) ------------------------
// Mirrors src/main.js's ensureFileWatcher/disposeFileWatcher exactly, just
// keyed on this connection's own state object instead of a webContentsId
// map — there's one browser tab's worth of state per WS connection, same as
// one Electron window's worth of state per webContents.

function disposeFileWatcher(state) {
  const watcher = state.fileWatcher;
  if (!watcher) return;
  clearTimeout(watcher.debounceTimer);
  try {
    watcher.handle?.close();
  } catch {
    // Watcher may already be in a broken/closed state — nothing more to clean up.
  }
  state.fileWatcher = null;
}

// fs.watch (FSEvents on macOS) fires several events for a single file
// operation — this collapses a burst into one push, ~200ms after it settles.
function scheduleFileChangeNotification(state) {
  const watcher = state.fileWatcher;
  if (!watcher) return;
  clearTimeout(watcher.debounceTimer);
  watcher.debounceTimer = setTimeout(() => {
    pushEvent(state.ws, 'files:changed', { cwd: watcher.watchedPath });
  }, FILE_WATCH_DEBOUNCE_MS);
}

// Keeps at most one fs.watch per connection, pointed at whatever directory
// files:list just resolved. Returns whether a live watcher now covers
// `directoryPath`; the renderer falls back to fast polling when it doesn't.
function ensureFileWatcher(state, directoryPath) {
  if (state.fileWatcher?.watchedPath === directoryPath && state.fileWatcher.handle) return true;
  disposeFileWatcher(state);

  const watcher = { watchedPath: directoryPath, handle: null, debounceTimer: null };
  try {
    watcher.handle = fs.watch(directoryPath, { persistent: false }, () => scheduleFileChangeNotification(state));
    watcher.handle.on('error', () => disposeFileWatcher(state));
    state.fileWatcher = watcher;
    return true;
  } catch {
    // EMFILE, ENOSPC, or a path fs.watch can't cover (some network mounts).
    return false;
  }
}

function disposeTerminal(state, sessionId) {
  const terminal = state.terminals.get(sessionId);
  if (!terminal) return;
  state.terminals.delete(sessionId);
  state.metadataStates.delete(sessionId);
  try {
    terminal.kill();
  } catch {
    // The shell may already have exited.
  }
}

function disposeConnection(state) {
  clearInterval(state.metadataTimer);
  clearInterval(state.monitoringTimer);
  for (const sessionId of [...state.terminals.keys()]) disposeTerminal(state, sessionId);
  disposeFileWatcher(state);
  for (const controller of state.assistantRequests.values()) controller.abort();
  state.assistantRequests.clear();
}

async function publishTerminalMetadata(state) {
  if (state.metadataInFlight || state.terminals.size === 0) return;
  state.metadataInFlight = true;
  const now = Date.now();
  try {
    const targets = [...state.terminals.entries()].filter(([sessionId]) => (
      sessionId === state.activeSessionId || state.metadataTick % 3 === 0
    ));
    const updates = (await Promise.all(targets.map(async ([sessionId, terminal]) => {
      try {
        let metaState = state.metadataStates.get(sessionId);
        if (!metaState) {
          metaState = { cwd: null, cwdCheckedAt: 0, commandStartedAt: null, commandName: null };
          state.metadataStates.set(sessionId, metaState);
        }
        return { sessionId, ...(await collectTerminalMetadata(terminal, metaState, now)) };
      } catch {
        return null;
      }
    }))).filter(Boolean);
    if (updates.length > 0) pushEvent(state.ws, 'terminal:metadata', updates);
  } finally {
    state.metadataInFlight = false;
    state.metadataTick += 1;
  }
}

async function publishMonitoringSample(state) {
  if (!state.monitoring || state.monitoringInFlight) return null;
  state.monitoringInFlight = true;
  try {
    const sample = await collectMonitoringSample(state.monitoring);
    pushEvent(state.ws, 'monitoring:data', sample);
    return sample;
  } finally {
    state.monitoringInFlight = false;
  }
}

// --- filesApi ---------------------------------------------------------
// Same validation and directory-listing/transfer code src/main.js uses
// (src/main/files-operations.js) — only two things differ from Electron:
//  - image preview never downscales (no nativeImage outside Electron —
//    defaultImagePreviewEncode just base64s the original bytes), and
//  - trash is a real, permanent fs.rm (see removeEntries) instead of
//    shell.trashItem, because there's no OS Trash to hand a browser tab's
//    files to. The renderer only calls this permanent path when
//    edexCapabilities.trash is false, and always confirms first — see
//    file-browser.js's trashSelection().

async function handleFilesList(state, [sessionId, directoryPath, showHidden]) {
  const id = validSessionId(sessionId);
  const hidden = showHidden === true;
  if (!id) throw new Error('Invalid terminal session ID.');
  let result;
  if (directoryPath !== null && directoryPath !== undefined) {
    const resolved = validDirectoryPath(directoryPath);
    if (!resolved) {
      return { status: 'error', sessionId: id, cwd: null, parentPath: null, entries: [], totalCount: 0, truncated: false, watching: false };
    }
    result = await listDirectoryFiles(resolved, id, hidden);
  } else {
    const terminal = state.terminals.get(id);
    if (!terminal) {
      return { status: 'error', sessionId: id, cwd: null, parentPath: null, entries: [], totalCount: 0, truncated: false, watching: false };
    }
    result = await listTerminalFiles(terminal, id, hidden);
  }
  result.watching = result.status === 'ok' ? ensureFileWatcher(state, result.cwd) : false;
  return result;
}

function handleFilesRename(state, [filePath, name]) {
  const [target] = validEntryPaths(filePath) || [];
  const entryName = validEntryName(name);
  if (!target || !entryName) throw new Error('Invalid rename request.');
  const destination = path.join(path.dirname(target), entryName);
  if (destination === target) return { status: 'ok', target };
  return pathExists(destination).then((exists) => {
    if (exists) throw new Error('A file with that name already exists.');
    return fs.promises.rename(target, destination).then(() => ({ status: 'ok', target: destination }));
  });
}

async function handleFilesRemove(state, [filePaths]) {
  const targets = validEntryPaths(filePaths);
  if (!targets) throw new Error('Invalid delete request.');
  return removeEntries(targets);
}

async function handleFilesTransfer(state, [filePaths, destination, mode]) {
  const targets = validEntryPaths(filePaths);
  const transferMode = mode === 'copy' ? 'copy' : 'move';
  if (!targets) throw new Error('Invalid transfer request.');
  return transferEntries(targets, destination, transferMode);
}

async function handleFilesMkdir(state, [parentPath, name]) {
  const parent = validDirectoryPath(parentPath);
  const entryName = validEntryName(name);
  if (!parent || !entryName) throw new Error('Invalid folder request.');
  const destination = path.join(parent, entryName);
  if (await pathExists(destination)) throw new Error('That folder already exists.');
  await fs.promises.mkdir(destination);
  return { status: 'ok', target: destination };
}

// --- assistantApi -------------------------------------------------------
// Reuses AssistantService/ProviderRegistry exactly as src/main.js does —
// only the transport differs (WS push instead of webContents.send). Requests
// are tracked per-connection in state.assistantRequests so a cancel or a
// dropped socket only ever aborts that browser tab's own in-flight request.

async function handleAssistantStart(state, [request = {}]) {
  const config = configureCloudProviders(configStore, providerRegistry);
  const provider = config.selection.hudProvider;
  const model = config.selection.models[provider];
  requireConfiguredCloudProvider(provider, config);
  if (!model) throw new Error(`No active model selected for ${provider}.`);
  const requestId = typeof request.requestId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(request.requestId)
    ? request.requestId
    : `hud-${crypto.randomUUID()}`;
  if (state.assistantRequests.has(requestId)) throw new Error('Assistant request ID is already active.');
  const controller = new AbortController();
  state.assistantRequests.set(requestId, controller);
  const onEvent = (assistantEvent) => pushEvent(state.ws, 'assistant:event', assistantEvent);
  try {
    return await assistantService.run({
      requestId,
      conversationId: request.conversationId,
      prompt: request.prompt,
      mode: request.mode,
      surface: 'hud',
      provider,
      model
    }, { signal: controller.signal, onEvent });
  } catch (error) {
    const failure = assistantErrorPayload(error);
    onEvent({ requestId, ...failure });
    return { ok: false, requestId, error: failure };
  } finally {
    state.assistantRequests.delete(requestId);
  }
}

async function handleTerminalStart(state, args) {
  const [sessionId, dimensions = {}] = args;
  const id = validSessionId(sessionId);
  if (!id) throw new Error('Invalid terminal session ID.');
  if (state.terminals.has(id)) return { started: true, sessionId: id };
  if (state.terminals.size >= MAX_TERMINALS_PER_CONNECTION) throw new Error('Terminal session limit reached.');

  const cols = Number.isInteger(dimensions.cols) ? Math.min(Math.max(dimensions.cols, 2), 500) : 80;
  const rows = Number.isInteger(dimensions.rows) ? Math.min(Math.max(dimensions.rows, 1), 300) : 24;
  const terminal = pty.spawn(SHELL, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: os.homedir(),
    env: { ...process.env, SHELL, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  });

  state.terminals.set(id, terminal);
  state.metadataStates.set(id, { cwd: null, cwdCheckedAt: 0, commandStartedAt: null, commandName: null });

  terminal.onData((data) => pushEvent(state.ws, 'terminal:data', { sessionId: id, data }));
  terminal.onExit(({ exitCode, signal }) => {
    disposeTerminal(state, id);
    pushEvent(state.ws, 'terminal:exit', { sessionId: id, exitCode, signal });
  });

  return { started: true, sessionId: id, pid: terminal.pid, shell: SHELL };
}

// api:method -> handler(state, args). Handlers that don't need a reply
// (write/resize/close/setActive/stop/cancel/reset — the "send"-style calls
// in src/preload.js) still just return a value here; the client only awaits
// them when it sent a request `id` in the first place, see web-preload.js.
const HANDLERS = {
  'terminalApi:start': (state, args) => handleTerminalStart(state, args),
  'terminalApi:write': (state, [sessionId, data]) => {
    const id = validSessionId(sessionId);
    if (!id || typeof data !== 'string' || data.length > 64 * 1024) return;
    state.terminals.get(id)?.write(data);
  },
  'terminalApi:resize': (state, [sessionId, cols, rows]) => {
    const id = validSessionId(sessionId);
    if (!id || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
    state.terminals.get(id)?.resize(Math.min(Math.max(cols, 2), 500), Math.min(Math.max(rows, 1), 300));
  },
  'terminalApi:close': (state, [sessionId]) => {
    const id = validSessionId(sessionId);
    if (id) disposeTerminal(state, id);
  },
  'terminalApi:setActive': (state, [sessionId]) => {
    const id = validSessionId(sessionId);
    if (id && state.terminals.has(id)) state.activeSessionId = id;
  },
  'terminalApi:reportSmokeResult': () => {},

  'monitoringApi:start': async (state) => {
    if (!state.monitoring) {
      state.monitoring = createMonitoringSession();
      state.monitoringTimer = setInterval(() => publishMonitoringSample(state), MONITOR_INTERVAL_MS);
    }
    return publishMonitoringSample(state);
  },
  'monitoringApi:stop': (state) => {
    clearInterval(state.monitoringTimer);
    state.monitoring = null;
    state.monitoringTimer = null;
  },

  'filesApi:list': (state, args) => handleFilesList(state, args),
  'filesApi:preview': (state, [filePath]) => previewImageFile(filePath, state.imagePreviewCache, defaultImagePreviewEncode),
  // No shell.openPath/showItemInFolder outside Electron — gated client-side
  // by edexCapabilities.openFile/reveal (see file-browser.js), these are a
  // defensive fallback in case the UI ever calls them anyway.
  'filesApi:open': () => { throw new Error('Opening files is not available in the web preview.'); },
  'filesApi:reveal': () => { throw new Error('Revealing files in Finder is not available in the web preview.'); },
  'filesApi:rename': (state, args) => handleFilesRename(state, args),
  // Permanent delete (fs.rm) — see handleFilesRemove's comment above. Gated
  // client-side by edexCapabilities.trash + an always-shown confirmation.
  'filesApi:trash': (state, args) => handleFilesRemove(state, args),
  'filesApi:transfer': (state, args) => handleFilesTransfer(state, args),
  'filesApi:makeDirectory': (state, args) => handleFilesMkdir(state, args),
  // Native OS pickers/dialogs don't exist in a browser — edexCapabilities.
  // nativeDialogs is false in web mode, so file-browser.js shows its own
  // HUD-styled directory picker / confirm popover instead of ever calling
  // these two.
  'filesApi:chooseDirectory': () => ({ status: 'cancelled' }),
  'filesApi:confirm': () => ({ confirmed: false }),
  'filesApi:unwatch': (state) => disposeFileWatcher(state),

  'themesApi:listCustom': () => readCustomThemes(THEMES_DIR),

  'settingsApi:get': () => configStore.getPublic(),
  'settingsApi:update': (state, [patch]) => {
    const updated = configStore.update(patch);
    configureCloudProviders(configStore, providerRegistry);
    return updated;
  },

  'assistantApi:listModels': (state, [provider]) => {
    const config = configureCloudProviders(configStore, providerRegistry);
    requireConfiguredCloudProvider(provider, config);
    return providerRegistry.listModels(provider);
  },
  'assistantApi:testProvider': async (state, [providerId]) => {
    const config = configureCloudProviders(configStore, providerRegistry);
    requireConfiguredCloudProvider(providerId, config);
    const provider = providerRegistry.get(providerId);
    if (typeof provider.testConnection === 'function') return provider.testConnection();
    const models = await provider.listModels();
    return { ok: true, modelCount: models.length };
  },
  'assistantApi:start': (state, args) => handleAssistantStart(state, args),
  'assistantApi:cancel': (state, [requestId]) => {
    if (typeof requestId === 'string') state.assistantRequests.get(requestId)?.abort();
  },
  'assistantApi:reset': (state, [conversationId]) => {
    if (typeof conversationId === 'string') assistantService.resetConversation(conversationId);
  },
  'assistantApi:openSource': () => ({ opened: false })
};

wss.on('connection', (ws) => {
  const state = createConnectionState(ws);
  state.metadataTimer = setInterval(() => publishTerminalMetadata(state), TERMINAL_METADATA_INTERVAL_MS);

  ws.on('message', async (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { id, api, method, args } = frame || {};
    const handler = HANDLERS[`${api}:${method}`];
    if (!handler) {
      if (id !== undefined) send(ws, { id, error: { message: `Unknown API call: ${api}.${method}` } });
      return;
    }
    try {
      const result = await handler(state, Array.isArray(args) ? args : []);
      if (id !== undefined) send(ws, { id, result: result === undefined ? null : result });
    } catch (error) {
      if (id !== undefined) send(ws, { id, error: { message: error?.message || 'Request failed.', code: error?.code || null } });
    }
  });

  ws.on('close', () => disposeConnection(state));
  ws.on('error', () => disposeConnection(state));
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  console.log('EBARTNET-UI web preview listening.');
  console.log(url);
});
