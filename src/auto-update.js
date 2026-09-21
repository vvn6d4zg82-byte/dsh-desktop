'use strict';

/**
 * 静默自动更新（GitHub Releases 源）。
 *
 * 策略（用户指定）：后台静默下载，不打断使用；重启应用时自动生效。
 *   - 启动后延迟一段时间再检查（避开启动关键路径，别和 dsh 拉起抢带宽）
 *   - 发现新版 → 后台静默下载，全程无弹窗、无进度条
 *   - 下载完成 → 只记状态，等用户下次正常退出/重启时由 NSIS 装入新版
 *   - 永不自动重启应用（那会打断用户正在跑的任务）
 *
 * 只在打包版生效：开发模式没有 app-update.yml，检查必然失败且刷屏报错。
 * 全部网络失败都吞掉——更新失败绝不能让主功能受影响。
 */

const { app, ipcMain, dialog } = require('electron');

/** 当前状态，供渲染进程读取（小齿轮面板显示） */
const state = {
  status: 'idle', // idle | checking | available | downloading | downloaded | none | error | dev
  version: '', // 可用/已下载的新版本号
  currentVersion: '',
  percent: 0, // 下载进度 0-100
  updatedAt: 0,
  error: '',
};

let listeners = [];
let autoUpdaterRef = null;
let initialized = false;

function emit(patch) {
  Object.assign(state, patch, { updatedAt: Date.now() });
  for (const fn of listeners) {
    try {
      fn(getState());
    } catch {
      /* 渲染进程可能已销毁，忽略 */
    }
  }
}

function getState() {
  return { ...state };
}

// 错误兜底：Promise 形式的调用失败也要吞掉。
// 用函数声明（而非 const）以便在 initAutoUpdate 内部注册 IPC 时已可见。
function safeCheck() {
  if (!autoUpdaterRef) return;
  try {
    const r = autoUpdaterRef.checkForUpdates();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (err) {
    emit({ status: 'error', error: String((err && err.message) || err).slice(0, 300) });
  }
}

/**
 * @param {object} opts
 * @param {(channel:string,payload:any)=>void} opts.send 主进程→渲染进程的推送函数
 * @param {()=>boolean} opts.shouldQuiet 返回 true 时表示用户正在忙，暂缓提示（当前未用到弹窗，保留钩子）
 */
function initAutoUpdate(opts = {}) {
  if (initialized) return;
  initialized = true;

  state.currentVersion = app.getVersion();

  // IPC 必须**无条件**注册：否则开发模式/依赖缺失时齿轮面板点「检查更新」会抛
  // "No handler registered"。先把通道建好，再看能不能真正更新。
  ipcMain.handle('update:get-state', () => getState());
  ipcMain.handle('update:check', async () => {
    if (!autoUpdaterRef) return getState(); // dev / 未装：直接返回当前状态
    safeCheck();
    return getState();
  });
  // 用户显式点「立即重启更新」时才重启（默认路径不打扰用户）
  ipcMain.handle('update:install-now', () => {
    if (state.status !== 'downloaded' || !autoUpdaterRef) return false;
    try {
      autoUpdaterRef.quitAndInstall(false, true);
      return true;
    } catch {
      return false;
    }
  });

  // 开发模式：没有 app-update.yml，直接标记不可用，不尝试联网
  if (!app.isPackaged) {
    emit({ status: 'dev' });
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    emit({ status: 'error', error: 'electron-updater 未安装' });
    console.error('[update] require electron-updater failed:', err);
    return;
  }
  autoUpdaterRef = autoUpdater;

  // 全静默：不自动弹任何内置对话框，下载也不问用户
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // 关键：退出时装，即「重启时生效」
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => emit({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => {
    emit({ status: 'available', version: (info && info.version) || '', percent: 0 });
  });
  autoUpdater.on('update-not-available', () => emit({ status: 'none', version: '' }));
  autoUpdater.on('download-progress', (p) => {
    emit({ status: 'downloading', percent: Math.round((p && p.percent) || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    emit({ status: 'downloaded', version: (info && info.version) || '', percent: 100 });
  });
  autoUpdater.on('error', (err) => {
    // 网络/证书/GitHub 限流都会走这里：只记录，不影响主功能
    const msg = String((err && err.message) || err || '');
    emit({ status: 'error', error: msg.slice(0, 300) });
    console.error('[update] error:', msg);
  });

  // 错误兜底在 safeCheck() 里（函数声明，已提升）

  // 启动后 40s 首次检查：让 dsh 服务先起来，别抢带宽/CPU
  const first = setTimeout(safeCheck, 40 * 1000);
  // 之后每 6 小时一轮
  const every = setInterval(safeCheck, 6 * 60 * 60 * 1000);

  const cleanup = () => {
    clearTimeout(first);
    clearInterval(every);
  };
  app.on('will-quit', cleanup);
}

function onUpdateState(cb) {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((f) => f !== cb);
  };
}

module.exports = { initAutoUpdate, getUpdateState: getState, onUpdateState };
