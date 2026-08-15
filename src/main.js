'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell, session, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

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
// 设置持久化（userData/settings.json）
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  serverCommand: 'npx --yes @deepseek-ai/dsh web', // 拉起 DSH 服务（--yes 免 npx 交互提示，配合 windowsHide 全静默）
  autoStartServer: true, // DSH 服务未运行时是否自动拉起
  openAtLogin: false, // 是否开机自启（同时写 Windows 登录项）
  systemCerts: true, // 给拉起的服务注入 --use-system-ca（内网/代理证书环境需要）
  onboardingDone: false, // 首次启动引导是否已完成
};

let settings = { ...DEFAULT_SETTINGS };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* 首次启动没有设置文件，用默认值 */
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('saveSettings failed:', err);
  }
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

// ---------------------------------------------------------------------------
// 拉起 DSH 服务：服务没跑时自动 spawn 一次（默认 `npx @deepseek-ai/dsh web`）
// 借鉴 opencode 桌面端的 sidecar 思路：启动就绪等待 + 超时看门狗 + 环回免代理 + 系统证书
// ---------------------------------------------------------------------------
const SERVER_START_STALL_TIMEOUT = 120000; // 首启 npx 可能要下载包，给足 2 分钟
let serverChild = null;
let serverStarting = false;
let serverStallTimer = null;
let lastSpawnAttempt = 0;

function notifyFallback(status) {
  if (win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
    win.webContents.send('server-status', status);
  }
}

function effectiveServerCommand() {
  return (
    process.env.DSH_DESKTOP_SERVER_CMD ||
    settings.serverCommand ||
    DEFAULT_SETTINGS.serverCommand
  ).trim();
}

// 给子进程注入环境：系统证书（opencode useSystemCertificates 的等价物）+ 环回地址免代理
function createServerEnv() {
  const env = { ...process.env };

  const noProxy = (env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    if (!noProxy.some((v) => v.toLowerCase() === host)) noProxy.push(host);
  }
  env.NO_PROXY = noProxy.join(',');
  env.no_proxy = env.NO_PROXY;

  if (settings.systemCerts) {
    const opts = (env.NODE_OPTIONS || '').trim();
    if (!opts.includes('--use-system-ca')) {
      env.NODE_OPTIONS = (opts ? opts + ' ' : '') + '--use-system-ca';
    }
  }
  return env;
}

function killServerTree(pid) {
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

function clearStallTimer() {
  if (serverStallTimer) {
    clearTimeout(serverStallTimer);
    serverStallTimer = null;
  }
}

function startDshServer() {
  if (serverStarting || serverChild) return false;
  const cmd = effectiveServerCommand();
  if (!cmd) return false;

  const parts = cmd.split(/\s+/);
  const [exe, ...args] = parts;
  serverStarting = true;
  lastSpawnAttempt = Date.now();
  clearStallTimer();
  notifyFallback('starting');

  try {
    // shell:true 才能解析 .cmd/.ps1（Windows）；detached 让服务在应用关闭后继续运行
    serverChild = spawn(exe, args, {
      shell: true,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      env: createServerEnv(),
    });
    serverChild.unref();

    serverStallTimer = setTimeout(() => {
      // 启动卡死：杀掉进程树并报失败，交给轮询逻辑冷却后重试
      if (serverStarting) {
        serverStarting = false;
        if (serverChild) {
          killServerTree(serverChild.pid);
          serverChild = null;
        }
        notifyFallback('stalled');
      }
    }, SERVER_START_STALL_TIMEOUT);

    serverChild.on('error', () => {
      clearStallTimer();
      serverChild = null;
      serverStarting = false;
      notifyFallback('failed');
    });
    serverChild.on('exit', () => {
      clearStallTimer();
      serverChild = null;
      serverStarting = false;
      notifyFallback('waiting');
    });
    return true;
  } catch (err) {
    clearStallTimer();
    serverStarting = false;
    notifyFallback('failed');
    return false;
  }
}

let win = null;
let pollTimer = null;

function showFallback() {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, 'fallback.html'));
  if (pollTimer) clearInterval(pollTimer);
  // 每 3 秒探测一次；服务起来后自动跳转，必要时自动重新拉起服务
  pollTimer = setInterval(async () => {
    if (await checkServer()) {
      clearInterval(pollTimer);
      pollTimer = null;
      clearStallTimer();
      serverStarting = false;
      markOnboardingDone();
      loadServer();
      return;
    }
    if (
      settings.autoStartServer &&
      !serverStarting &&
      !serverChild &&
      Date.now() - lastSpawnAttempt > 15000
    ) {
      startDshServer();
    }
  }, 3000);
}

function markOnboardingDone() {
  if (!settings.onboardingDone) {
    settings.onboardingDone = true;
    saveSettings();
  }
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
      // 初次启动 / 重启后首次启动：服务没跑就直接拉起
      if (settings.autoStartServer) startDshServer();
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
ipcMain.on('get-bootstrap', (event) => {
  event.returnValue = {
    serverUrl: serverUrl.toString(),
    serverCommand: effectiveServerCommand(),
    serverStarting,
  };
});

ipcMain.on('retry', async () => {
  if (await checkServer()) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    clearStallTimer();
    serverStarting = false;
    markOnboardingDone();
    loadServer();
  } else {
    notifyFallback('waiting');
    if (settings.autoStartServer) startDshServer();
  }
});

ipcMain.on('start-server', () => {
  startDshServer();
});

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
loadSettings();

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

    const autoStartMenuItem = {
      label: '开机自动启动 DSH Desktop',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
        settings.openAtLogin = item.checked;
        saveSettings();
      },
    };

    const autoStartServerMenuItem = {
      label: 'DSH 服务未运行时自动启动',
      type: 'checkbox',
      checked: settings.autoStartServer,
      click: (item) => {
        settings.autoStartServer = item.checked;
        saveSettings();
      },
    };

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
          label: '服务',
          submenu: [
            {
              label: '启动 DSH 服务',
              click: () => {
                startDshServer();
              },
            },
            { type: 'separator' },
            autoStartServerMenuItem,
            autoStartMenuItem,
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
                dialog.showMessageBox(win, {
                  type: 'info',
                  title: '关于',
                  message: 'DSH Desktop',
                  detail:
                    `DeepSeek Harness 桌面端\n\n` +
                    `连接服务: ${serverUrl.toString()}\n` +
                    `启动命令: ${effectiveServerCommand()}\n` +
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
