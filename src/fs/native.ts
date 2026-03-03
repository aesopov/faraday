import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { FsChangeEvent, FsChangeType } from '../types';
import type { FsaRawEntry, RawFs } from './types';

// ── Load the Zig N-API addon ─────────────────────────────────────────

interface NativeAddon {
  entries(dirPath: string): FsaRawEntry[];
  stat(filePath: string): { size: number; mtimeMs: number };
  exists(filePath: string): boolean;
  open(filePath: string): string;
  read(fdId: string, offset: number, length: number): Buffer;
  close(fdId: string): void;
}

function loadAddon(): NativeAddon {
  const addonPath = app.isPackaged
    ? path.join(
        process.resourcesPath,
        process.platform === 'darwin'
          ? 'libfaraday_napi.dylib'
          : process.platform === 'win32'
            ? 'faraday_napi.dll'
            : 'libfaraday_napi.so',
      )
    : path.join(app.getAppPath(), 'native-zig', 'zig-out', 'lib', 'faraday_napi.node');

  const m = { exports: {} as NativeAddon };
  process.dlopen(m, addonPath);
  return m.exports;
}

const addon = loadAddon();

// ── NativeFs — unified RawFs using the Zig N-API addon ───────────────

export class NativeFs implements RawFs {
  private watchers = new Map<string, FSWatcher>();

  constructor(private onWatchEvent?: (event: FsChangeEvent) => void) {}

  async entries(dirPath: string): Promise<FsaRawEntry[]> {
    return addon.entries(dirPath);
  }

  async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    return addon.stat(filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    return addon.exists(filePath);
  }

  async open(filePath: string): Promise<string> {
    return addon.open(filePath);
  }

  async read(fdId: string, offset: number, length: number): Promise<Buffer> {
    return addon.read(fdId, offset, length);
  }

  async close(fdId: string): Promise<void> {
    addon.close(fdId);
  }

  async watch(watchId: string, dirPath: string): Promise<{ ok: boolean }> {
    try {
      await fs.access(dirPath);
    } catch {
      return { ok: false };
    }

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
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
