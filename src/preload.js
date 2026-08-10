'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('IPC event callback must be a function.');
  }

  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('terminalApi', Object.freeze({
  start: (dimensions) => ipcRenderer.invoke('terminal:start', dimensions),
  write: (data) => ipcRenderer.send('terminal:write', data),
  resize: (cols, rows) => ipcRenderer.send('terminal:resize', { cols, rows }),
  onData: (callback) => subscribe('terminal:data', callback),
  onExit: (callback) => subscribe('terminal:exit', callback),
  reportSmokeResult: (ok) => ipcRenderer.send('terminal:smoke-result', { ok: ok === true })
}));

contextBridge.exposeInMainWorld('monitoringApi', Object.freeze({
  start: () => ipcRenderer.invoke('monitoring:start'),
  stop: () => ipcRenderer.send('monitoring:stop'),
  onData: (callback) => subscribe('monitoring:data', callback)
}));
