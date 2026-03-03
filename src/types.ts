import { RawFs } from './fs/types';

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

type Result<T> = { result: T } | { error: any };

type WithErrorHandling<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => Promise<Result<R>> : T[K];
};

export interface ElectronBridge {
  fsa: WithErrorHandling<RawFs> & {
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
