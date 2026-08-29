'use strict';

// Web-mode replacement for src/preload.js's contextBridge APIs. Electron
// never loads this file — only src/server/index.js injects it, into the
// HTML it serves, ahead of every other renderer script. It defines the same
// five globals (terminalApi, monitoringApi, filesApi, settingsApi,
// assistantApi) plus themesApi, so renderer.js/telemetry-ui.js/etc run
// unmodified whether they're inside Electron or a browser tab.
//
// Wire protocol (JSON over one WebSocket at /ws):
//   request:  { id?, api, method, args }
//   response: { id, result } | { id, error: { message, code } }
//   event:    { event, payload }
// `id` is present only for calls that expect a reply (mirrors
// ipcRenderer.invoke in preload.js); it's omitted for fire-and-forget calls
// (mirrors ipcRenderer.send) so e.g. every keystroke's terminalApi.write
// doesn't wait on a round trip.

(() => {
  const RECONNECT_DELAY_MS = 2_000;

  let socket = null;
  let nextRequestId = 1;
  const pendingRequests = new Map();
  const outboundQueue = [];
  const eventListeners = new Map();

  function dispatchEvent(channel, payload) {
    const listeners = eventListeners.get(channel);
    if (!listeners) return;
    for (const callback of listeners) {
      try {
        callback(payload);
      } catch (error) {
        console.error(`[web-preload] listener for "${channel}" threw:`, error);
      }
    }
  }

  function subscribe(channel, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('IPC event callback must be a function.');
    }
    if (!eventListeners.has(channel)) eventListeners.set(channel, new Set());
    eventListeners.get(channel).add(callback);
    return () => eventListeners.get(channel)?.delete(callback);
  }

  function flushQueue() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (outboundQueue.length > 0) socket.send(outboundQueue.shift());
  }

  function enqueue(frame) {
    const payload = JSON.stringify(frame);
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
    else outboundQueue.push(payload);
  }

  // "invoke" — expects a reply, returns a Promise (terminalApi.start,
  // filesApi.list, settingsApi.get, ...).
  function invoke(api, method, args) {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      pendingRequests.set(id, { resolve, reject });
      enqueue({ id, api, method, args });
    });
  }

  // "send" — fire-and-forget, no reply (terminalApi.write/resize/close,
  // monitoringApi.stop, ...).
  function send(api, method, args) {
    enqueue({ api, method, args });
  }

  function handleMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.event) {
      dispatchEvent(frame.event, frame.payload);
      return;
    }
    if (frame.id === undefined) return;
    const pending = pendingRequests.get(frame.id);
    if (!pending) return;
    pendingRequests.delete(frame.id);
    if (frame.error) {
      pending.reject(Object.assign(new Error(frame.error.message || 'Request failed.'), { code: frame.error.code || null }));
    } else {
      pending.resolve(frame.result);
    }
  }

  function connect() {
    const url = new URL('/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = window.location.search;
    socket = new WebSocket(url);
    socket.addEventListener('open', flushQueue);
    socket.addEventListener('message', (event) => handleMessage(event.data));
    socket.addEventListener('close', () => {
      socket = null;
      setTimeout(connect, RECONNECT_DELAY_MS);
    });
    socket.addEventListener('error', () => socket?.close());
  }

  connect();

  contextBridgeShim('terminalApi', Object.freeze({
    start: (sessionId, dimensions) => invoke('terminalApi', 'start', [sessionId, dimensions]),
    write: (sessionId, data) => send('terminalApi', 'write', [sessionId, data]),
    resize: (sessionId, cols, rows) => send('terminalApi', 'resize', [sessionId, cols, rows]),
    close: (sessionId) => send('terminalApi', 'close', [sessionId]),
    setActive: (sessionId) => send('terminalApi', 'setActive', [sessionId]),
    onData: (callback) => subscribe('terminal:data', callback),
    onMetadata: (callback) => subscribe('terminal:metadata', callback),
    onExit: (callback) => subscribe('terminal:exit', callback),
    reportSmokeResult: (ok) => send('terminalApi', 'reportSmokeResult', [ok === true])
  }));

  contextBridgeShim('monitoringApi', Object.freeze({
    start: () => invoke('monitoringApi', 'start', []),
    stop: () => send('monitoringApi', 'stop', []),
    onData: (callback) => subscribe('monitoring:data', callback)
  }));

  // list/rename/transfer/makeDirectory/preview are backed by the same
  // src/main/files-operations.js code Electron uses — see
  // src/server/index.js's HANDLERS map. open/reveal/chooseDirectory/confirm
  // have no browser equivalent (shell.openPath, Finder, native dialogs) —
  // file-browser.js checks edexCapabilities below and never calls them in
  // web mode, so their handlers only exist as a defensive fallback.
  contextBridgeShim('filesApi', Object.freeze({
    list: (sessionId, directoryPath = null, showHidden = false) => (
      invoke('filesApi', 'list', [sessionId, directoryPath, showHidden === true])
    ),
    onChanged: (callback) => subscribe('files:changed', callback),
    stopWatching: () => send('filesApi', 'unwatch', []),
    preview: (filePath) => invoke('filesApi', 'preview', [filePath]),
    open: (filePath) => invoke('filesApi', 'open', [filePath]),
    reveal: (filePath) => invoke('filesApi', 'reveal', [filePath]),
    rename: (filePath, name) => invoke('filesApi', 'rename', [filePath, name]),
    trash: (filePaths) => invoke('filesApi', 'trash', [filePaths]),
    transfer: (filePaths, destination, mode) => invoke('filesApi', 'transfer', [filePaths, destination, mode]),
    makeDirectory: (parentPath, name) => invoke('filesApi', 'makeDirectory', [parentPath, name]),
    chooseDirectory: (defaultPath = null) => invoke('filesApi', 'chooseDirectory', [defaultPath]),
    confirm: (options) => invoke('filesApi', 'confirm', [options]),
    // No File System Access API wiring in E1 — native drag-drop path
    // resolution stays Electron-only.
    getPathForFile: () => null,
    pathForDropSupported: false
  }));

  contextBridgeShim('themesApi', Object.freeze({
    listCustom: () => invoke('themesApi', 'listCustom', [])
  }));

  contextBridgeShim('settingsApi', Object.freeze({
    get: () => invoke('settingsApi', 'get', []),
    update: (patch) => invoke('settingsApi', 'update', [patch])
  }));

  // Backed by the same AssistantService/ProviderRegistry Electron uses (see
  // src/main/assistant/orchestration.js) — only the local CLI bridge
  // (Electron's `search --lms` shortcut) has no web equivalent.
  contextBridgeShim('assistantApi', Object.freeze({
    listModels: (provider) => invoke('assistantApi', 'listModels', [provider]),
    testProvider: (provider) => invoke('assistantApi', 'testProvider', [provider]),
    start: (request) => invoke('assistantApi', 'start', [request]),
    cancel: (requestId) => send('assistantApi', 'cancel', [requestId]),
    reset: (conversationId) => send('assistantApi', 'reset', [conversationId]),
    openSource: (url) => {
      try {
        window.open(url, '_blank', 'noopener');
      } catch (error) {
        console.warn('[web-preload] failed to open source link:', error);
      }
      return Promise.resolve({ opened: true });
    },
    onEvent: (callback) => subscribe('assistant:event', callback)
  }));

  // Tells file-browser.js (and anything else that cares) which OS-level
  // features have no browser equivalent, so it can adapt its own UI instead
  // of calling an API that will just throw. src/preload.js exposes the same
  // object with every flag true — Electron's behavior never changes.
  //
  // `platform` is the one field that isn't about the server at all — it's
  // about whoever is *looking at the page*, so their physical ⌘/Ctrl key
  // matches what the HUD shows. Electron gets this from process.platform
  // (a real Node global there); a browser tab has no such thing, so this
  // reads navigator.platform instead — same three values platform-utils.js
  // already expects ('darwin' | 'win32' | anything else treated as Linux).
  function detectBrowserPlatform() {
    const raw = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
    if (/mac/i.test(raw)) return 'darwin';
    if (/win/i.test(raw)) return 'win32';
    return 'linux';
  }

  contextBridgeShim('edexCapabilities', Object.freeze({
    trash: false,
    reveal: false,
    openFile: false,
    nativeDialogs: false,
    platform: detectBrowserPlatform()
  }));

  // contextBridge.exposeInMainWorld isn't available outside Electron's
  // isolated world — a plain global assignment is this file's equivalent,
  // since there's no untrusted content sharing this page's JS context.
  function contextBridgeShim(name, api) {
    window[name] = api;
  }
})();
