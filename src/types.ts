export type FsChangeType = 'appeared' | 'disappeared' | 'modified' | 'errored' | 'unknown';

export interface FsChangeEvent {
  watchId: string;
  type: FsChangeType;
  name: string | null;
}

export interface ResolvedEntryStyle {
  color?: string;
  opacity?: number;
  icon: string | null;
  sortPriority: number;
  groupFirst: boolean;
}

export interface FsaRawEntry {
  name: string;
  kind: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  mode: number;
  isSymbolicLink: boolean;
}

export interface ElectronBridge {
  fsa: {
    entries(dirPath: string): Promise<FsaRawEntry[]>;
    readFile(filePath: string): Promise<string>;
    stat(filePath: string): Promise<{ size: number; mtimeMs: number }>;
    exists(filePath: string): Promise<boolean>;
    open(filePath: string): Promise<string>;
    read(fd: string, offset: number, length: number): Promise<ArrayBuffer>;
    close(fd: string): Promise<void>;
    watch(watchId: string, path: string): Promise<{ ok: boolean }>;
    unwatch(watchId: string): Promise<void>;
    onFsChange(callback: (event: FsChangeEvent) => void): () => void;
  };
  utils: {
    getAppPath(): Promise<string>;
    getHomePath(): Promise<string>;
  };
  theme: {
    get(): Promise<string>;
    onChange(callback: (theme: string) => void): () => void;
  };
}

// IPC protocol types for privileged FS service

export interface FsIpcAuth     { auth: string }

declare global {
  interface Window {
    electron: ElectronBridge;
  }
}
