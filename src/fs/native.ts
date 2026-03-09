import path from 'node:path';
import { app } from 'electron';
import type { FsChangeEvent, FsChangeType } from '../types';
import type { EntryKind, FsaRawEntry, RawFs } from './types';

// ── Load the Zig module via zigar ───────────────────────────────────

function loadZigFs() {
  if (app.isPackaged) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node-zigar/cjs');
    // console.error('***', require(path.join(process.resourcesPath, 'node-zigar')));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(process.resourcesPath, 'lib/fs.zigar'));
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('node-zigar/cjs');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../lib/fs.zigar');
}

const zigFs = loadZigFs();
zigFs.startup();

// ── Zigar helpers ───────────────────────────────────────────────────

/** Convert a zigar []const u8 slice to a JS string.
 *  Cross-thread calls may present slices differently, so handle multiple formats. */
function zigStr(slice: unknown): string {
  if (typeof slice === 'string') return slice;
  if (slice instanceof Uint8Array || slice instanceof Buffer || ArrayBuffer.isView(slice)) {
    return Buffer.from(slice as Uint8Array).toString('utf-8');
  }
  if (slice && typeof (slice as { valueOf(): unknown }).valueOf === 'function') {
    const val = (slice as { valueOf(): unknown }).valueOf();
    return Buffer.from(val as number[]).toString('utf-8');
  }
  return String(slice);
}

// ── Zig error → Node.js errno mapping ───────────────────────────────

// Maps both raw Zig error names (e.g. "AccessDenied") and the
// human-readable form produced by zigar (e.g. "Access denied").
const ZIG_ERROR_CODES: Record<string, string> = {
  FileNotFound: 'ENOENT',
  'File not found': 'ENOENT',
  NoDevice: 'ENOENT',
  'No device': 'ENOENT',
  AccessDenied: 'EACCES',
  'Access denied': 'EACCES',
  NotDir: 'ENOTDIR',
  'Not dir': 'ENOTDIR',
  IsDir: 'EISDIR',
  'Is dir': 'EISDIR',
  OutOfMemory: 'ENOMEM',
  'Out of memory': 'ENOMEM',
  PathAlreadyExists: 'EEXIST',
  'Path already exists': 'EEXIST',
  InvalidHandle: 'EBADF',
  'Invalid handle': 'EBADF',
  EndOfBuffer: 'EINVAL',
  'End of buffer': 'EINVAL',
};

function toNodeError(err: unknown): never {
  if (err instanceof Error && !('code' in err)) {
    const code = ZIG_ERROR_CODES[err.message];
    if (code) (err as NodeJS.ErrnoException).code = code;
  }
  throw err;
}

// ── Watch callback (push-based) ─────────────────────────────────────

let watchCallbackFn: ((event: FsChangeEvent) => void) | null = null;

export function initWatchCallback(cb: (event: FsChangeEvent) => void): void {
  watchCallbackFn = cb;
  // zigar wraps this JS function as a napi_threadsafe_function,
  // so the Zig watch thread can call it cross-thread safely.
  // IMPORTANT: Must never throw — an unhandled exception panics the Zig thread.
  zigFs.setWatchCallback((watchId: unknown, kind: unknown, name: unknown) => {
    try {
      if (!watchCallbackFn) return;
      watchCallbackFn({
        watchId: zigStr(watchId),
        type: zigStr(kind) as FsChangeType,
        name: name != null ? zigStr(name) : null,
      });
    } catch (err) {
      console.error('[watch] callback error:', err);
    }
  });
}

export function clearWatchCallback(): void {
  watchCallbackFn = null;
  zigFs.setWatchCallback(null);
}

// ── NativeFs — unified RawFs using the Zig zigar module ─────────────

export class NativeFs implements RawFs {
  async entries(dirPath: string): Promise<FsaRawEntry[]> {
    try {
      const raw = zigFs.entries(dirPath);
      const result: FsaRawEntry[] = [];
      for (const e of raw) {
        result.push({
          name: zigStr(e.name),
          kind: zigStr(e.kind) as EntryKind,
          size: Number(e.size),
          mtimeMs: Number(e.mtimeMs),
          mode: Number(e.mode),
          nlink: Number(e.nlink),
          hidden: Boolean(e.hidden),
          linkTarget: e.linkTarget != null ? zigStr(e.linkTarget) : undefined,
        });
      }
      return result;
    } catch (err) {
      toNodeError(err);
    }
  }

  async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    try {
      const s = zigFs.stat(filePath);
      return { size: Number(s.size), mtimeMs: Number(s.mtimeMs) };
    } catch (err) {
      toNodeError(err);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    return Boolean(zigFs.exists(filePath));
  }

  async open(filePath: string): Promise<number> {
    try {
      return Number(zigFs.open(filePath));
    } catch (err) {
      toNodeError(err);
    }
  }

  async read(fd: number, offset: number, length: number): Promise<Buffer> {
    try {
      const data = zigFs.read(fd, offset, length);
      return Buffer.from(data);
    } catch (err) {
      toNodeError(err);
    }
  }

  async close(fd: number): Promise<void> {
    zigFs.close(fd);
  }

  async watch(watchId: string, dirPath: string): Promise<{ ok: boolean }> {
    try {
      const ok = zigFs.watch(watchId, dirPath);
      return { ok: Boolean(ok) };
    } catch (err) {
      toNodeError(err);
    }
  }

  async unwatch(watchId: string): Promise<void> {
    zigFs.unwatch(watchId);
  }
}
