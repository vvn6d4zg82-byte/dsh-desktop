'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  bootstrap: ipcRenderer.sendSync('get-bootstrap'),
  retry: () => ipcRenderer.send('retry'),
  startServer: () => ipcRenderer.send('start-server'),
  onServerStatus: (cb) => ipcRenderer.on('server-status', (_event, status) => cb(status)),
});
