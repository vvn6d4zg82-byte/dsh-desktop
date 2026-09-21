'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  bootstrap: ipcRenderer.sendSync('get-bootstrap'),
  getState: () => ipcRenderer.invoke('get-state'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  setFrameless: (enabled) => ipcRenderer.send('set-frameless', enabled),
  retry: () => ipcRenderer.send('retry'),
  startServer: () => ipcRenderer.send('start-server'),
  stopServer: () => ipcRenderer.send('stop-server'),
  openDsh: () => ipcRenderer.invoke('open-dsh'),
  closeDsh: () => ipcRenderer.send('close-dsh'),
  fsList: (rel) => ipcRenderer.invoke('fs-list', rel),
  fsRoot: () => ipcRenderer.invoke('fs-root'),
  fsSetRoot: () => ipcRenderer.invoke('fs-set-root'),
  remoteInfo: () => ipcRenderer.invoke('remote-info'),
  remoteExpose: (on) => ipcRenderer.invoke('remote-expose', on),
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winFullscreen: () => ipcRenderer.send('win-fullscreen'),
  winClose: () => ipcRenderer.send('win-close'),
  /** 真退出应用（停服务 + app.quit），与托盘菜单的「退出」同一行为 */
  winQuit: () => ipcRenderer.send('win-quit'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  winIsFullscreen: () => ipcRenderer.invoke('win-is-fullscreen'),
  onWinAnim: (cb) => ipcRenderer.on('win-anim', (_event, phase) => cb(phase)),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onServerStatus: (cb) => ipcRenderer.on('server-status', (_event, status) => cb(status)),
  onServerLog: (cb) => ipcRenderer.on('server-log', (_event, line) => cb(line)),
  /** 服务访问地址（含 token）变化时推送：{ tokenUrl, workbenchUrl, hasToken } */
  onServerToken: (cb) => ipcRenderer.on('server-token', (_event, info) => cb(info)),
  // 静默自动更新
  updateState: () => ipcRenderer.invoke('update:get-state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstallNow: () => ipcRenderer.invoke('update:install-now'),
  onUpdateState: (cb) => ipcRenderer.on('update-state', (_event, s) => cb(s)),
});