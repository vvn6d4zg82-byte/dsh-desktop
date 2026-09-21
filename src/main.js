'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, shell, session, dialog, nativeImage } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { initAutoUpdate, getUpdateState, onUpdateState } = require('./auto-update');
const authBridge = require('./authbridge');

// ---------------------------------------------------------------------------
// 解析 DSH 服务地址：命令行 --url= 优先，其次环境变量 DSH_WEB_URL，最后默认值
//
// ⚠️ 关于端口（踩过的坑，别再绕）：这里解析的只是**桌面端要连到哪里**。
// dsh 服务自己监听哪个端口，是由 profile 配置决定的：
//     ~/.dsh/profiles/web/cordis.patch.yml  →  webserver.config.port
// 实测：给 dsh 传 `web --port 3099` **完全无效**，它照样去绑 profile 里的 3080
// （会报 EADDRINUSE 127.0.0.1:3080）。也就是说命令行 --port 被 profile 覆盖了。
// 想改端口必须改 profile 配置并重启服务，改这里或传 --port 都没用。
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

// ---------------------------------------------------------------------------
// 主进程兜底网：任何未捕获异常/未处理 Promise 都不允许再弹
// "A JavaScript error occurred in the main process" 并带崩整个壳。
// 窗口生命周期回调（closed / did-finish-load / loadURL 失败）最容易在
// 窗口已销毁后触发，这里记录日志并放行，保住已开着的窗口。
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  console.error('[dsh-desktop] uncaughtException:', (err && err.stack) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[dsh-desktop] unhandledRejection:', (reason && reason.stack) || reason);
});

// 开发模式用独立的用户数据目录，避免和安装版互相干扰
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'dsh-desktop-dev'));
}

// ---------------------------------------------------------------------------
// 设置持久化（userData/settings.json）
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  settingsVersion: 2, // 设置结构版本：>=2 表示 v0.1.4+（开机自启默认开启）
  // 注意：不要给默认命令加 --host 0.0.0.0 —— dsh 出于安全（会向网络暴露远程代码执行）明确拒绝该绑定；
  // 默认即绑定 127.0.0.1，LAN/手机访问走 Tailscale serve（见 remote-expose）。
  serverCommand: 'npx --yes @deepseek-ai/dsh web --no-open', // 拉起 DSH 服务（--no-open：别弹系统浏览器，工作台由本壳自己的窗口承载）
  autoStartServer: true, // DSH 服务未运行时是否自动拉起
  openAtLogin: true, // 开机自启（默认开启，安装版首次运行即注册 Windows 登录项）
  systemCerts: true, // 给拉起的服务注入 --use-system-ca（内网/代理证书环境需要）
  onboardingDone: false, // 首次启动引导是否已完成
  hideTerminal: true, // 隐藏 DSH 网页里的终端界面（data-terminal 块）
  fileBrowseRoot: '', // 服务终端「文件」栏浏览的根目录（空 = 默认 $DSH_HOME）
  frameless: true, // 去掉系统窗口外框（自绘标题栏）。false 时恢复原生边框+菜单栏
  closeToTray: true, // 点关闭 = 收进任务栏小组件（托盘），服务继续在后台跑；false = 直接退出
  showTrayIcon: true, // 是否显示任务栏小组件（托盘）图标
  hideFromTaskbar: true, // 不在任务栏显示控制台按钮（像 CC Switch 那样，只从托盘图标进入）
};

// v0.2.0 曾把默认命令写成 `... web --host 0.0.0.0`，但 dsh 拒绝该绑定，属于坏默认；
// 存过该值的设置要迁移回干净默认，并把它视为「默认」处理（走 node+dsh 直连，绕开 cmd/npx）
const LEGACY_HOST_DEFAULT_SERVER_CMD = 'npx --yes @deepseek-ai/dsh web --host 0.0.0.0';
// v0.2.1 起默认命令加 --no-open（dsh web 默认会弹系统浏览器，本壳有自己的工作台窗口）。
// 旧默认里没有 --no-open，也要按「默认」处理并迁移，否则会被误判成自定义命令、
// 掉进脆弱的 cmd /c 路径（还会继续弹浏览器）。
const LEGACY_DEFAULT_SERVER_CMDS = [
  LEGACY_HOST_DEFAULT_SERVER_CMD,
  'npx --yes @deepseek-ai/dsh web',
];

let settings = { ...DEFAULT_SETTINGS };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  let changed = false;
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...raw };
    if (!raw.settingsVersion || raw.settingsVersion < 2) {
      // v0.1.4 起开机自启改为默认开启：旧版设置里显式存过 false，这里强制迁移一次
      settings.openAtLogin = true;
      settings.settingsVersion = 2;
      changed = true;
    }
    if (settings.serverCommand && LEGACY_DEFAULT_SERVER_CMDS.includes(settings.serverCommand.trim())) {
      // 旧默认（含 v0.2.0 的 --host 0.0.0.0 坏默认、以及无 --no-open 的旧默认）迁移到当前默认
      settings.serverCommand = DEFAULT_SETTINGS.serverCommand;
      changed = true;
    }
    if (changed) saveSettings();
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

// 本机回环地址上的服务端口是否已被占用（同步、快速）。
//
// ⚠️ 一定要只认 127.0.0.1 / [::1]，不能只匹配 `:3080 ... LISTENING`。
// 踩过的坑：Tailscale serve 会在 tailnet IP（如 100.66.8.87:3080）上 LISTENING，
// 用来把手机的访问转发到 127.0.0.1:3080。若正则不区分地址，就会把 tailscaled
// 误判成「端口被占用」，导致：
//   - startDshServer() 直接 return，dsh 永远拉不起来
//   - takeOverServer() 拿到 tailscaled 的 PID，isDshProcess() 判定不是 dsh → 放弃接管
//   - 用户看到的是「服务离线」且怎么点都起不来，而手机远端访问也不受影响 —— 极难排查。
// dsh 默认只绑 127.0.0.1，所以只判断回环地址是否被占即可。
function isPortBusy() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 3000,
    });
    const port = serverUrl.port || (serverUrl.protocol === 'https:' ? '443' : '80');
    return loopbackListenRe(port).test(out);
  } catch {
    return false;
  }
}

// 「回环地址上正在 LISTENING 指定端口」的正则。
// netstat 的本机地址列会是 `127.0.0.1:3080` 或 `[::1]:3080`，
// 后面的状态列必须紧接 LISTENING（避免匹配到 ESTABLISHED 的连接行）。
function loopbackListenRe(port) {
  return new RegExp(
    `(?:127\\.0\\.0\\.1|\\[::1\\]|\\[0:0:0:0:0:0:0:1\\]):${port}\\s+\\S+\\s+LISTENING`,
    'i'
  );
}

// 找出占用回环端口的进程 PID（只认 127.0.0.1/[::1] 上的 LISTENING）。
// 与 isPortBusy 用同一套地址判定——否则会出现「判定占用、却找不到占用者」
// 的不一致（tailscaled 就是这个反例）。
function findPortOwnerPid() {
  try {
    const { execFileSync } = require('child_process');
    const port = serverUrl.port || (serverUrl.protocol === 'https:' ? '443' : '80');
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 3000,
    });
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(
        new RegExp(
          `(?:127\\.0\\.0\\.1|\\[::1\\]|\\[0:0:0:0:0:0:0:1\\]):${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`,
          'i'
        )
      );
      if (m) return Number(m[1]);
    }
  } catch {
    /* ignore */
  }
  return null;
}

