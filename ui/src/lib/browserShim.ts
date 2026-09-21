import type { DshDesktopApi } from '@/types';

/**
 * 浏览器预览 shim（设计对比用）
 *
 * 只在 window.dshDesktop 缺失时（纯浏览器打开、无 Electron preload）注入假数据，
 * 让两套设计系统能在任意浏览器里直接对比渲染效果；Electron 运行不受任何影响。
 */
export function ensureBrowserShim(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as { dshDesktop?: unknown }).dshDesktop) return false;

  const settings = {
    settingsVersion: 2,
    serverCommand: 'npx --yes @deepseek-ai/dsh web',
    autoStartServer: true,
    openAtLogin: true,
    systemCerts: true,
    onboardingDone: true,
    hideTerminal: true,
    fileBrowseRoot: '',
    frameless: true,
    closeToTray: true,
    showTrayIcon: false,
    hideFromTaskbar: false,
  };

  let logSeq = 0;
  const pushLog = (line: string) => {
    logSeq += 1;
    setTimeout(() => {
      (window as unknown as { __dshMockLog?: (s: string) => void }).__dshMockLog?.(line);
    }, 50 * logSeq);
  };

  const api: DshDesktopApi = {
    bootstrap: { serverUrl: 'http://127.0.0.1:3080', serverCommand: settings.serverCommand, serverStarting: false },
    getState: () =>
      Promise.resolve({
        settings,
        bundledVersions: { dshVersion: '0.1.2-rc.1' },
        serverUrl: 'http://127.0.0.1:3080',
        workbenchUrl: 'http://127.0.0.1:3080/?token=mock',
        launchDisplay: '"node" --expose-internals "dsh" web',
        versions: { electron: '43.4.0', chrome: '142', node: '24' },
        isPackaged: false,
        serverOnline: true,
        workbenchOpen: false,
        hasToken: true,
        portBusy: false,
      }),
    setSetting: (key, value) => {
      (settings as unknown as Record<string, unknown>)[key] = value;
      return Promise.resolve();
    },
    setFrameless: () => {},
    retry: () => {},
    startServer: () => pushLog('[dsh] mock: 启动服务…'),
    stopServer: () => pushLog('[dsh] mock: 停止服务。'),
    openDsh: () => Promise.resolve(true),
    closeDsh: () => {},
    fsList: (rel) =>
      Promise.resolve({
        ok: true,
        path: rel ? `C:\\Users\\zhou\\.dsh\\${rel}` : 'C:\\Users\\zhou\\.dsh',
        entries: [
          { name: 'profiles', type: 'dir', size: 0, mtime: 0 },
          { name: 'plugins', type: 'dir', size: 0, mtime: 0 },
          { name: 'db', type: 'dir', size: 0, mtime: 0 },
          { name: 'log', type: 'dir', size: 0, mtime: 0 },
          { name: 'settings.json', type: 'file', size: 1842, mtime: 0 },
          { name: 'sessions', type: 'dir', size: 0, mtime: 0 },
          rel ? { name: 'session.jsonl.zstd', type: 'file', size: 420_224, mtime: 0 } : { name: 'LICENSE', type: 'file', size: 1081, mtime: 0 },
        ],
      }),
    fsRoot: () => Promise.resolve('C:\\Users\\zhou\\.dsh'),
    fsSetRoot: () => Promise.resolve('C:\\Users\\zhou\\.dsh'),
    remoteInfo: () =>
      Promise.resolve({
        fqdn: 'laptop-j1dj8285.tail26884c.ts.net',
        ipv4: '100.66.8.87',
        httpsUri: 'https://laptop-j1dj8285.tail26884c.ts.net/',
        httpUri: 'http://100.66.8.87:3080/',
      }),
    remoteExpose: () => Promise.resolve({ ok: true }),
    winMinimize: () => {},
    winMaximize: () => {},
    winClose: () => {},
    winQuit: () => pushLog('[dsh] mock: 退出应用（浏览器预览下无效）。'),
    winIsMaximized: () => Promise.resolve(false),
    winFullscreen: () => {},
    winIsFullscreen: () => Promise.resolve(false),
    onWinAnim: () => {},
    updateState: () =>
      Promise.resolve({ status: 'none', version: '', currentVersion: '0.2.4', percent: 0, updatedAt: 0, error: '' }),
    updateCheck: () =>
      Promise.resolve({ status: 'none', version: '', currentVersion: '0.2.4', percent: 0, updatedAt: 0, error: '' }),
    updateInstallNow: () => Promise.resolve(false),
    onUpdateState: () => {},
    openExternal: (url) => {
      window.open(url, '_blank', 'noopener');
    },
    onServerStatus: (cb) => {
      setTimeout(() => cb('online'), 300);
    },
    onServerLog: (cb) => {
      (window as unknown as { __dshMockLog?: (s: string) => void }).__dshMockLog = cb;
      pushLog('[dsh] DeepSeek Harness desktop gateway listening on http://127.0.0.1:3080');
      pushLog('[dsh] launch token ready — workbench URL captured');
      pushLog('[dsh] HMR receiver active, watching workspace…');
      pushLog('[info] 服务健康检查通过 (200)');
      pushLog('[warn] 注意：当前为浏览器预览模式（mock 数据），实际请用 Electron 启动');
    },
    onServerToken: (cb) => {
      setTimeout(() => {
        cb({
          tokenUrl: 'http://127.0.0.1:3080/?token=mock',
          workbenchUrl: 'http://127.0.0.1:3080/?token=mock',
          hasToken: true,
        });
      }, 400);
    },
  };

  (window as unknown as { dshDesktop: DshDesktopApi }).dshDesktop = api;
  return true;
}