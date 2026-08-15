'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  serverUrl: ipcRenderer.sendSync('get-server-url'),
  retry: () => ipcRenderer.send('retry'),
});
