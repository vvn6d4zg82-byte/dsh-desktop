'use strict';

// 工作台窗口的 preload。
//
// 工作台加载的是远程 DSH 页面（http://127.0.0.1:3080），不能用主控制台的 preload
// （那个会暴露整套控制台 API）。这里只开一个极小的窗口控制通道：
// 注入的自绘标题栏通过 postMessage 发指令，这里转成 ipcRenderer 发给主进程。
//
// 安全边界：只允许 min/fs/close 三个白名单动作，不接受任意 IPC 频道。
const { ipcRenderer } = require('electron');

const ALLOWED = new Set(['min', 'fs', 'close']);

window.addEventListener('message', (event) => {
  // 只接受本窗口自己注入的标题栏发来的消息
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__dshWin !== true) return;
  const action = String(data.action || '');
  if (!ALLOWED.has(action)) return;
  ipcRenderer.send('workbench-window', action);
});