// 判断某个 PID 是不是 dsh 进程（避免误杀 tailscaled 等无关监听者）。
// 注意：不能再用 wmic —— 新版 Windows（11 24H2+）已移除 wmic.exe，
// 调用会直接抛「不是内部或外部命令」，使判定永远为 false、接管功能静默失效。
// 改用 PowerShell 的 CIM，Win10/11 都有。
function isDshProcess(pid) {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 8000 }
    );
    const cmd = String(out || '');
    // dsh 服务进程的命令行里必然同时出现 dsh 与 web 子命令
    return /dsh/i.test(cmd) && /\bweb\b/i.test(cmd);
  } catch {
    return false;
  }
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
let serverTokenUrl = ''; // dsh 每次启动会生成随机 token 的真实服务地址（http://127.0.0.1:3080/?token=...）
let workbenchLoadedUrl = ''; // 工作台最近一次实际下发加载的 URL（token URL 303 后会落到普通地址栏，不能拿 getURL() 对比）
let lastTakeoverAttempt = 0; // 上次「接管无 token 服务」的时间，防止每 3 秒反复杀进程
let logBuffer = '';
let logFlushTimer = null;

function notifyFallback(status) {
  // 服务起停会影响托盘菜单里「运行中/未运行」与按钮可用性，顺带刷新
  refreshTrayMenu();
  if (win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
    win.webContents.send('server-status', status);
  }
}

// 抓取 stdout 里 dsh 打印的真实服务地址（带 token），供工作台/远程访问使用
function captureServerUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s]*[?&]token=[^\s]*/);
  if (m && m[0]) {
    serverTokenUrl = m[0].trim();
    notifyServerToken(); // token 一变就推给控制台，界面地址实时刷新
  }
}

// 把当前服务访问地址（含 token 状态）推给控制台：无论 token 怎么变，
// 控制台始终显示「当前有效」的带 token 地址与免 key 地址
function notifyServerToken() {
  if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return;
  win.webContents.send('server-token', {
    tokenUrl: serverTokenUrl,
    workbenchUrl: currentWorkbenchUrl(),
    hasToken: Boolean(serverTokenUrl),
  });
}

