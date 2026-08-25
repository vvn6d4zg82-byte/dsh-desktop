'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  bootstrap: ipcRenderer.sendSync('get-bootstrap'),
  getState: () => ipcRenderer.invoke('get-state'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  retry: () => ipcRenderer.send('retry'),
  startServer: () => ipcRenderer.send('start-server'),
  stopServer: () => ipcRenderer.send('stop-server'),
  serverInput: (line) => ipcRenderer.send('server-input', line),
  openDsh: () => ipcRenderer.invoke('open-dsh'),
  closeDsh: () => ipcRenderer.send('close-dsh'),
  onServerStatus: (cb) => ipcRenderer.on('server-status', (_event, status) => cb(status)),
  onServerLog: (cb) => ipcRenderer.on('server-log', (_event, line) => cb(line)),
});
