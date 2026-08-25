'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell, session, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

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
  settingsVersion: 2, // 设置结构版本：>=2 表示 v0.1.4+（开机自启默认开启）
  serverCommand: 'npx --yes @deepseek-ai/dsh web --host 0.0.0.0', // 拉起 DSH 服务（--yes 免 npx 交互提示，配合 windowsHide 全静默）
  autoStartServer: true, // DSH 服务未运行时是否自动拉起
  openAtLogin: true, // 开机自启（默认开启，安装版首次运行即注册 Windows 登录项）
  systemCerts: true, // 给拉起的服务注入 --use-system-ca（内网/代理证书环境需要）
  onboardingDone: false, // 首次启动引导是否已完成
  hideTerminal: true, // 隐藏 DSH 网页里的终端界面（data-terminal 块）
};

let settings = { ...DEFAULT_SETTINGS };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const needsMigration = !raw.settingsVersion || raw.settingsVersion < 2;
    settings = { ...DEFAULT_SETTINGS, ...raw };
    if (needsMigration) {
      // v0.1.4 起开机自启改为默认开启：旧版设置里显式存过 false，这里强制迁移一次
      settings.openAtLogin = true;
      settings.settingsVersion = 2;
      saveSettings();
    }
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
// 提速：优先直接调用 npx 缓存里的 dsh 入口（跳过 npx 的 ~4s 解析开销）
// ---------------------------------------------------------------------------
const SERVER_START_STALL_TIMEOUT = 180000; // 首次全新下载可能很慢，给足 3 分钟
let serverChild = null;
let serverStarting = false;
let serverStallTimer = null;
let lastSpawnAttempt = 0;
let logBuffer = '';
let logFlushTimer = null;

function notifyFallback(status) {
  if (win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
    win.webContents.send('server-status', status);
  }
}

// 把服务输出转发到加载页控制台：缓冲后批量发送，保留完整终端内容（不截断、不丢行）
function notifyServerLog(text) {
  const s = String(text);
  if (!s) return;
  logBuffer += s;
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    if (logBuffer) {
      if (win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
        win.webContents.send('server-log', logBuffer);
      }
      logBuffer = '';
    }
  }, 100);
}

function effectiveServerCommand() {
  return (
    process.env.DSH_DESKTOP_SERVER_CMD ||
    settings.serverCommand ||
    DEFAULT_SETTINGS.serverCommand
  ).trim();
}

// 解析 dsh 包入口：读 package.json 的 bin，返回 cli JS 路径（解析失败返回 null）
function resolveDshEntry(pkgDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bin = pkg.bin;
    let rel = null;
    if (typeof bin === 'string') rel = bin;
    else if (bin && typeof bin === 'object') rel = bin.dsh || Object.values(bin)[0];
    if (rel) {
      const cliJs = path.join(pkgDir, rel);
      if (fs.existsSync(cliJs)) return cliJs;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// 扫描 npx 缓存目录，找到已安装的 dsh 的 JS 入口（直接交给 node 运行，跳过 cmd/batch/npx 的 ~4s 解析）
function findCachedDsh() {
  let best = null;
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx') : null,
    path.join(app.getPath('appData'), 'npm-cache', '_npx'),
  ].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of entries) {
      const pkgDir = path.join(root, dir, 'node_modules', '@deepseek-ai', 'dsh');
      const cliJs = resolveDshEntry(pkgDir);
      if (cliJs) {
        const mtime = fs.statSync(pkgDir).mtimeMs;
        if (!best || mtime > best.mtime) best = { cliJs, mtime };
      }
    }
  }
  return best ? best.cliJs : null;
}

let nodeExe = null;

// 定位系统 node.exe（仅开发模式用）：直接 spawn 它运行 JS 入口，避免 cmd 批处理二次进程弹窗/慢
// 安装版不用这里——内置 dsh 由 Electron 自带 node（ELECTRON_RUN_AS_NODE）直接运行，见 resolveLaunchTarget
function findNodeExecutable() {
  if (nodeExe) return nodeExe;
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    path.join(programFiles, 'nodejs', 'node.exe'),
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe')
      : null,
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return (nodeExe = c);
    } catch {
      /* ignore */
    }
  }
  try {
    // 兜底：where node（同步、无窗口，失败一次才走这里，结果缓存）
    const out = execFileSync('where.exe', ['node'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 3000,
    });
    const hit = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && /\.exe$/i.test(s));
    if (hit) return (nodeExe = hit);
  } catch {
    /* ignore */
  }
  return null;
}

