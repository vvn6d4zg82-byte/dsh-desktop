export interface DshSettings {
  settingsVersion: number;
  serverCommand: string;
  autoStartServer: boolean;
  openAtLogin: boolean;
  systemCerts: boolean;
  onboardingDone: boolean;
  hideTerminal: boolean;
  fileBrowseRoot: string;
}

export interface DshState {
  settings: DshSettings;
  bundledVersions: { dshVersion?: string } | null;
  serverUrl: string;
  launchDisplay: string;
  versions: { electron: string; chrome: string; node: string };
  isPackaged: boolean;
  serverOnline: boolean;
  workbenchOpen: boolean;
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

export interface RemoteInfo {
  fqdn: string;
  ipv4: string;
  httpsUri: string;
  httpUri: string;
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
  onServerStatus(cb: (status: string) => void): void;
  onServerLog(cb: (line: string) => void): void;
}

declare global {
  interface Window {
    dshDesktop: DshDesktopApi;
  }
}
