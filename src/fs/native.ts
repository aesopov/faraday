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
  setWatchCallback(cb: (watchId: string, type: string, name: string | null) => void): void;
  watch(watchId: string, dirPath: string): { ok: boolean };
  unwatch(watchId: string): void;
}

function loadAddon(): NativeAddon {
  const addonPath = app.isPackaged
    ? path.join(
        process.resourcesPath,
        process.platform === 'darwin'
          ? 'libfaraday_napi.dylib'
          : 'faraday_napi.node',
      )
    : path.join(app.getAppPath(), 'native-zig', 'zig-out', 'lib', 'faraday_napi.node');

  const m = { exports: {} as NativeAddon };
  process.dlopen(m, addonPath);
  return m.exports;
}

const addon = loadAddon();

// ── Global watch callback (broadcast to all windows) ─────────────────

/** Register the global watch event callback. Call once during init. */
export function initWatchCallback(cb: (event: FsChangeEvent) => void): void {
  addon.setWatchCallback((watchId: string, type: string, name: string | null) => {
    cb({ watchId, type: type as FsChangeType, name });
  });
}

// ── NativeFs — unified RawFs using the Zig N-API addon ───────────────

export class NativeFs implements RawFs {
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
    return addon.watch(watchId, dirPath);
  }

  async unwatch(watchId: string): Promise<void> {
    addon.unwatch(watchId);
  }
}
