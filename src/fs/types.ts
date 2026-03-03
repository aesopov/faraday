export interface FsaRawEntry {
  name: string;
  kind: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  mode: number;
  isSymbolicLink: boolean;
}

export type RawFs = {
  entries(dirPath: string): Promise<FsaRawEntry[]>;
  stat(filePath: string): Promise<{ size: number; mtimeMs: number }>;
  exists(filePath: string): Promise<boolean>;
  open(filePath: string): Promise<string>;
  read(fdId: string, offset: number, length: number): Promise<Buffer>;
  close(fdId: string): Promise<void>;
  watch(watchId: string, dirPath: string): Promise<{ ok: boolean }>;
  unwatch(watchId: string): Promise<void>;
};