// 解析实际执行目标：
// - 默认命令：系统 node + npx 缓存里的 dsh 直连（带 --expose-internals）；无缓存时退化为「node + npx-cli.js」
// - 自定义命令：保持 cmd /c 兼容
// dsh 的 HMR 插件要求 node 带 --expose-internals，故直连路径显式带上
function resolveLaunchTarget() {
  const configured = effectiveServerCommand();
  const isDefault =
    !process.env.DSH_DESKTOP_SERVER_CMD &&
    (!settings.serverCommand || settings.serverCommand.trim() === DEFAULT_SETTINGS.serverCommand);
  if (isDefault) {
    const node = findNodeExecutable();
    const cliJs = findCachedDsh();
    if (node && cliJs) {
      const display = `"${node}" --expose-internals "${cliJs}" web`;
      return { type: 'direct', exec: node, args: ['--expose-internals', cliJs, 'web'], display };
    }
    if (node) {
      const npxCli = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npx-cli.js');
      if (fs.existsSync(npxCli)) {
        const display = `"${node}" "${npxCli}" --yes @deepseek-ai/dsh web`;
        return {
          type: 'direct',
          exec: node,
          args: [npxCli, '--yes', '@deepseek-ai/dsh', 'web'],
          display,
        };
      }
    }
  }
  return {
    type: 'shell',
    exec: process.env.ComSpec || 'cmd.exe',
    args: [configured],
    display: configured,
  };
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
  const target = resolveLaunchTarget();
  if (!target || !target.args.length) return false;

  serverStarting = true;
  lastSpawnAttempt = Date.now();
  clearStallTimer();
  notifyFallback('starting');

  try {
    // 直连路径接上 stdin 管道，控制台可往里发命令；shell 路径保持 ignore
    const stdio = target.type === 'direct' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    const env = createServerEnv();
    if (target.type === 'direct') {
      // node 直连 JS 入口：进程树里没有任何 cmd/batch，绝无控制台窗口，也没有 cmd+npx 的解析开销
      serverChild = spawn(target.exec, target.args, {
        windowsHide: true,
        detached: false,
        stdio,
        env,
      });
    } else {
      // 自定义命令：cmd /d /s /c 兼容（windowsHide 隐藏主 cmd 窗口）
      serverChild = spawn(target.exec, ['/d', '/s', '/c', `"${target.args}"`], {
        windowsHide: true,
        detached: false,
        stdio,
        env,
      });
    }
    serverChild.unref();
    // 把子进程输出转发到加载页（限流），首启/下载时能看到进度
    serverChild.stdout.on('data', (chunk) => notifyServerLog(chunk.toString('utf8')));
    serverChild.stderr.on('data', (chunk) => notifyServerLog(chunk.toString('utf8')));

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
let workbenchWin = null;
let pollTimer = null;

function markOnboardingDone() {
  if (!settings.onboardingDone) {
    settings.onboardingDone = true;
    saveSettings();
  }
}

// 每 3 秒探测服务状态并推给控制台；离线且开了自动拉起时拉起 dsh
function startStatusPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const online = await checkServer();
    notifyFallback(online ? 'online' : 'offline');
    if (online) {
      markOnboardingDone();
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

// 打开 DSH 工作台：独立窗口加载服务网页，服务在线才开
async function openWorkbench() {
  if (!(await checkServer())) return false;
  if (workbenchWin && !workbenchWin.isDestroyed()) {
    workbenchWin.focus();
    return true;
  }
  workbenchWin = new BrowserWindow({
    width: 1360,
    height: 880,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#0f172a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  workbenchWin.webContents.on('did-finish-load', () => {
    applyTerminalCss(workbenchWin.webContents);
  });
  workbenchWin.on('closed', () => {
    workbenchWin = null;
  });
  try {
    await workbenchWin.loadURL(serverUrl.toString());
  } catch (err) {
    console.error('loadURL failed:', err);
    workbenchWin = null;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 隐藏 DSH 网页里的终端界面（前端用 [data-terminal] 标记终端块）
// ---------------------------------------------------------------------------
let terminalCssKey = null;
const TERMINAL_CSS = '[data-terminal]{display:none!important}';

function applyTerminalCss(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  if (settings.hideTerminal) {
    if (terminalCssKey) {
      webContents.removeInsertedCSS(terminalCssKey).catch(() => {});
      terminalCssKey = null;
    }
    webContents.insertCSS(TERMINAL_CSS).then((key) => {
      terminalCssKey = key;
    }).catch(() => {});
  } else if (terminalCssKey) {
    webContents.removeInsertedCSS(terminalCssKey).catch(() => {});
    terminalCssKey = null;
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

  // 主窗口 = 双控制台界面（服务终端 + 管理后台），始终加载本地 UI
  win.loadFile(path.join(__dirname, '..', 'ui', 'dist', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    // 页面就绪后开始探测；服务离线且开了自动拉起就直接拉起 dsh
    startStatusPolling();
    checkServer().then((online) => {
      notifyFallback(online ? 'online' : 'offline');
      if (!online && settings.autoStartServer) startDshServer();
    });
  });

  win.on('closed', () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    win = null;
  });
}

// ---------------------------------------------------------------------------
// IPC：给 fallback 页用
// ---------------------------------------------------------------------------
ipcMain.on('get-bootstrap', (event) => {
  event.returnValue = {
    serverUrl: serverUrl.toString(),
    serverCommand: resolveLaunchTarget().display,
    serverStarting,
  };
});

ipcMain.handle('get-state', async () => {
  return {
    settings: { ...settings },
    bundledVersions: null,
    serverUrl: serverUrl.toString(),
    launchDisplay: resolveLaunchTarget().display,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    isPackaged: app.isPackaged,
    serverOnline: await checkServer(),
    workbenchOpen: Boolean(workbenchWin && !workbenchWin.isDestroyed()),
  };
});

ipcMain.handle('set-setting', (_event, key, value) => {
  if (!(key in settings)) return false;
  settings[key] = value;
  saveSettings();
  if (key === 'openAtLogin') setLoginItem(Boolean(value));
  if (key === 'hideTerminal') {
    if (workbenchWin && !workbenchWin.isDestroyed()) applyTerminalCss(workbenchWin.webContents);
  }
  return true;
});

ipcMain.on('retry', async () => {
  if (await checkServer()) {
    markOnboardingDone();
    notifyFallback('online');
  } else {
    notifyFallback('offline');
    if (settings.autoStartServer) startDshServer();
  }
});

ipcMain.on('start-server', () => {
  startDshServer();
});

ipcMain.on('stop-server', () => {
  if (serverChild) {
    killServerTree(serverChild.pid);
    serverChild = null;
  }
  serverStarting = false;
  clearStallTimer();
  notifyFallback('offline');
});

ipcMain.on('server-input', (_event, line) => {
  const text = String(line ?? '');
  if (!serverChild || !serverChild.stdin || serverChild.stdin.destroyed) return;
  try {
    serverChild.stdin.write(text.endsWith('\n') ? text : text + '\n');
  } catch {
    /* ignore */
  }
});

ipcMain.handle('open-dsh', () => openWorkbench());

ipcMain.on('close-dsh', () => {
  if (workbenchWin && !workbenchWin.isDestroyed()) {
    workbenchWin.close();
    workbenchWin = null;
  }
});

// ---------------------------------------------------------------------------
// 开机自启：直接写 HKCU Run 键（与系统其他自启应用同一机制，比 Electron 的
// setLoginItemSettings 可靠——实测该 API 在本机不生效）
// ---------------------------------------------------------------------------
const LOGIN_ITEM_NAME = 'DSH Desktop';

function setLoginItem(enabled) {
  // 硬守卫：只有安装版（packaged）允许写注册表，开发模式一律跳过
  if (!app.isPackaged) return false;
  const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  try {
    if (enabled) {
      execFileSync('reg.exe', ['add', runKey, '/v', LOGIN_ITEM_NAME, '/t', 'REG_SZ', '/d', `"${process.execPath}"`, '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      execFileSync('reg.exe', ['delete', runKey, '/v', LOGIN_ITEM_NAME, '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    }
    return true;
  } catch {
    return false;
  }
}

function isLoginItemEnabled() {
  try {
    execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', LOGIN_ITEM_NAME], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

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

    // 开机自启（默认开启）：安装版首次运行即写入 Windows 登录项
    if (app.isPackaged && settings.openAtLogin) {
      setLoginItem(true);
    }

    const autoStartMenuItem = {
      label: '开机自动启动 DSH Desktop',
      type: 'checkbox',
      checked: isLoginItemEnabled(),
      click: (item) => {
        setLoginItem(item.checked);
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

    const hideTerminalMenuItem = {
      label: '隐藏终端界面',
      type: 'checkbox',
      checked: settings.hideTerminal,
      click: (item) => {
        settings.hideTerminal = item.checked;
        saveSettings();
        if (workbenchWin && !workbenchWin.isDestroyed()) applyTerminalCss(workbenchWin.webContents);
      },
    };

    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: '文件',
          submenu: [
            { label: '打开 DSH 工作台', accelerator: 'CmdOrCtrl+W', click: () => openWorkbench() },
            { label: '重新加载控制台', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.reload() },
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
            hideTerminalMenuItem,
            { type: 'separator' },
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
                    `启动命令: ${resolveLaunchTarget().display}\n` +
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
