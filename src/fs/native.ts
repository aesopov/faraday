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

// ── Zigar helpers ───────────────────────────────────────────────────

/** Convert a zigar []const u8 slice to a JS string. */
function zigStr(slice: { valueOf(): number[] }): string {
  return Buffer.from(slice.valueOf()).toString('utf-8');
}

// ── Zig error → Node.js errno mapping ───────────────────────────────

const ZIG_ERROR_CODES: Record<string, string> = {
  FileNotFound: 'ENOENT',
  NoDevice: 'ENOENT',
  AccessDenied: 'EACCES',
  NotDir: 'ENOTDIR',
  IsDir: 'EISDIR',
  OutOfMemory: 'ENOMEM',
  PathAlreadyExists: 'EEXIST',
  InvalidHandle: 'EBADF',
  EndOfBuffer: 'EINVAL',
};

function toNodeError(err: unknown): never {
  if (err instanceof Error && !('code' in err)) {
    const code = ZIG_ERROR_CODES[err.message];
    if (code) (err as NodeJS.ErrnoException).code = code;
  }
  throw err;
}

// ── Watch polling ───────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let watchCallback: ((event: FsChangeEvent) => void) | null = null;

export function initWatchCallback(cb: (event: FsChangeEvent) => void): void {
  watchCallback = cb;
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (!watchCallback) return;
      const events = zigFs.pollWatchEvents();
      if (!events) return;
      for (const ev of events) {
        const name = ev.name;
        watchCallback({
          watchId: zigStr(ev.watch_id),
          type: zigStr(ev.kind) as FsChangeType,
          name: name != null ? zigStr(name) : null,
        });
      }
    }, 50);
  }
}

export function stopWatchPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  watchCallback = null;
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

  async open(filePath: string): Promise<string> {
    try {
      return zigStr(zigFs.open(filePath));
    } catch (err) {
      toNodeError(err);
    }
  }

  async read(fdId: string, offset: number, length: number): Promise<Buffer> {
    try {
      const data = zigFs.read(fdId, offset, length);
      return Buffer.from(data);
    } catch (err) {
      toNodeError(err);
    }
  }

  async close(fdId: string): Promise<void> {
    zigFs.close(fdId);
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
