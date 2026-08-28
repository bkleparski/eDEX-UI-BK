'use strict';

// EBARTNET-UI as a plain web page (Phase E1) — a Node http+ws server that
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
const { createMonitoringSession, collectMonitoringSample, MONITOR_INTERVAL_MS } = require('../main/monitoring');
const { collectTerminalMetadata } = require('../main/terminal-metadata');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const RENDERER_ROOT = path.join(PROJECT_ROOT, 'src', 'renderer');
const NODE_MODULES_ROOT = path.join(PROJECT_ROOT, 'node_modules');

const HOST = process.env.EDEX_WEB_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.EDEX_WEB_PORT, 10) || 3040;
const TOKEN = process.env.EDEX_WEB_TOKEN || crypto.randomUUID();
const SHELL = process.env.EDEX_WEB_SHELL || '/bin/zsh';
const TOKEN_COOKIE = 'edex_web_token';
const TERMINAL_METADATA_INTERVAL_MS = 500;
const MAX_TERMINALS_PER_CONNECTION = 8;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2']
]);

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
    monitoringInFlight: false
  };
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

// Empty/rejection shapes below intentionally mirror what src/main.js already
// returns for its own error paths (see files:list's `directoryPath` branch,
// settings:get's default config) — the renderer already has to handle those,
// so E1 leans on that instead of inventing a second "web stub" shape.
const FILES_STUB_ERROR = Object.freeze({ status: 'error', cwd: null, parentPath: null, entries: [], totalCount: 0, truncated: false, watching: false });
const SETTINGS_STUB = Object.freeze({
  version: 1,
  selection: { localProvider: 'ollama', hudProvider: 'ollama', models: { ollama: '', 'lm-studio': '', openrouter: '', 'opencode-go': '' } },
  credentials: { braveConfigured: false, openRouterConfigured: false, openCodeGoConfigured: false }
});

function assistantOfflineError(provider) {
  const error = new Error(`${provider || 'assistant'} is unavailable in the web preview (Phase E1).`);
  error.code = 'PROVIDER_OFFLINE';
  return error;
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

  // Full filesApi/settingsApi/assistantApi wiring is out of scope for E1 —
  // see the phase report. These stubs return the same "nothing here" shapes
  // the Electron IPC layer already returns on its own error paths, so the
  // renderer's existing empty/error handling covers the web preview too.
  'filesApi:list': (state, [sessionId]) => ({ ...FILES_STUB_ERROR, sessionId: validSessionId(sessionId) }),
  'filesApi:preview': () => { throw new Error('File preview is not available in the web preview (Phase E1).'); },
  'filesApi:open': () => { throw new Error('Opening files is not available in the web preview (Phase E1).'); },
  'filesApi:reveal': () => { throw new Error('Revealing files is not available in the web preview (Phase E1).'); },
  'filesApi:rename': () => { throw new Error('Renaming is not available in the web preview (Phase E1).'); },
  'filesApi:trash': () => { throw new Error('Trashing files is not available in the web preview (Phase E1).'); },
  'filesApi:transfer': () => { throw new Error('File transfer is not available in the web preview (Phase E1).'); },
  'filesApi:makeDirectory': () => { throw new Error('Creating folders is not available in the web preview (Phase E1).'); },
  'filesApi:chooseDirectory': () => null,
  'filesApi:confirm': () => ({ confirmed: false }),
  'filesApi:unwatch': () => {},

  'themesApi:listCustom': () => [],

  'settingsApi:get': () => SETTINGS_STUB,
  'settingsApi:update': () => SETTINGS_STUB,

  'assistantApi:listModels': (state, [provider]) => { throw assistantOfflineError(provider); },
  'assistantApi:testProvider': (state, [provider]) => { throw assistantOfflineError(provider); },
  'assistantApi:start': (state, [request]) => { throw assistantOfflineError(request?.provider); },
  'assistantApi:cancel': () => {},
  'assistantApi:reset': () => {},
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
  console.log('EBARTNET-UI web preview (Phase E1) listening.');
  console.log(url);
});
