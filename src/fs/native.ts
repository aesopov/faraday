import path from 'node:path';
import { app } from 'electron';
import type { FsChangeEvent, FsChangeType } from '../types';
import type { EntryKind, FsaRawEntry, RawFs } from './types';

// ── Load the Rust N-API addon ───────────────────────────────────────

interface RustNapi {
  entries(dirPath: string): Array<{
    name: string;
    kind: string;
    size: number;
    mtimeMs: number;
    mode: number;
    nlink: number;
    hidden: boolean;
    linkTarget: string | null;
  }>;
  stat(filePath: string): { size: number; mtimeMs: number };
  exists(filePath: string): boolean;
  open(filePath: string): number;
  read(fd: number, offset: number, length: number): Buffer;
  close(fd: number): void;
  setWatchCallback(cb: (watchId: string, kind: string, name: string | null) => void): void;
  clearWatchCallback(): void;
  watch(watchId: string, dirPath: string): boolean;
  unwatch(watchId: string): void;
}

function loadNativeAddon(): RustNapi {
  if (app.isPackaged) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(process.resourcesPath, 'faraday_napi.node'));
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../native/faraday_napi.node');
}

const native = loadNativeAddon();

// ── Error handling ──────────────────────────────────────────────────

// Rust napi errors already have descriptive messages with POSIX codes.
// Extract the errno code from the message suffix "(ENOENT)" etc.
const ERRNO_RE = /\(([A-Z]+)\)$/;

function toNodeError(err: unknown): never {
  if (err instanceof Error && !('code' in err)) {
    const m = ERRNO_RE.exec(err.message);
    if (m) (err as NodeJS.ErrnoException).code = m[1];
  }
  throw err;
}

// ── Watch callback (push-based) ─────────────────────────────────────

let watchCallbackFn: ((event: FsChangeEvent) => void) | null = null;

export function initWatchCallback(cb: (event: FsChangeEvent) => void): void {
  watchCallbackFn = cb;
  native.setWatchCallback((watchId: string, kind: string, name: string | null) => {
    try {
      if (!watchCallbackFn) return;
      watchCallbackFn({
        watchId,
        type: kind as FsChangeType,
        name: name ?? null,
      });
    } catch (err) {
      console.error('[watch] callback error:', err);
    }
  });
}

export function clearWatchCallback(): void {
  watchCallbackFn = null;
  native.clearWatchCallback();
}

// ── NativeFs — unified RawFs using the Rust N-API addon ─────────────

export class NativeFs implements RawFs {
  async entries(dirPath: string): Promise<FsaRawEntry[]> {
    try {
      const raw = native.entries(dirPath);
      return raw.map((e) => ({
        name: e.name,
        kind: e.kind as EntryKind,
        size: e.size,
        mtimeMs: e.mtimeMs,
        mode: e.mode,
        nlink: e.nlink,
        hidden: e.hidden,
        linkTarget: e.linkTarget ?? undefined,
      }));
    } catch (err) {
      toNodeError(err);
    }
  }

  async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    try {
      return native.stat(filePath);
    } catch (err) {
      toNodeError(err);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    return native.exists(filePath);
  }

  async open(filePath: string): Promise<number> {
    try {
      return native.open(filePath);
    } catch (err) {
      toNodeError(err);
    }
  }

  async read(fd: number, offset: number, length: number): Promise<Buffer> {
    try {
      return native.read(fd, offset, length);
    } catch (err) {
      toNodeError(err);
    }
  }

  async close(fd: number): Promise<void> {
    native.close(fd);
  }

  async watch(watchId: string, dirPath: string): Promise<{ ok: boolean }> {
    try {
      return { ok: native.watch(watchId, dirPath) };
    } catch (err) {
      toNodeError(err);
    }
  }

  async unwatch(watchId: string): Promise<void> {
    native.unwatch(watchId);
  }
}
