import { BrowserWindow, ipcMain } from 'electron';
import { launchElevated, type ElevatedChild } from './elevate';
import { RawFs } from './types';
import { NativeFs, initWatchCallback } from './native';
import { FsProxy } from './fsProxy';
import type { FsChangeEvent } from '../types';

// ── Per-webContents resource tracking ────────────────────────────────

const localFdsByContents = new Map<number, Set<number>>();
const localWatchesByContents = new Map<number, Set<string>>();
const proxyFdsByContents = new Map<number, Set<number>>();
const proxyWatchesByContents = new Map<number, Set<string>>();

function trackFd(map: Map<number, Set<number>>, contentsId: number, fd: number): void {
  let set = map.get(contentsId);
  if (!set) {
    set = new Set();
    map.set(contentsId, set);
  }
  set.add(fd);
}

function trackWatch(map: Map<number, Set<string>>, contentsId: number, id: string): void {
  let set = map.get(contentsId);
  if (!set) {
    set = new Set();
    map.set(contentsId, set);
  }
  set.add(id);
}

// Singleton — all webContents share the same NativeFs (addon state is global)
const nativeFs = new NativeFs();

// ── Elevated proxy singleton ─────────────────────────────────────────

let proxy: FsProxy | null = null;
let proxyLaunching: Promise<FsProxy> | null = null;
let proxyChild: ElevatedChild | null = null;

function broadcastWatchEvent(event: FsChangeEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('fsa:change', event);
    }
  }
}

async function getProxy(): Promise<FsProxy> {
  if (proxy?.isAlive) return proxy;

  if (proxyLaunching) return proxyLaunching;

  proxyLaunching = (async () => {
    try {
      const child = await launchElevated();
      proxyChild = child;
      proxy = new FsProxy(child.socket, broadcastWatchEvent);

      child.done.then(() => {
        proxy = null;
        proxyChild = null;
      });

      return proxy;
    } finally {
      proxyLaunching = null;
    }
  })();

  return proxyLaunching;
}

// ── Escalation helpers ───────────────────────────────────────────────

function isElevatable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EACCES';
}

function withErrorHandling<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<{ result?: T; error?: Error }> {
  return (...args: A) =>
    fn(...args)
      .then((result) => ({ result }))
      .catch((err) => ({ error: err }));
}

function withEscalation<A extends unknown[], R>(fn: (ops: RawFs, ...args: A) => Promise<R>) {
  return async (event: Electron.IpcMainInvokeEvent, ...args: A): Promise<R> => {
    try {
      return await fn(nativeFs, ...args);
    } catch (err) {
      if (!isElevatable(err)) throw err;
      const p = await getProxy();
      return fn(p, ...args);
    }
  };
}

// ── Public API ───────────────────────────────────────────────────────

/** Clean up all fs resources owned by a webContents. */
export function cleanupContents(contentsId: number): void {
  // Clean up local fds
  const localFds = localFdsByContents.get(contentsId);
  if (localFds) {
    for (const fd of localFds) nativeFs.close(fd).catch(() => {});
  }
  localFdsByContents.delete(contentsId);

  // Clean up local watches
  const localWatches = localWatchesByContents.get(contentsId);
  if (localWatches) {
    for (const watchId of localWatches) nativeFs.unwatch(watchId).catch(() => {});
  }
  localWatchesByContents.delete(contentsId);

  // Clean up elevated proxy resources
  const p = proxy;
  if (p?.isAlive) {
    const fds = proxyFdsByContents.get(contentsId);
    if (fds) {
      for (const fd of fds) p.close(fd).catch(() => {});
    }
    const watches = proxyWatchesByContents.get(contentsId);
    if (watches) {
      for (const watchId of watches) p.unwatch(watchId).catch(() => {});
    }
  }
  proxyFdsByContents.delete(contentsId);
  proxyWatchesByContents.delete(contentsId);
}

/** Clean up all sessions and kill the elevated helper. */
export function cleanupAll(): void {
  for (const contentsId of localFdsByContents.keys()) cleanupContents(contentsId);
  proxyChild?.kill();
}

/** Register all fsa:* IPC handlers. Call once at startup. */
export function registerFsHandlers(): void {
  // Native watch events are broadcast to all windows
  initWatchCallback(broadcastWatchEvent);

  ipcMain.handle('fsa:entries', withErrorHandling(withEscalation((fs, dirPath: string) => fs.entries(dirPath))));

  ipcMain.handle('fsa:stat', withErrorHandling(withEscalation((fs, filePath: string) => fs.stat(filePath))));

  ipcMain.handle('fsa:exists', withErrorHandling(withEscalation((fs, filePath: string) => fs.exists(filePath))));

  ipcMain.handle(
    'fsa:open',
    withErrorHandling(async (event, filePath: string) => {
      try {
        const fd = await nativeFs.open(filePath);
        trackFd(localFdsByContents, event.sender.id, fd);
        return fd;
      } catch (err) {
        if (!isElevatable(err)) throw err;
        const p = await getProxy();
        const fd = await p.open(filePath);
        trackFd(proxyFdsByContents, event.sender.id, fd);
        return fd;
      }
    }),
  );

  ipcMain.handle(
    'fsa:read',
    withErrorHandling(async (_event, fd: number, offset: number, length: number) => {
      if (fd < 0) {
        const p = proxy;
        if (!p?.isAlive) throw new Error('Elevated FS service is not connected');
        const buf = await p.read(fd, offset, length);
        return buf instanceof Buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf;
      }
      const buf = await nativeFs.read(fd, offset, length);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }),
  );

  ipcMain.handle(
    'fsa:close',
    withErrorHandling(async (event, fd: number) => {
      if (fd < 0) {
        proxyFdsByContents.get(event.sender.id)?.delete(fd);
        const p = proxy;
        if (!p?.isAlive) return;
        return p.close(fd);
      }
      localFdsByContents.get(event.sender.id)?.delete(fd);
      return nativeFs.close(fd);
    }),
  );

  ipcMain.handle(
    'fsa:watch',
    withErrorHandling(async (event, watchId: string, dirPath: string) => {
      try {
        const result = await nativeFs.watch(watchId, dirPath);
        if (result.ok) trackWatch(localWatchesByContents, event.sender.id, watchId);
        return result;
      } catch (err) {
        if (!isElevatable(err)) throw err;
        const p = await getProxy();
        const result = await p.watch(watchId, dirPath);
        trackWatch(proxyWatchesByContents, event.sender.id, watchId);
        return result;
      }
    }),
  );

  ipcMain.handle(
    'fsa:unwatch',
    withErrorHandling(async (event, watchId: string) => {
      localWatchesByContents.get(event.sender.id)?.delete(watchId);
      await nativeFs.unwatch(watchId);
      proxyWatchesByContents.get(event.sender.id)?.delete(watchId);
      if (proxy?.isAlive) {
        await proxy.unwatch(watchId).catch(() => {});
      }
    }),
  );
}
