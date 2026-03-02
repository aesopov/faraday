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

type Result<T> = { result: T } | { error: any };

export interface ElectronBridge {
  fsa: {
    entries(dirPath: string): Promise<Result<FsaRawEntry[]>>;
    readFile(filePath: string): Promise<Result<string>>;
    stat(filePath: string): Promise<Result<{ size: number; mtimeMs: number }>>;
    exists(filePath: string): Promise<Result<boolean>>;
    open(filePath: string): Promise<Result<string>>;
    read(fd: string, offset: number, length: number): Promise<Result<ArrayBuffer>>;
    close(fd: string): Promise<Result<void>>;
    watch(watchId: string, path: string): Promise<Result<{ ok: boolean }>>;
    unwatch(watchId: string): Promise<Result<void>>;
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

export interface FsIpcAuth {
  auth: string;
}

declare global {
  interface Window {
    electron: ElectronBridge;
  }
}
