export interface DshSettings {
  settingsVersion: number;
  serverCommand: string;
  autoStartServer: boolean;
  openAtLogin: boolean;
  systemCerts: boolean;
  onboardingDone: boolean;
  hideTerminal: boolean;
  fileBrowseRoot: string;
  frameless: boolean;
  closeToTray: boolean;
  showTrayIcon: boolean;
  /**
   * 不在任务栏显示控制台按钮（像 CC Switch 那样只从托盘图标进入）。
   *
   * 此前这个键只在主进程与托盘菜单里存在，UI 侧完全没有暴露 ——
   * 结果是「打开后没法从界面关掉」，只能去托盘菜单里改。
   * 现在由管理后台「窗口与后台」分区接管。
   */
  hideFromTaskbar: boolean;
}

export interface DshState {
  settings: DshSettings;
  bundledVersions: { dshVersion?: string } | null;
  serverUrl: string;
  workbenchUrl: string;
  launchDisplay: string;
  versions: { electron: string; chrome: string; node: string };
  isPackaged: boolean;
  serverOnline: boolean;
  workbenchOpen: boolean;
  /** 是否已捕获到本机服务 token（false 且端口被占 = 工作台会 401） */
  hasToken: boolean;
  /** 目标端口是否被占用（未取得 token 的孤儿服务） */
  portBusy: boolean;
}

export interface FsEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
}

export interface FsListResult {
  ok: boolean;
  path?: string;
  entries?: FsEntry[];
  error?: string;
}

/** 服务地址实时状态（token 变化时由主进程推送） */
export interface ServerTokenInfo {
  tokenUrl: string;
  workbenchUrl: string;
  hasToken: boolean;
}

export interface RemoteInfo {
  fqdn: string;
  ipv4: string;
  httpsUri: string;
  httpUri: string;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error' | 'dev';
  version: string;
  currentVersion: string;
  percent: number;
  updatedAt: number;
  error: string;
}

export interface DshDesktopApi {
  bootstrap: {
    serverUrl: string;
    serverCommand: string;
    serverStarting: boolean;
  };
  getState(): Promise<DshState>;
  setSetting(key: string, value: unknown): Promise<void>;
  retry(): void;
  startServer(): void;
  stopServer(): void;
  openDsh(): Promise<boolean>;
  closeDsh(): void;
  fsList(rel: string): Promise<FsListResult>;
  fsRoot(): Promise<string>;
  fsSetRoot(): Promise<string>;
  remoteInfo(): Promise<RemoteInfo>;
  remoteExpose(on: boolean): Promise<{ ok: boolean; error?: string }>;
  setFrameless(enabled: boolean): void;
  winMinimize(): void;
  winMaximize(): void;
  winFullscreen(): void;
  winClose(): void;
  /** 真退出应用（与托盘「退出」同一行为）；点关闭走 winClose 只会收进后台 */
  winQuit(): void;
  winIsMaximized(): Promise<boolean>;
  winIsFullscreen(): Promise<boolean>;
  /** 窗口最小化/还原/全屏变化时通知渲染进程播放动画 */
  onWinAnim(cb: (phase: string) => void): void;
  /** 外部链接交给系统默认浏览器打开（不拦截回窗口内） */
  openExternal(url: string): void;
  onServerStatus(cb: (status: string) => void): void;
  onServerLog(cb: (line: string) => void): void;
  /** 服务地址（含 token）变化时推送，控制台据此实时刷新远程地址 */
  onServerToken(cb: (info: ServerTokenInfo) => void): void;
  /** 静默自动更新 */
  updateState(): Promise<UpdateState>;
  updateCheck(): Promise<UpdateState>;
  updateInstallNow(): Promise<boolean>;
  onUpdateState(cb: (s: UpdateState) => void): void;
}

declare global {
  interface Window {
    dshDesktop: DshDesktopApi;
  }
}