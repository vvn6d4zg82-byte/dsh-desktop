export interface DshSettings {
  settingsVersion: number;
  serverCommand: string;
  autoStartServer: boolean;
  openAtLogin: boolean;
  systemCerts: boolean;
  onboardingDone: boolean;
  hideTerminal: boolean;
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
  serverInput(line: string): void;
  openDsh(): Promise<boolean>;
  closeDsh(): void;
  onServerStatus(cb: (status: string) => void): void;
  onServerLog(cb: (line: string) => void): void;
}

declare global {
  interface Window {
    dshDesktop: DshDesktopApi;
  }
}