// 把服务输出转发到加载页控制台：缓冲后批量发送，保留完整终端内容（不截断、不丢行）
function notifyServerLog(text) {
  const s = String(text);
  if (!s) return;
  captureServerUrl(s);
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

// ---------------------------------------------------------------------------
// 启动进度播报
//
// 为什么需要：实测 dsh 启动时 **stdout 完全是空的**（18 秒内零输出），只有
// stderr 偶尔有内容。所以「服务开到哪里了」不能只靠 dsh 自己的日志——否则
// 终端会长时间一片空白，用户以为卡死了。
// 这里由桌面端主动补充里程碑与端口探测，把启动过程变成可观测的进度。
//
// 输出格式：`[HH:MM:SS] ▶ 里程碑文字`，渲染端按 `▶` 前缀着色。
// ---------------------------------------------------------------------------
function logMilestone(text) {
  const t = new Date().toTimeString().slice(0, 8);
  notifyServerLog(`\n[${t}] ▶ ${text}\n`);
}

let portWatchTimer = null;
let portWatchStart = 0;
let portWatchNotifiedReady = false;

function stopPortWatch() {
  if (portWatchTimer) {
    clearInterval(portWatchTimer);
    portWatchTimer = null;
  }
}

// 每 500ms 探一次回环端口，让用户看到「正在等待监听」而不是一片空白。
// 探测到后播报「服务已就绪」并停止。最多探 SERVER_START_STALL_TIMEOUT。
function startPortWatch() {
  stopPortWatch();
  portWatchNotifiedReady = false;
  portWatchStart = Date.now();
  const port = serverUrl.port || (serverUrl.protocol === 'https:' ? '443' : '80');
  let ticks = 0;
  portWatchTimer = setInterval(() => {
    ticks += 1;
    if (isPortBusy()) {
      const secs = ((Date.now() - portWatchStart) / 1000).toFixed(1);
      // 只有第一次就绪才播报，避免反复刷
      if (!portWatchNotifiedReady) {
        portWatchNotifiedReady = true;
        logMilestone(`端口 ${port} 已开始监听（用时 ${secs}s）`);
        logMilestone('服务已就绪');
      }
      stopPortWatch();
      return;
    }
    // 每 4 秒（8 个 tick）播一次等待进度，既不刷屏也让用户知道还活着
    if (ticks % 8 === 0) {
      const secs = ((Date.now() - portWatchStart) / 1000).toFixed(0);
      logMilestone(`仍在等待 ${port} 监听…（已 ${secs}s）`);
    }
  }, 500);
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
  // 直接扫描 PATH 里的 node.exe：覆盖非标准安装目录（如便携版 node），
  // 不依赖 `where` 的解析，也避免 cmd/npx 依赖（PATH 里没有就找不到）
  for (const dir of (process.env.PATH || '').split(';')) {
    if (!dir) continue;
    try {
      const c = path.join(dir.replace(/^"|"$/g, ''), 'node.exe');
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

// 探测本机 Tailscale（tailnet）信息：域名 + IPv4。供 harness 重启时注入 --trusted-host，
// 让手机经 tailnet 域名直连也能过 browser-trust 围栏（而非只能本机）。
let tailnetCache = null;
function getTailnetInfo() {
  if (tailnetCache) return tailnetCache;
  tailnetCache = { fqdn: '', ipv4: '' };
  try {
    const out = execFileSync('tailscale', ['status', '--json'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    const j = JSON.parse(out);
    const self = j && j.Self;
    tailnetCache = {
      fqdn: String(self?.DNSName || '').replace(/\.$/, ''),
      ipv4: Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs.find((x) => String(x).startsWith('100.')) || '' : '',
    };
  } catch {
    /* 未装/未连 Tailscale 时留空（仅本机可用） */
  }
  return tailnetCache;
}

// serverCommand 是否算「非默认」：空 / 当前默认 / 各个历史默认都按默认处理，
// 只有用户真正改成别的命令才走脆弱的 cmd /c shell 路径
function isCustomServerCommand(value) {
  const s = (value || '').trim();
  return !(s === '' || s === DEFAULT_SETTINGS.serverCommand || LEGACY_DEFAULT_SERVER_CMDS.includes(s));
}

// 解析实际执行目标：
// - 默认命令：系统 node + npx 缓存里的 dsh 直连（带 --expose-internals）；无缓存时退化为「node + npx-cli.js」
// - 自定义命令：保持 cmd /c 兼容
// dsh 的 HMR 插件要求 node 带 --expose-internals，故直连路径显式带上
function resolveLaunchTarget() {
  const configured = effectiveServerCommand();
  const isDefault = !process.env.DSH_DESKTOP_SERVER_CMD && !isCustomServerCommand(settings.serverCommand);
  if (isDefault) {
    const node = findNodeExecutable();
    const cliJs = findCachedDsh();
    if (node && cliJs) {
      const display = `"${node}" --expose-internals "${cliJs}" web --no-open`;
      // --no-open：dsh web 默认 openBrowser:true 会弹系统浏览器；本壳有自己的工作台窗口，
      // 不需要它再开一个（就是用户抱怨的「启动后弹出网页」）
      const args = ['--expose-internals', cliJs, 'web', '--no-open'];
      // tailnet 域名放行进 browser-trust（手机直连 harness），失败即忽略（仅本机可用）
      const tl = getTailnetInfo();
      if (tl.fqdn) {
        args.push('--trusted-host', tl.fqdn, '--trusted-host', `${tl.fqdn}:443`);
      }
      if (tl.ipv4) {
        args.push('--trusted-host', tl.ipv4, '--trusted-host', `${tl.ipv4}:3080`);
      }
      return { type: 'direct', exec: node, args, display };
    }
    if (node) {
      const npxCli = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npx-cli.js');
      if (fs.existsSync(npxCli)) {
        const display = `"${node}" "${npxCli}" --yes @deepseek-ai/dsh web --no-open`;
        return {
          type: 'direct',
          exec: node,
          args: [npxCli, '--yes', '@deepseek-ai/dsh', 'web', '--no-open'],
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
  // 安全默认：新建 agent 会话 workspace-write + ask（工具需确认）；手机/桌面一致
  if (!env.DSH_PERMISSION_MODE) env.DSH_PERMISSION_MODE = 'workspace-write';
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

// 接管端口上那个「不是本进程拉起的」dsh：
// 杀掉旧进程 → 重新拉起 → 这样我们才能从新进程的 stdout 里拿到 token。
// 这是「服务在线但工作台一直转圈（401）」的正解——旧服务的 token 无法找回。
function takeOverServer() {
  const pid = findPortOwnerPid();
  if (pid && isDshProcess(pid)) {
    console.log(`[dsh-desktop] 接管端口上的旧 dsh 进程 pid=${pid}`);
    logMilestone(`接管：结束占用端口的旧服务（PID ${pid}）`);
    killServerTree(pid);
  } else if (pid) {
    // 端口被非 dsh 进程占用（例如 tailscaled 转发）：不杀，交由上层提示
    console.log(`[dsh-desktop] 端口被非 dsh 进程占用 pid=${pid}，不接管`);
    logMilestone(`端口被非 DSH 进程占用（PID ${pid}），不做接管`);
    return false;
  }
  // 清掉本进程的旧状态，回到「未启动」再拉起
  serverChild = null;
  serverStarting = false;
  clearStallTimer();
  stopPortWatch();
  serverTokenUrl = '';
  notifyServerToken(); // 接管前先让控制台清掉旧地址
  // 给被杀进程一点时间释放端口
  logMilestone('等待旧服务释放端口…');
  setTimeout(() => {
    lastSpawnAttempt = 0; // 绕过 15s 冷却
    startDshServer();
  }, 700);
  return true;
}

function startDshServer() {
  if (serverStarting || serverChild) return false;
  const target = resolveLaunchTarget();
  if (!target || !target.args.length) return false;

  // 端口已被占用时**不能直接采用**：dsh 的访问 token 是每次启动随机生成、
  // 只在该进程 stdout 里打印一次的（不落盘）。若 3080 上是别人启动的 dsh
  // （上次残留 / 手动起的 / 另一个实例），我们拿不到它的 token，
  // 工作台就会加载无 token 的地址 → 401 → 一直转圈。
  // 所以这里分两种情况：
  //   - 端口空      → 正常拉起（能捕获到 token）
  //   - 端口被占用  → 不重复拉起（避免 EADDRINUSE 刷屏），但要明确报出来，
  //                  让用户知道需要用「重启服务」把旧进程接管掉
  if (isPortBusy()) {
    if (serverTokenUrl) {
      logMilestone('服务已在运行，直接复用（无需重新启动）');
      notifyFallback('online'); // 本进程拉起且已拿到 token，正常复用
    } else {
      // 拿不到 token 的"孤儿服务"：不假装在线，推 offline 让用户在控制台看到
      logMilestone('检测到端口已被占用，但无法取得服务凭据（token）');
      logMilestone('将尝试接管：结束旧服务后重新启动，以取得新 token');
      notifyFallback('offline');
    }
    return false;
  }

  serverStarting = true;
  lastSpawnAttempt = Date.now();
  clearStallTimer();
  notifyFallback('starting');
  serverTokenUrl = ''; // 新进程会打印新 token，旧的作废
  notifyServerToken(); // 清旧 token 状态，控制台回到「等待 token」

  // —— 启动里程碑：让终端显示「开到哪里了」——
  const port = serverUrl.port || '3080';
  logMilestone(`准备启动 DSH 服务（目标 ${serverUrl.hostname}:${port}）`);
  logMilestone(
    target.type === 'direct'
      ? `启动方式：node 直连（跳过 npx，无需 shell）`
      : `启动方式：自定义命令（经 cmd 执行）`
  );
  logMilestone(
    target.type === 'direct'
      ? `执行：${path.basename(target.exec)} + dsh 入口`
      : `执行：${target.display}`
  );
  logMilestone('数据库/插件树加载中，首次运行或联网安装时较慢…');

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
      // 自定义命令：cmd /d /s /c 兼容（windowsHide 隐藏主 cmd 窗口）。
      // 命令本身已带首尾引号时不再重复包一层，避免 cmd 把整串当成单个程序名报 not recognized
      const rawCmd = Array.isArray(target.args) ? target.args.join(' ').trim() : String(target.args || '').trim();
      const cmdLine = /^".*"$/.test(rawCmd) ? rawCmd : `"${rawCmd}"`;
      serverChild = spawn(target.exec, ['/d', '/s', '/c', cmdLine], {
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

    serverChild.on('error', (err) => {
      clearStallTimer();
      stopPortWatch();
      logMilestone(`启动失败：${(err && err.message) || '未知错误'}`);
      serverChild = null;
      serverStarting = false;
      notifyFallback('failed');
    });
    serverChild.on('exit', (code) => {
      clearStallTimer();
      stopPortWatch();
      // code 为 0 说明是我们主动停的；非 0 是异常退出，把码报出来便于排查
      if (code !== 0 && code !== null) {
        logMilestone(`服务进程退出（退出码 ${code}）`);
      }
      serverChild = null;
      serverStarting = false;
      notifyFallback('waiting');
    });

    // 进程已 spawn：开始每 500ms 探端口，把「等待监听」变成可观测进度。
    // 因为 dsh 启动期间 stdout 全空，不主动探的话终端会一直没动静。
    startPortWatch();
    return true;
  } catch (err) {
    clearStallTimer();
    stopPortWatch();
    logMilestone(`启动异常：${(err && err.message) || '未知错误'}`);
    serverStarting = false;
    notifyFallback('failed');
    return false;
  }
}

let win = null;
let workbenchWin = null;
let pollTimer = null;
// 工作台正在打开（窗口已建、页面未就绪）：此期间保持加载动画，轮询不要把它覆盖成 online
let workbenchOpening = false;

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

    // 「有响应」不等于「能用」：dsh 的每个接口都要 token，而 token 只有拉起它的
    // 那个进程的 stdout 里有。如果我们没拿到 token（serverTokenUrl 为空），
    // 工作台加载的就是无 token 地址 → 401 → 永远转圈。
    // 这种情况必须自动接管（杀掉旧进程重新拉起）来取得 token，
    // 否则用户看到的是「服务在线」但界面永远用不了。
    if (online && !serverTokenUrl && !serverStarting && !serverChild && settings.autoStartServer) {
      if (!lastTakeoverAttempt || Date.now() - lastTakeoverAttempt > 30000) {
        lastTakeoverAttempt = Date.now();
        console.log('[dsh-desktop] 服务在线但无 token，自动接管以取得 token');
        notifyFallback('starting');
        takeOverServer();
        return;
      }
    }

    if (online) {
      markOnboardingDone();
      // 服务已健康在线 = 启动阶段结束：清掉启动看门狗并复位启动标记。
      // 否则 serverStarting 会一直保持 true，180s 后看门狗把正常运行的
      // 服务当作「卡死」杀掉——每 3 分钟死一次，桌面端反复拉起/工作台反复重载。
      clearStallTimer();
      serverStarting = false;
      if (!workbenchOpening) notifyFallback('online');
      refreshWorkbenchUrl();
      notifyServerToken();
      return;
    }

    // —— 以下是「探测不到服务」的分支 ——
    // 关键：启动阶段（刚拉起 / 还没超过首次就绪时间）不能报 offline。
    // 用户原话：「动画一定要与开启时间一致，不要突然说服务离线然后突然接上」。
    // 服务拉起后需要时间监听端口，这段空窗不是"离线"，应当保持"启动中"。
    if (serverStarting || serverChild) {
      if (!workbenchOpening) notifyFallback('starting');
      return;
    }

    if (!workbenchOpening) notifyFallback('offline');

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

// dsh 每次启动生成随机 token（只能在 stdout 里拿到），工作台必须加载这个带 token 的地址
function currentWorkbenchUrl() {
  return serverTokenUrl || serverUrl.toString();
}

// 把已打开的工作台刷到带 token 的真实地址：服务重启换了 token、或工作台赶在 token
// 输出前就打开（落到普通 URL）两种情况都靠这里纠正。
// 对比「实际下发加载的 URL」而不是 webContents.getURL()：token URL 303 后会落到
// http://127.0.0.1:3080/（地址栏看不到 token），拿地址栏对比会误判成每次都变、无限刷新。
// 先记账再 loadURL：否则轮询每 3 秒命中一次不匹配就硬重载，页面永不稳定。
function refreshWorkbenchUrl() {
  if (!workbenchWin || workbenchWin.isDestroyed()) return;
  if (!serverTokenUrl) return; // 没有捕获到本服务 token（外部服务）就不刷
  const target = currentWorkbenchUrl();
  if (workbenchLoadedUrl === target) return; // 工作台已经在这个地址
  workbenchLoadedUrl = target;
  try {
    workbenchWin.loadURL(target).catch(() => {});
  } catch {
    /* ignore */
  }
}

// 统一的外部链接策略：非本服务域一律交给系统默认浏览器
// （主窗口 / 工作台窗口共用。修「里面的网站点开不直接进默认浏览器」）
function attachExternalLinkPolicy(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      const sameHost = target.hostname === serverUrl.hostname && target.port === (serverUrl.port || '');
      if (!sameHost) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    } catch {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  webContents.on('will-navigate', (e, url) => {
    try {
      const target = new URL(url);
      const sameHost = target.hostname === serverUrl.hostname && target.port === (serverUrl.port || '');
      if (!sameHost) {
        e.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      /* 非法 URL 不拦截 */
    }
  });
}

// ---------------------------------------------------------------------------
// 窗口尺寸自适应：按当前显示器「工作区」取尺寸，并显式居中
//
// 关于 DPI（踩过两次坑，别再改错）：
//   - electron 的 screen.workArea / workAreaSize **已经是 DIP**，与
//     BrowserWindow 的 width/height/x/y 同一坐标系，**不需要再除以 scaleFactor**。
//   - 实测（本机 1536x960 @ scaleFactor=1.25）：new BrowserWindow({width:1184})
//     读回 getBounds().width === 1190，即 DIP↔物理 ≈ 1:1。
//   - 曾错误地按 scaleFactor 折算，窗口被缩成 ~77%（把 1228 DIP 当 1536 用），
//     结果顶栏的「打开工作台」按钮和窗口控制按钮被挤出可视区。
// 这里直接用 workArea 的宽高，按比例夹取后居中。
// ---------------------------------------------------------------------------
function computeWindowSize(minW = 900, minH = 600) {
  const { screen } = require('electron');
  let area = { width: 1360, height: 880, x: 0, y: 0 };
  try {
    // 取最贴近光标（即用户当前所在）的显示器
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // workArea 是扣掉任务栏的可用区域，单位已是 DIP
    const wa = display.workArea || display.workAreaSize || display.bounds;
    if (wa && wa.width) area = wa;
  } catch {
    /* 取不到就退回默认尺寸 */
  }

  // 目标 1360x880，但不超过可用区的 95%（留出视觉边距）
  const width = Math.max(minW, Math.min(1360, Math.floor(area.width * 0.95)));
  const height = Math.max(minH, Math.min(880, Math.floor(area.height * 0.95)));

  // 在可用区域内居中；窗口比可用区还大时贴左上
  const ax = area.x || 0;
  const ay = area.y || 0;
  const x = Math.max(ax, Math.min(ax + area.width - width, ax + Math.floor((area.width - width) / 2)));
  const y = Math.max(ay, Math.min(ay + area.height - height, ay + Math.floor((area.height - height) / 2)));
  return { width, height, x, y };
}

function createWorkbenchWindow() {
  // 工作台承载整个 DSH 网页界面。
  // 尺寸不设实际限制：用户要「能缩更小、要自由」，320x200 只是技术下限。
  const { width, height, x, y } = computeWindowSize(320, 200);
  const wb = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 320,
    minHeight: 200,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#0a0a0a',
    // 工作台无系统外框（用户要求「边框最好没有」）。DSH 网页自身没有拖拽区，
    // 所以靠 injectWorkbenchDragRegion() 注入一条顶部拖拽带 + 四条缩放热区，
    // 否则无边框窗口既拖不动也拉不大。
    frame: false,
    autoHideMenuBar: true,
    // 无边框窗口默认不可 resize，显式打开
    resizable: true,
    webPreferences: {
      // 工作台是远程页面，只给一个极小的窗口控制 preload（min/fs/close 白名单）
      preload: path.join(__dirname, 'workbench-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要 require('electron') 的 ipcRenderer
      spellcheck: false,
    },
  });
  attachExternalLinkPolicy(wb.webContents);
  // 每次加载完都注入标题栏（DSH 是 SPA，导航后注入的样式会丢，所以每次都补）
  wb.webContents.on('did-finish-load', () => injectWorkbenchChrome(wb));
  return wb;
}

// ---------------------------------------------------------------------------
// 给无边框工作台注入「macOS 式细标题栏 + 可拖拽 / 可缩放」能力
//
// 为什么需要：工作台 frame:false（无系统边框），而 DSH 网页自身没有拖拽区、
// 也没有窗口按钮。不注入的话窗口拖不动、关不掉、被别的窗口遮住后找不回来。
//
// 样式（用户要求「用 mac 那个，小、黑、好看」）：
//   - 高度 28px，纯黑 #0a0a0a，底部 1px 极细分隔线
//   - 左侧三个 macOS 红黄绿交通灯（关闭 / 最小化 / 全屏），未 hover 时只在
//     轨道上显示为暗色圆点，hover 整条标题栏才亮起并显示符号（macOS 行为）
//   - 中间居中显示窗口标题，macOS 的字体与灰阶
//   - 可拖拽区占满整条（按钮区 no-drag）
// 只加覆盖层与样式，不改 DSH 的 DOM 结构；DSH 是 SPA，每次 did-finish-load 都补。
// ---------------------------------------------------------------------------
const WORKBENCH_CHROME_CSS = `
  #dsh-wb-bar {
    position: fixed; top: 0; left: 0; right: 0; height: 28px;
    display: flex; align-items: center;
    padding: 0 10px;
    background: #0a0a0a;
    border-bottom: 1px solid #1f1f1f;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 12px;
    color: #9a9a9a;
    -webkit-app-region: drag;
    z-index: 2147483647;
    box-sizing: border-box;
    user-select: none;
  }
  /* macOS 交通灯 */
  #dsh-wb-bar .wb-lights {
    display: flex; align-items: center; gap: 8px;
    -webkit-app-region: no-drag;
    flex: 0 0 auto;
  }
  #dsh-wb-bar .wb-light {
    width: 12px; height: 12px; padding: 0; border: 0; border-radius: 50%;
    background: #3a3a3a; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    transition: background 0.12s ease;
  }
  /* 未 hover 时三个都是暗点（macOS 非活动窗口的样子）；hover 标题栏才上色 */
  #dsh-wb-bar:hover .wb-light.close { background: #ff5f57; }
  #dsh-wb-bar:hover .wb-light.min   { background: #febc2e; }
  #dsh-wb-bar:hover .wb-light.fs    { background: #28c840; }
  /* 交通灯里的符号：默认隐藏，hover 单个按钮才出现（macOS 细节） */
  #dsh-wb-bar .wb-light svg { opacity: 0; transition: opacity 0.12s ease; }
  #dsh-wb-bar .wb-light:hover svg { opacity: 0.65; }
  #dsh-wb-bar .wb-light svg { color: #4a0000; }
  /* 居中标题 */
  #dsh-wb-bar .wb-title {
    position: absolute; left: 0; right: 0;
    text-align: center; pointer-events: none;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    padding: 0 90px;
    color: #8a8a8a;
  }
  /* 页面顶部下移，避免标题栏盖住 DSH 自己的顶栏 */
  html.dsh-wb-has-bar, body.dsh-wb-has-bar {
    padding-top: 28px !important;
    box-sizing: border-box !important;
  }
  /* 边缘缩放热区。
     注意：这些是 position:fixed 的覆盖层，如果铺得太宽会盖住页面内容、
     吞掉点击（用户报「工作台左键选择没有用」就是这个原因）。
     所以：
       1) 只做 3px 细边，且 z-index 低于标题栏
       2) 默认 pointer-events:none —— 不拦截任何点击
       3) 只在鼠标移到最边缘 3px 时才由 JS 打开 pointer-events
     这样既保留了拖边缩放，又完全不影响页面内的点击。 */
  .dsh-desktop-resize {
    position: fixed; z-index: 2147483640;
    -webkit-app-region: no-drag;
    pointer-events: none;   /* 关键：默认不拦截点击 */
  }
  .dsh-desktop-resize.armed { pointer-events: auto; }
  .dsh-desktop-resize.n { top:0;    left:0;   right:0;  height:3px; cursor:ns-resize; }
  .dsh-desktop-resize.s { bottom:0; left:0;   right:0;  height:3px; cursor:ns-resize; }
  .dsh-desktop-resize.w { top:0;    bottom:0; left:0;   width:3px;  cursor:ew-resize; }
  .dsh-desktop-resize.e { top:0;    bottom:0; right:0;  width:3px;  cursor:ew-resize; }
`;

function injectWorkbenchChrome(wb) {
  if (!wb || wb.isDestroyed()) return;
  const js = `(() => {
    if (document.getElementById('dsh-wb-bar')) return;
    const style = document.createElement('style');
    style.id = 'dsh-wb-style';
    style.textContent = ${JSON.stringify(WORKBENCH_CHROME_CSS)};
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'dsh-wb-bar';
    // 交通灯顺序与 macOS 一致：关闭 / 最小化 / 全屏
    bar.innerHTML =
      '<div class="wb-lights">' +
        '<button class="wb-light close" data-wb="close" title="关闭" aria-label="关闭">' +
          '<svg width="7" height="7" viewBox="0 0 10 10"><path d="M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>' +
        '</button>' +
        '<button class="wb-light min" data-wb="min" title="最小化" aria-label="最小化">' +
          '<svg width="7" height="7" viewBox="0 0 10 10"><path d="M2 5 L8 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>' +
        '</button>' +
        '<button class="wb-light fs" data-wb="fs" title="全屏" aria-label="全屏">' +
          '<svg width="7" height="7" viewBox="0 0 10 10"><path d="M3 3 L3 7 L7 7 L7 3 Z" fill="currentColor"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="wb-title">DeepSeek Harness</div>';

    document.documentElement.classList.add('dsh-wb-has-bar');
    document.body.classList.add('dsh-wb-has-bar');
    document.body.appendChild(bar);

    for (const side of ['n','s','w','e']) {
      const h = document.createElement('div');
      h.className = 'dsh-desktop-resize ' + side;
      h.dataset.side = side;
      document.body.appendChild(h);
    }

    // 只把鼠标真正贴到最边缘 3px 时，才让对应热区接收指针事件。
    // 否则这些 fixed 覆盖层会挡住页面里的点击（尤其左边缘整条竖带，
    // 正好压在 DSH 左侧栏上，表现为「左键选择没有用」）。
    const EDGE = 3;
    const handles = [...document.querySelectorAll('.dsh-desktop-resize')];
    const setArmed = (side, on) => {
      for (const h of handles) {
        if (h.dataset.side === side) h.classList.toggle('armed', on);
      }
    };
    window.addEventListener(
      'mousemove',
      (e) => {
        const x = e.clientX;
        const y = e.clientY;
        const w = window.innerWidth;
        const hgt = window.innerHeight;
        setArmed('w', x <= EDGE);
        setArmed('e', x >= w - EDGE);
        setArmed('n', y <= EDGE);
        setArmed('s', y >= hgt - EDGE);
      },
      { passive: true }
    );
    // 鼠标离开窗口时全部收起来，避免状态残留
    window.addEventListener('mouseleave', () => {
      for (const h of handles) h.classList.remove('armed');
    });

    // 交通灯 → postMessage → workbench-preload → ipcRenderer（白名单校验）
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.wb-light');
      if (!btn) return;
      const action = btn.getAttribute('data-wb');
      if (!action) return;
      window.postMessage({ __dshWin: true, action }, '*');
    });

    // 双击标题栏 = 全屏（macOS 习惯：双击标题栏是缩放）
    bar.addEventListener('dblclick', (e) => {
      if (e.target.closest && e.target.closest('.wb-light')) return;
      window.postMessage({ __dshWin: true, action: 'fs' }, '*');
    });
  })();`;
  wb.webContents.executeJavaScript(js).catch(() => {
    /* 页面还没就绪或被导航打断：下一次 did-finish-load 会再补 */
  });
}

// 打开 DSH 工作台：独立窗口加载服务网页，服务在线才开
async function openWorkbench() {
  if (!(await checkServer())) return false;
  if (workbenchWin && !workbenchWin.isDestroyed()) {
    workbenchWin.focus();
    return true;
  }
  // 关键：所有回调绑定「本次创建的这个窗口实例」，而不是模块级可变的 workbenchWin。
  // workbenchWin 会在 closed / loadURL 失败时被置 null，若回调事后才触发，
  // 再去读 workbenchWin.webContents 就会抛
  // "Cannot read properties of null (reading 'webContents')"——主进程未捕获异常直接崩壳。
  const wb = createWorkbenchWindow();
  workbenchWin = wb;

  // 工作台在加载：保持加载动画，直到页面真正就绪（用户要求动画持续到工作台打开）
  workbenchOpening = true;
  notifyFallback('opening');

  // did-finish-load 才是「工作台真的打开了」：这时才收起加载动画
  wb.webContents.on('did-finish-load', () => {
    if (wb.isDestroyed()) return;
    applyTerminalCss(wb.webContents);
    workbenchOpening = false;
    notifyFallback('online');
  });
  wb.on('closed', () => {
    if (workbenchWin === wb) workbenchWin = null;
    workbenchOpening = false;
    notifyFallback('online'); // 服务仍在，只是工作台关了
  });
  try {
    const wbUrl = currentWorkbenchUrl();
    await wb.loadURL(wbUrl);
    // loadURL 期间窗口可能已被用户关掉：此时不能再把它记成「当前工作台」
    if (wb.isDestroyed()) {
      if (workbenchWin === wb) workbenchWin = null;
      workbenchOpening = false;
      return false;
    }
    workbenchLoadedUrl = wbUrl;
  } catch (err) {
    console.error('loadURL failed:', err);
    if (workbenchWin === wb) workbenchWin = null;
    if (!wb.isDestroyed()) wb.destroy();
    workbenchOpening = false;
    notifyFallback('online'); // 服务本身没问题，回到在线态
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
  // 局部名避开全局 win：回调一律绑定这个实例，避免全局被置 null 后回调里读到 null
  const mainSize = computeWindowSize(900, 600);
  const w = new BrowserWindow({
    width: mainSize.width,
    height: mainSize.height,
    x: mainSize.x,
    y: mainSize.y,
    // 尺寸不设限：用户要「能缩更小、要自由」。320x200 只是技术上不会让
    // Electron 出错的下限，其余交给用户自己决定（布局挤了是他自己的选择）。
    minWidth: 320,
    minHeight: 200,
    title: 'DeepSeek Harness',
    autoHideMenuBar: settings.frameless,
    // frameless：去掉系统外框，由控制台自己画标题栏（窗口按钮走 IPC）
    frame: !settings.frameless,
    show: false, // 等页面 ready-to-show 再显示，避免白屏闪烁
    // ⚠️ 不要在创建时传 skipTaskbar —— 实测这样会让窗口被加回系统边框
    // （WS_CAPTION 重新出现，露出白色标题栏）。改为窗口创建后用
    // win.setSkipTaskbar() 运行时设置，见 applyTaskbarSetting()。
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win = w;

  w.once('ready-to-show', () => {
    if (!w.isDestroyed()) w.show();
  });

  // 外部链接用系统浏览器打开，内部导航留在窗口里
  attachExternalLinkPolicy(w.webContents);

  // 任务栏可见性在窗口创建后用运行时 API 设置（创建时传参会带出系统边框）。
  // 必须在 frame 已生效之后再调用，否则同样可能触发样式重建。
  try {
    w.setSkipTaskbar(Boolean(settings.hideFromTaskbar));
  } catch {
    /* 个别平台不支持，忽略 */
  }

  // 主窗口 = 双控制台界面（服务终端 + 管理后台），始终加载本地 UI
  w.loadFile(path.join(__dirname, '..', 'ui', 'dist', 'index.html'));

  w.webContents.on('did-finish-load', () => {
    if (w.isDestroyed()) return;
    // 页面就绪后开始探测；服务离线且开了自动拉起就直接拉起 dsh
    startStatusPolling();
    checkServer().then((online) => {
      // checkServer 是异步的：回来时窗口/应用可能已经关了
      if (w.isDestroyed()) return;
      if (workbenchOpening) return; // 工作台加载中，动画由它自己收尾
      if (online) {
        notifyFallback('online');
      } else if (settings.autoStartServer) {
        // 要自动拉起服务：先亮「启动中」，别先闪一下「服务离线」——
        // 用户看到「离线」再「接上」会以为是故障。启动过程统一显示启动中。
        notifyFallback('starting');
        startDshServer();
      } else {
        notifyFallback('offline');
      }
    });
  });

  // 最小化 / 还原：通知渲染进程播放动画（从任务栏弹出/缩回，Steam 式）
  //
  // 注意 phase 的语义要与渲染端 useWindowAnim 对齐：
  //   - 缩回动画要在窗口真正最小化**之前**播（见 win-minimize IPC），
  //     那时窗口还可见，所以用 'minimizing'。
  //   - 'minimized' 是"已经最小化了"的通知，渲染端不该播动画（窗口看不见）。
  w.on('minimize', () => sendWinAnim('minimized'));
  w.on('restore', () => sendWinAnim('restoring'));
  // 从托盘/任务栏点回来时，有些路径只给 focus 不给 restore，这里兜一次。
  // 但要排除「点一下窗口就乱播动画」的干扰：只有窗口刚从最小化/隐藏状态
  // 回到可见时才播，否则每次聚焦都动画会显得很吵。
  w.on('focus', () => {
    if (w.isDestroyed() || w.isMinimized()) return;
    if (!w.isVisible()) return;
    sendWinAnim('focused');
  });

  // 关闭 ≠ 退出：收进任务栏小组件，dsh 服务与工作台继续在后台跑。
  // 真退出走托盘菜单「退出」或 Ctrl+Q（app.quit() 触发 before-quit 把 quitting 置 true）。
  w.on('close', (e) => {
    if (!settings.closeToTray || quitting) return; // 放行，正常关闭
    e.preventDefault();
    w.hide();
    // 首次收进托盘时给个提示，避免用户以为程序没了
    if (!global.__trayHintShown && settings.showTrayIcon && tray) {
      global.__trayHintShown = true;
      try {
        tray.displayBalloon({
          title: 'DSH Desktop 仍在后台运行',
          content: 'dsh 服务继续运行。双击任务栏图标可重新打开控制台。',
        });
      } catch {
        /* 部分系统不支持气泡提示，忽略 */
      }
    }
  });

  w.on('closed', () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (win === w) win = null;
  });
}

// ---------------------------------------------------------------------------
// 任务栏小组件（托盘）：关闭窗口不退出，收到这里
//
// 用户要求：点关闭 ≠ 退出，dsh 服务继续在后台跑；用任务栏那个小组件（输入法旁边）
// 双击/菜单把控制台叫回来。真的退出走托盘菜单的「退出」或 Ctrl+Q。
// ---------------------------------------------------------------------------
let tray = null;
let quitting = false; // 真退出时为 true，让 close 处理器放行

function showMainWindow() {
  if (win && !win.isDestroyed()) {
    const wasHidden = !win.isVisible();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // 从托盘/最小化状态回来时播「弹出」动画。
    // 任务栏被隐藏（skipTaskbar）时这是唯一的入口，动画必须在这里触发，
    // 否则用户会觉得「没动画了」。
    if (wasHidden) sendWinAnim('restoring');
  } else {
    createWindow();
  }
}

// ---------------------------------------------------------------------------
// 任务栏托盘菜单：与界面右下角「快捷控制」小组件同构
//
// 重排要点（2026-09）：
//   1. 分组与界面小组件一致（服务 / 工作台 / 窗口行为 / 退出），
//      用户在任一处看到的顺序一样，不用重新找。
//   2. 补上「刷新状态」与「重试连接」：
//      界面小组件里有，托盘里原本没有，两边动作集不一致。
//   3. 「退出」明确标注会停掉服务 —— 原标签只写「退出 DSH Desktop」，
//      而实际上会连带 kill 掉 dsh 服务与其子进程，用户容易误以为只是关窗口。
//
// ⚠ 界面侧的动作定义在 ui/src/versions/primer/actions.ts。
//    改这里的动作语义时，那边要同步改（反之亦然）。
// ---------------------------------------------------------------------------
function buildTrayMenu() {
  const running = Boolean(serverChild);
  return Menu.buildFromTemplate([
    // 第一项就是用户点开图标最想做的事：回到控制台
    { label: '进入控制台', click: () => showMainWindow() },

    { type: 'separator' },
    // —— 服务 ——
    { label: `DSH 服务：${running ? '运行中' : '未运行'}`, enabled: false },
    {
      label: '启动 DSH 服务',
      enabled: !running && !serverStarting,
      click: () => startDshServer(),
    },
    {
      label: '停止 DSH 服务',
      enabled: running,
      click: () => {
        if (serverChild) {
          killServerTree(serverChild.pid);
          serverChild = null;
        }
        serverStarting = false;
        clearStallTimer();
        notifyFallback('offline');
        refreshTrayMenu();
      },
    },
    {
      // 与界面 actions.ts 的 retry 对应：服务在跑但界面显示离线时用
      label: '重试连接',
      click: () => {
        retryConnection();
        refreshTrayMenu();
      },
    },

    { type: 'separator' },
    // —— 工作台 ——
    { label: '打开 DSH 工作台', click: () => openWorkbench() },
    {
      label: '关闭 DSH 工作台',
      enabled: Boolean(workbenchWin && !workbenchWin.isDestroyed()),
      click: () => closeWorkbench(),
    },

    { type: 'separator' },
    // —— 窗口行为 ——
    {
      label: '关闭窗口时最小化到后台',
      type: 'checkbox',
      checked: settings.closeToTray,
      click: (item) => {
        settings.closeToTray = item.checked;
        saveSettings();
      },
    },
    {
      label: '不在任务栏显示控制台按钮',
      type: 'checkbox',
      checked: settings.hideFromTaskbar,
      click: (item) => {
        settings.hideFromTaskbar = item.checked;
        saveSettings();
        applyTaskbarSetting();
        applyTraySettings();
        refreshTrayMenu();
      },
    },

    { type: 'separator' },
    {
      label: '退出 DSH Desktop（含停止后台服务）',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;
  try {
    const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
    let img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) return;
    // 托盘图标用 16x16，过大在任务栏会糊
    tray = new Tray(img.resize({ width: 16, height: 16 }));
    tray.setToolTip('DSH Desktop');
    tray.setContextMenu(buildTrayMenu());

    // 单击：弹出菜单（菜单里第一项是「进入控制台」），不要直接开窗口 ——
    // 用户点图标通常是想看有哪些选项，直接弹窗会显得突兀。
    // Windows 上托盘左键默认就会弹 contextMenu，这里显式 popUpContextMenu 保证一致。
    tray.on('click', () => {
      try {
        tray.popUpContextMenu(buildTrayMenu());
      } catch {
        /* 某些环境不支持，忽略：右键菜单仍然可用 */
      }
    });
    // 双击：直接进控制台（老习惯保留，且不冲突——单击弹菜单、双击开窗口）
    tray.on('double-click', () => showMainWindow());
  } catch (err) {
    console.error('createTray failed:', err);
    tray = null;
  }
}

function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

// 应用托盘设置：开关切换 / 启动时调用
function applyTraySettings() {
  // 安全兜底：hideFromTaskbar 开着但托盘图标被关掉时，窗口既不在任务栏、
  // 又没有托盘入口 —— 用户将完全找不回窗口。这里强制把托盘图标打开。
  if (settings.hideFromTaskbar && !settings.showTrayIcon) {
    settings.showTrayIcon = true;
    saveSettings();
  }
  if (settings.showTrayIcon) createTray();
  else destroyTray();
}

// 把「不进任务栏」开关实时应用到已存在的窗口（不用重启）
function applyTaskbarSetting() {
  if (win && !win.isDestroyed()) {
    try {
      win.setSkipTaskbar(Boolean(settings.hideFromTaskbar));
    } catch {
      /* ignore */
    }
  }
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
    workbenchUrl: currentWorkbenchUrl(),
    launchDisplay: resolveLaunchTarget().display,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    isPackaged: app.isPackaged,
    serverOnline: await checkServer(),
    workbenchOpen: Boolean(workbenchWin && !workbenchWin.isDestroyed()),
    // 是否已拿到本服务 token。false 且端口被占 = 工作台会一直转圈（401），
    // UI 据此提示用户「接管服务」
    hasToken: Boolean(serverTokenUrl),
    portBusy: isPortBusy(),
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
  // 托盘相关设置实时生效
  if (key === 'showTrayIcon') applyTraySettings();
  if (key === 'closeToTray') refreshTrayMenu();
  // 「不进任务栏」实时应用（applyTraySettings 里会做托盘兜底，所以放后面）
  if (key === 'hideFromTaskbar') {
    applyTaskbarSetting();
    applyTraySettings();
    refreshTrayMenu();
  }
  return true;
});

/** 重试连接：探测服务端口并同步状态。托盘菜单与 IPC 'retry' 共用这一份实现。 */
async function retryConnection() {
  if (await checkServer()) {
    markOnboardingDone();
    notifyFallback('online');
  } else {
    notifyFallback('offline');
    if (settings.autoStartServer) startDshServer();
  }
}

/** 关闭工作台窗口。托盘菜单与 IPC 'close-dsh' 共用这一份实现。 */
function closeWorkbench() {
  if (workbenchWin && !workbenchWin.isDestroyed()) {
    workbenchWin.close();
    workbenchWin = null;
  }
}

ipcMain.on('retry', async () => {
  await retryConnection();
});

ipcMain.on('start-server', () => {
  startDshServer();
});

// 接管端口上的旧 dsh 并重新拉起（用于「服务在线但工作台一直转圈」的场景）
ipcMain.handle('takeover-server', () => takeOverServer());

ipcMain.on('stop-server', () => {
  if (serverChild) {
    killServerTree(serverChild.pid);
    serverChild = null;
  }
  serverStarting = false;
  clearStallTimer();
  notifyFallback('offline');
});

ipcMain.handle('open-dsh', () => openWorkbench());

// 工作台自绘标题栏的窗口控制（由 workbench-preload 白名单转发）
ipcMain.on('workbench-window', (_event, action) => {
  if (!workbenchWin || workbenchWin.isDestroyed()) return;
  if (action === 'min') workbenchWin.minimize();
  else if (action === 'fs') workbenchWin.setFullScreen(!workbenchWin.isFullScreen());
  else if (action === 'close') workbenchWin.close();
});

ipcMain.on('close-dsh', () => {
  closeWorkbench();
});

// ---------------------------------------------------------------------------
// 控制台壳层：外框（frameless）与窗口控制
//
// 三个按钮 = 最小化 / 全屏 / 关闭（无最大化，全屏即最大化语义，用户指定）
// 最小化/还原时通过 IPC 通知渲染进程播放「从任务栏弹出/缩回」动画（Steam 式）
// ---------------------------------------------------------------------------
function sendWinAnim(phase) {
  if (win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
    win.webContents.send('win-anim', phase);
  }
}

ipcMain.on('win-minimize', () => {
  if (!win || win.isDestroyed()) return;
  // 先让渲染进程播缩回动画，再真正最小化
  sendWinAnim('minimizing');
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.minimize();
  }, 140);
});

// 全屏切换（取代原来的最大化）
ipcMain.on('win-fullscreen', () => {
  if (!win || win.isDestroyed()) return;
  const next = !win.isFullScreen();
  win.setFullScreen(next);
  sendWinAnim(next ? 'fullscreen-on' : 'fullscreen-off');
});
ipcMain.handle('win-is-fullscreen', () => Boolean(win && !win.isDestroyed() && win.isFullScreen()));

// 兼容旧调用：仍支持最大化
ipcMain.on('win-maximize', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win-close', () => {
  if (win && !win.isDestroyed()) win.close();
});
// 真退出：与托盘菜单的「退出 DSH Desktop」完全同一路径（quitting = true 让 close 处理器放行）。
// 界面右下角小组件里的「退出」走这里 —— 否则 closeToTray 开着时点退出只会收进后台，
// 用户会以为「退不掉」。
ipcMain.on('win-quit', () => {
  quitting = true;
  app.quit();
});
ipcMain.handle('win-is-maximized', () => Boolean(win && !win.isDestroyed() && win.isMaximized()));

// 任何外部网址 → 系统默认浏览器（不拦截回壳内；壳内 iframe/工作台也统一走这里）
ipcMain.on('open-external', (_event, url) => {
  if (typeof url !== 'string' || !url) return;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
  } catch {
    /* 非法 URL 忽略 */
  }
});

// 外框开关：真正的实时生效。
//
// 背景：`frame` 只能在 new BrowserWindow() 时决定，运行时改不了。
// 之前这里只改了菜单栏，因此是一个「假开关」——存了设置但什么都没发生，
// 用户点完毫无反应（甚至反被系统边框顶上）。
//
// 现在改为**重建窗口**：记住位置与尺寸 → 销毁旧窗口 → 用新的 frame 值建新窗口
// → 恢复位置尺寸。终端日志存在渲染进程的 lib/logStore 全局单例里（不在组件
// state），所以重建不会丢日志；只有滚动位置会回到顶部，这个代价可以接受。
let rebuildingWindow = false;

async function rebuildMainWindow() {
  if (rebuildingWindow) return;
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  rebuildingWindow = true;
  try {
    const bounds = win.getBounds();
    const wasMaximized = win.isMaximized();
    // 重建期间不要让 close 处理器把它收进托盘
    const prevQuitting = quitting;
    quitting = true;
    win.destroy(); // 用 destroy 跳过 close 拦截，避免被收进托盘
    win = null;
    quitting = prevQuitting;

    createWindow();
    // 等新窗口建好后再套用原位置尺寸
    await new Promise((r) => setTimeout(r, 120));
    if (win && !win.isDestroyed()) {
      try {
        if (wasMaximized) win.maximize();
        else win.setBounds(bounds);
      } catch {
        /* ignore */
      }
      win.show();
      win.focus();
      sendWinAnim('restoring');
    }
    applyTraySettings();
    applyTaskbarSetting();
  } finally {
    rebuildingWindow = false;
  }
}

ipcMain.on('set-frameless', (_event, enabled) => {
  const next = Boolean(enabled);
  if (settings.frameless === next) return;
  settings.frameless = next;
  saveSettings();
  // frame 是创建时属性：即时改菜单栏 + 重建窗口让边框真正变形
  if (win && !win.isDestroyed()) {
    win.setAutoHideMenuBar(next);
    win.setMenuBarVisibility(!next);
  }
  rebuildMainWindow();
});

// ---------------------------------------------------------------------------
// 文件浏览服务（只读目录树）
//
// 服务终端左侧「文件」栏的懒加载后端。根目录 = settings.fileBrowseRoot，
// 默认 $DSH_HOME（cordis/dsh 环境根：profiles/plugins/config/db/log）。
// 只读、路径沙箱（拒绝逃逸）。设计成可被未来 QQ 管理员机器人桥复用：
// 换消费者不换实现，renderer 只是其中一个消费端。
// ---------------------------------------------------------------------------
function resolveBrowseRoot() {
  return settings.fileBrowseRoot || (process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
}

// 把“相对根的路径”安全解析成磁盘路径；逃逸（../、绝对路径）返回 null
function safeResolveRelative(rel) {
  if (typeof rel !== 'string' || !rel) return resolveBrowseRoot();
  const root = resolveBrowseRoot();
  const joined = path.normalize(path.join(root, rel));
  const relFromRoot = path.relative(root, joined);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;
  return joined;
}

function listDir(rel) {
  const dir = safeResolveRelative(rel);
  if (!dir) return { ok: false, error: 'path outside browse root' };
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).map((de) => {
      const full = path.join(dir, de.name);
      const entry = { name: de.name, type: de.isDirectory() ? 'dir' : 'file', size: 0, mtime: 0 };
      try {
        const st = fs.statSync(full);
        entry.size = st.size;
        entry.mtime = st.mtimeMs;
      } catch {
        /* 符号链接断链等：忽略 stat 失败 */
      }
      return entry;
    });
  } catch (err) {
    return { ok: false, error: err.code || 'list failed' };
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { ok: true, path: dir, entries };
}

ipcMain.handle('fs-list', (_event, rel) => listDir(rel));
ipcMain.handle('fs-root', () => resolveBrowseRoot());
ipcMain.handle('fs-set-root', async () => {
  const r = await dialog.showOpenDialog({
    title: '选择文件浏览根目录',
    properties: ['openDirectory'],
  });
  if (!r.canceled && r.filePaths[0]) {
    settings.fileBrowseRoot = r.filePaths[0];
    saveSettings();
  }
  return resolveBrowseRoot();
});

// --- 远程手机访问（Tailscale）：
//   remote-info   → 本机 tailnet 域名/IP + 手机可访问地址
//   remote-expose → 经认证桥把服务广告到 tailnet；端口纪律：443/80 留给本机其它工具
//                   （如 Steam++ 的 HTTPS 拦截需要 443），Tailscale 固定用 8443 + TCP 3080
ipcMain.handle('remote-info', async () => {
  const t = getTailnetInfo();
  return {
    ...t,
    // 端口纪律：443 留给本机工具 → 远程 HTTPS 固定走 8443（面板上复制的就是可用地址）
    httpsUri: t.fqdn ? `https://${t.fqdn}:8443/` : '',
    httpUri: t.ipv4 ? `http://${t.ipv4}:3080/` : '',
  };
});

ipcMain.handle('remote-expose', async (_event, on) => {
  try {
    if (on) {
      // 走认证桥：手机/平板打开干净地址即用，无需 key。
      // start() 是异步的（等 listen 的真实结果）——桥起不来时必须退回直连 3080，
      // 否则 serve 会指向一个没人监听的端口，远端直接不可用。
      const br = await authBridge.start({ log: (m) => console.log('[dsh-authbridge]', m) });
      const port = br && br.ok && br.port ? br.port : 3080;
      if (!br || !br.ok) {
        console.log('[dsh-authbridge] 未就绪，远程暴露退回直连 3080：', br && br.reason);
      }
      // 端口纪律：443/80 必须留给本机其它工具（Steam++ 的 HTTPS 拦截按通配绑 443，
      // 被 tailscaled 占住某地址的 443 会让它整条拦截起不来）→ Tailscale 固定用 8443。
      // 先防御性清掉可能残留的 443 条目（没有该条目时命令会失败，直接忽略）。
      try {
        execFileSync('tailscale', ['serve', '--https=443', 'off'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
      } catch {
        /* 无 443 条目 → 忽略 */
      }
      execFileSync('tailscale', ['serve', '--bg', '--https=8443', `http://127.0.0.1:${port}`], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
      execFileSync('tailscale', ['serve', '--bg', '--tcp', '3080', `tcp://127.0.0.1:${port}`], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    } else {
      execFileSync('tailscale', ['serve', 'reset'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'tailscale 调用失败' };
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

    // 认证桥：只监听回环的反代（127.0.0.1:3090 → 127.0.0.1:3080）。
    // 对没有有效 cookie 的请求即时用持久密钥补一枚 cookie → 任何设备打开干净地址即可访问，
    // 不需要 key/token；网关（dsh）重启也不影响（桥只看固定端口 + 持久密钥）。
    // 关掉或崩溃都不影响本机工作台：工作台直连 3080。
    // 注意 start() 是异步的：这里不 await（不阻塞 App 启动），但要处理失败日志。
    authBridge
      .start({ log: (m) => console.log('[dsh-authbridge]', m) })
      .then((br) => {
        if (!br || !br.ok) {
          console.log('[dsh-authbridge] 启动失败（不影响本机使用）：', br && br.reason);
        }
      })
      .catch((err) => {
        console.log('[dsh-authbridge] 启动异常：', (err && err.message) || err);
      });

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
            {
              label: '重新加载控制台',
              accelerator: 'CmdOrCtrl+R',
              click: () => {
                if (win && !win.isDestroyed()) win.webContents.reload();
              },
            },
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
    applyTraySettings();

    // 静默自动更新：后台检查+下载，下次重启生效（不打断用户）
    initAutoUpdate();
    onUpdateState((s) => {
      if (win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame()) {
        win.webContents.send('update-state', s);
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 真退出：置 quitting，让窗口 close 处理器不再拦截
  app.on('before-quit', () => {
    quitting = true;
  });

  // 收进托盘后所有窗口都 hidden/closed，此时**不能**退出——否则「关闭不退出」失效。
  // 只有关掉托盘图标（showTrayIcon=false）时才按原来的行为退出。
  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    if (settings.closeToTray && settings.showTrayIcon) return; // 留在后台
    app.quit();
  });

  // 退出前清理托盘图标，避免任务栏残留死图标
  app.on('will-quit', () => {
    destroyTray();
    try {
      authBridge.stop();
    } catch {
      /* ignore */
    }
  });
}
