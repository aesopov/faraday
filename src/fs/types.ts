export type EntryKind = 'file' | 'directory' | 'symlink' | 'block_device' | 'char_device' | 'named_pipe' | 'socket' | 'whiteout' | 'unknown';

export interface FsaRawEntry {
  name: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  mode: number;
  nlink: number;
  hidden: boolean;
  /** Populated only when kind === 'symlink'. */
  linkTarget?: string;
}

export type RawFs = {
  entries(dirPath: string): Promise<FsaRawEntry[]>;
  stat(filePath: string): Promise<{ size: number; mtimeMs: number }>;
  exists(filePath: string): Promise<boolean>;
  open(filePath: string): Promise<number>;
  read(fd: number, offset: number, length: number): Promise<Buffer>;
  close(fd: number): Promise<void>;
  watch(watchId: string, dirPath: string): Promise<{ ok: boolean }>;
  unwatch(watchId: string): Promise<void>;
};
