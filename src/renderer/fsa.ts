import type { FsaRawEntry } from '../types';
import { join } from './path';

export interface HandleMeta {
  size: number;
  mtimeMs: number;
  mode: number;
  isSymbolicLink: boolean;
}

const readonlyError = () => {
  throw new Error('Filesystem is read-only');
};

export class DirectoryHandle implements FileSystemDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly path: string;
  readonly meta?: HandleMeta;

  constructor(path: string, name?: string, meta?: HandleMeta) {
    this.path = path;
    this.name = name ?? path.split('/').pop() ?? path;
    this.meta = meta;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other instanceof DirectoryHandle && other.path === this.path;
  }

  async *entries(): FileSystemDirectoryHandleAsyncIterator<[string, FileSystemHandle]> {
    const raw: FsaRawEntry[] = await window.electron.fsa.entries(this.path);
    for (const entry of raw) {
      const childPath = join(this.path, entry.name);
      const meta = { size: entry.size, mtimeMs: entry.mtimeMs, mode: entry.mode, isSymbolicLink: entry.isSymbolicLink };
      if (entry.kind === 'directory') {
        yield [entry.name, new DirectoryHandle(childPath, entry.name, meta)] as const;
      } else {
        yield [entry.name, new FileHandle(childPath, entry.name, meta)] as const;
      }
    }
  }

  async *keys(): FileSystemDirectoryHandleAsyncIterator<string> {
    for await (const [name] of this.entries()) {
      yield name;
    }
  }

  async *values(): FileSystemDirectoryHandleAsyncIterator<FileSystemHandle> {
    for await (const [, handle] of this.entries()) {
      yield handle;
    }
  }

  [Symbol.asyncIterator](): FileSystemDirectoryHandleAsyncIterator<[string, FileSystemHandle]> {
    return this.entries();
  }

  async getDirectoryHandle(name: string): Promise<DirectoryHandle> {
    return new DirectoryHandle(join(this.path, name), name);
  }

  async getFileHandle(name: string): Promise<FileHandle> {
    return new FileHandle(join(this.path, name), name);
  }

  async removeEntry(): Promise<never> {
    return readonlyError();
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    if (!(possibleDescendant instanceof DirectoryHandle || possibleDescendant instanceof FileHandle)) {
      return null;
    }
    const descendantPath = possibleDescendant.path;
    if (!descendantPath.startsWith(this.path)) return null;
    const relative = descendantPath.slice(this.path.length).replace(/^\//, '');
    if (!relative) return [];
    return relative.split('/');
  }
}

export class FileHandle implements FileSystemFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  readonly path: string;
  readonly meta?: HandleMeta;

  constructor(path: string, name: string, meta?: HandleMeta) {
    this.path = path;
    this.name = name;
    this.meta = meta;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other instanceof FileHandle && other.path === this.path;
  }

  async getFile(): Promise<File> {
    const text = await window.electron.fsa.readFile(this.path);
    return new File([text], this.name, { lastModified: this.meta?.mtimeMs });
  }

  async createWritable(): Promise<never> {
    return readonlyError();
  }
}
