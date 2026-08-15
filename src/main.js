'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell, session } = require('electron');
const path = require('path');
const http = require('http');

// ---------------------------------------------------------------------------
// 解析 DSH 服务地址：命令行 --url= 优先，其次环境变量 DSH_WEB_URL，最后默认值
// ---------------------------------------------------------------------------
function resolveServerUrl() {
  const urlArg = process.argv.find((a) => a.startsWith('--url='));
  const raw = urlArg
    ? urlArg.slice('--url='.length)
    : process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';
  try {
    return new URL(raw);
  } catch {
    return new URL('http://127.0.0.1:3080');
  }
}

const serverUrl = resolveServerUrl();

// 任务栏图标/分组与打包后的 appId 保持一致（必须在创建窗口前调用）
app.setAppUserModelId('com.dsh.desktop');

// 开发模式用独立的用户数据目录，避免和安装版互相干扰
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'dsh-desktop-dev'));
}

// ---------------------------------------------------------------------------
// 探测 DSH Web 服务是否在线
// ---------------------------------------------------------------------------
function checkServer(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const port = serverUrl.port || (serverUrl.protocol === 'https:' ? 443 : 80);
    const req = http.get(
      { hostname: serverUrl.hostname, port, path: '/', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(true); // 只要服务有响应就算在线
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

let win = null;
let pollTimer = null;

function showFallback() {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, 'fallback.html'));
  if (pollTimer) clearInterval(pollTimer);
  // 服务起来后自动跳转
  pollTimer = setInterval(async () => {
    if (await checkServer()) {
      clearInterval(pollTimer);
      pollTimer = null;
      loadServer();
    }
  }, 3000);
}

async function loadServer() {
  if (!win || win.isDestroyed()) return;
  try {
    await win.loadURL(serverUrl.toString());
  } catch (err) {
    console.error('loadURL failed:', err);
    showFallback();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: false,
    show: false, // 等页面 ready-to-show 再显示，避免白屏闪烁
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed()) win.show();
  });

  // 外部链接用系统浏览器打开，内部导航留在窗口里
  win.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    const sameHost = target.hostname === serverUrl.hostname && target.port === (serverUrl.port || '');
    if (!sameHost) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const target = new URL(url);
    const sameHost = target.hostname === serverUrl.hostname && target.port === (serverUrl.port || '');
    if (!sameHost) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  (async () => {
    if (await checkServer()) {
      loadServer();
    } else {
      showFallback();
    }
  })();

  win.on('closed', () => {
    if (pollTimer) clearInterval(pollTimer);
    win = null;
  });
}

// ---------------------------------------------------------------------------
// IPC：给 fallback 页用
// ---------------------------------------------------------------------------
ipcMain.on('get-server-url', (event) => {
  event.returnValue = serverUrl.toString();
});

ipcMain.on('retry', async () => {
  if (await checkServer()) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    loadServer();
  }
});

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.setName('DSH Desktop');

    // 去掉 UA 里的 Electron 标记，避免被页面 UA 嗅探
    session.defaultSession.setUserAgent(
      session.defaultSession.getUserAgent().replace(/\sElectron\/\S+/, '')
    );

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: '文件',
          submenu: [
            { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.reload() },
            { type: 'separator' },
            { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
          ],
        },
        {
          label: '视图',
          submenu: [
            { role: 'resetZoom', label: '实际大小' },
            { role: 'zoomIn', label: '放大' },
            { role: 'zoomOut', label: '缩小' },
            { type: 'separator' },
            { role: 'togglefullscreen', label: '全屏' },
            { role: 'toggleDevTools', label: '开发者工具' },
          ],
        },
        {
          label: '帮助',
          submenu: [
            {
              label: `关于 DSH Desktop（服务: ${serverUrl.toString()}）`,
              click: () => {
                const { dialog } = require('electron');
                dialog.showMessageBox(win, {
                  type: 'info',
                  title: '关于',
                  message: 'DSH Desktop',
                  detail:
                    `DeepSeek Harness 桌面端\n\n` +
                    `连接服务: ${serverUrl.toString()}\n` +
                    `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`,
                });
              },
            },
          ],
        },
      ])
    );

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
