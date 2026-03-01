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
    readSlice(filePath: string, offset: number, length: number): Promise<ArrayBuffer>;
  };
  utils: {
    getAppPath(): Promise<string>;
    getHomePath(): Promise<string>;
  };
}

declare global {
  interface Window {
    electron: ElectronBridge;
  }
}
