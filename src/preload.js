'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('IPC event callback must be a function.');
  }

  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('terminalApi', Object.freeze({
  start: (sessionId, dimensions) => ipcRenderer.invoke('terminal:start', { sessionId, ...dimensions }),
  write: (sessionId, data) => ipcRenderer.send('terminal:write', { sessionId, data }),
  resize: (sessionId, cols, rows) => ipcRenderer.send('terminal:resize', { sessionId, cols, rows }),
  close: (sessionId) => ipcRenderer.send('terminal:close', { sessionId }),
  setActive: (sessionId) => ipcRenderer.send('terminal:set-active', { sessionId }),
  onData: (callback) => subscribe('terminal:data', callback),
  onMetadata: (callback) => subscribe('terminal:metadata', callback),
  onExit: (callback) => subscribe('terminal:exit', callback),
  reportSmokeResult: (ok) => ipcRenderer.send('terminal:smoke-result', { ok: ok === true })
}));

contextBridge.exposeInMainWorld('monitoringApi', Object.freeze({
  start: () => ipcRenderer.invoke('monitoring:start'),
  stop: () => ipcRenderer.send('monitoring:stop'),
  onData: (callback) => subscribe('monitoring:data', callback)
}));

contextBridge.exposeInMainWorld('filesApi', Object.freeze({
  list: (sessionId, directoryPath = null, showHidden = false) => (
    ipcRenderer.invoke('files:list', { sessionId, directoryPath, showHidden: showHidden === true })
  ),
  onChanged: (callback) => subscribe('files:changed', callback),
  stopWatching: () => ipcRenderer.send('files:unwatch'),
  preview: (filePath) => ipcRenderer.invoke('files:preview', { filePath }),
  open: (filePath) => ipcRenderer.invoke('files:open', { filePath }),
  reveal: (filePath) => ipcRenderer.invoke('files:reveal', { filePath }),
  rename: (filePath, name) => ipcRenderer.invoke('files:rename', { filePath, name }),
  trash: (filePaths) => ipcRenderer.invoke('files:trash', { filePaths }),
  transfer: (filePaths, destination, mode) => ipcRenderer.invoke('files:transfer', { filePaths, destination, mode }),
  makeDirectory: (parentPath, name) => ipcRenderer.invoke('files:mkdir', { parentPath, name }),
  chooseDirectory: (defaultPath = null) => ipcRenderer.invoke('files:choose-directory', { defaultPath }),
  confirm: (options) => ipcRenderer.invoke('files:confirm', options),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  pathForDropSupported: typeof webUtils?.getPathForFile === 'function'
}));

contextBridge.exposeInMainWorld('themesApi', Object.freeze({
  listCustom: () => ipcRenderer.invoke('themes:list-custom')
}));

contextBridge.exposeInMainWorld('settingsApi', Object.freeze({
  get: () => ipcRenderer.invoke('settings:get'),
  update: (patch) => ipcRenderer.invoke('settings:update', patch)
}));

contextBridge.exposeInMainWorld('assistantApi', Object.freeze({
  listModels: (provider) => ipcRenderer.invoke('assistant:list-models', { provider }),
  testProvider: (provider) => ipcRenderer.invoke('assistant:test-provider', { provider }),
  start: (request) => ipcRenderer.invoke('assistant:start', request),
  cancel: (requestId) => ipcRenderer.send('assistant:cancel', { requestId }),
  reset: (conversationId) => ipcRenderer.send('assistant:reset', { conversationId }),
  openSource: (url) => ipcRenderer.invoke('assistant:open-source', { url }),
  onEvent: (callback) => subscribe('assistant:event', callback)
}));

// Electron has every OS-level feature — see src/renderer/web-preload.js's
// version of this same global for what the web preview has to fall back to
// instead (and file-browser.js for how it adapts its UI on these flags).
// `platform` is process.platform verbatim ('darwin' | 'linux' | 'win32') —
// src/renderer/platform-utils.js reads it to decide the primary shortcut
// modifier (⌘ vs Ctrl) and which glyphs to show.
contextBridge.exposeInMainWorld('edexCapabilities', Object.freeze({
  trash: true,
  reveal: true,
  openFile: true,
  nativeDialogs: true,
  platform: process.platform
}));
