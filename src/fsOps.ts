import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FsChangeEvent, FsChangeType } from './types';
import { FsaRawEntry, RawFs } from './fs/types';

type NodeFileHandle = Awaited<ReturnType<typeof fs.open>>;

export class FsOps implements RawFs {
  private fds = new Map<string, NodeFileHandle>();
  private watchers = new Map<string, FSWatcher>();
  private nextFdId = 0;

  constructor(private onWatchEvent?: (event: FsChangeEvent) => void) {}

  async entries(dirPath: string): Promise<FsaRawEntry[]> {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    return Promise.all(
      dirents.map(async (d) => {
        const fullPath = path.join(dirPath, d.name);
        let size = 0;
        let mtimeMs = 0;
        let mode = 0;
        try {
          const s = await fs.stat(fullPath);
          size = s.size;
          mtimeMs = s.mtimeMs;
          mode = s.mode;
        } catch {
          // Skip stat errors (e.g. permission denied)
        }
        const isSymbolicLink = d.isSymbolicLink();
        return { name: d.name, kind: d.isDirectory() ? 'directory' : 'file', size, mtimeMs, mode, isSymbolicLink } as FsaRawEntry;
      }),
    );
  }

  async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    const s = await fs.stat(filePath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async open(filePath: string): Promise<string> {
    const fd = await fs.open(filePath, 'r');
    const fdId = `fd-${this.nextFdId++}`;
    this.fds.set(fdId, fd);
    return fdId;
  }

  async read(fdId: string, offset: number, length: number): Promise<Buffer> {
    const fd = this.fds.get(fdId);
    if (!fd) throw new Error('Invalid file descriptor');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  }

  async close(fdId: string): Promise<void> {
    const fd = this.fds.get(fdId);
    if (fd) {
      this.fds.delete(fdId);
      await fd.close();
    }
  }

  async watch(watchId: string, dirPath: string): Promise<{ ok: boolean }> {
    try {
      await fs.access(dirPath);
    } catch {
      return { ok: false };
    }

    // Close existing watcher with same ID
    this.watchers.get(watchId)?.close();

    const watcher = watch(dirPath, async (eventType, filename) => {
      let type: FsChangeType;
      if (eventType === 'rename') {
        try {
          await fs.access(path.join(dirPath, filename ?? ''));
          type = 'appeared';
        } catch {
          type = 'disappeared';
        }
      } else if (eventType === 'change') {
        type = 'modified';
      } else {
        type = 'unknown';
      }
      this.onWatchEvent?.({ watchId, type, name: filename ?? null });
    });

    watcher.on('error', () => {
      this.onWatchEvent?.({ watchId, type: 'errored', name: null });
      watcher.close();
      this.watchers.delete(watchId);
    });

    this.watchers.set(watchId, watcher);
    return { ok: true };
  }

  async unwatch(watchId: string): Promise<void> {
    const watcher = this.watchers.get(watchId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(watchId);
    }
  }

  closeAll(): void {
    for (const fd of this.fds.values()) fd.close().catch(() => {});
    this.fds.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  async dispatch(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'entries':
        return this.entries(args[0] as string);
      case 'stat':
        return this.stat(args[0] as string);
      case 'exists':
        return this.exists(args[0] as string);
      case 'open':
        return this.open(args[0] as string);
      case 'read':
        return this.read(args[0] as string, args[1] as number, args[2] as number);
      case 'close':
        return this.close(args[0] as string);
      case 'watch':
        return this.watch(args[0] as string, args[1] as string);
      case 'unwatch':
        return this.unwatch(args[0] as string);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}
