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
  list: (sessionId) => ipcRenderer.invoke('files:list', { sessionId }),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  pathForDropSupported: typeof webUtils?.getPathForFile === 'function'
}));
