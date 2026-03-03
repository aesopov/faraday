import { BrowserWindow, ipcMain } from 'electron';
import { launchElevated, type ElevatedChild } from './elevate';
import { RawFs } from './types';
import { NativeFs } from './native';
import { FsProxy } from './fsProxy';
import type { FsChangeEvent } from '../types';

// ── Per-webContents resource tracking ────────────────────────────────

const opsByContents = new Map<number, NativeFs>();
const localFdsByContents = new Map<number, Set<string>>();
const proxyFdsByContents = new Map<number, Set<string>>();
const proxyWatchesByContents = new Map<number, Set<string>>();

function trackLocalFd(contentsId: number, fdId: string): void {
  let set = localFdsByContents.get(contentsId);
  if (!set) {
    set = new Set();
    localFdsByContents.set(contentsId, set);
  }
  set.add(fdId);
}

function trackProxyFd(contentsId: number, fdId: string): void {
  let set = proxyFdsByContents.get(contentsId);
  if (!set) {
    set = new Set();
    proxyFdsByContents.set(contentsId, set);
  }
  set.add(fdId);
}

function trackProxyWatch(contentsId: number, watchId: string): void {
  let set = proxyWatchesByContents.get(contentsId);
  if (!set) {
    set = new Set();
    proxyWatchesByContents.set(contentsId, set);
  }
  set.add(watchId);
}

function getOps(contentsId: number, sender: Electron.WebContents): NativeFs {
  let ops = opsByContents.get(contentsId);
  if (!ops) {
    ops = new NativeFs((event) => {
      if (!sender.isDestroyed()) {
        sender.send('fsa:change', event);
      }
    });
    opsByContents.set(contentsId, ops);
  }
  return ops;
}

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
    const ops = getOps(event.sender.id, event.sender);
    try {
      return await fn(ops, ...args);
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
  const ops = opsByContents.get(contentsId);
  if (ops) {
    ops.closeAll();
    opsByContents.delete(contentsId);
  }

  // Clean up local fds tracked by the native addon's global FdTable
  const localFds = localFdsByContents.get(contentsId);
  if (localFds) {
    const anyOps = opsByContents.values().next().value;
    if (anyOps) {
      for (const fdId of localFds) anyOps.close(fdId).catch(() => {});
    }
  }
  localFdsByContents.delete(contentsId);

  const p = proxy;
  if (p?.isAlive) {
    const fds = proxyFdsByContents.get(contentsId);
    if (fds) {
      for (const fdId of fds) p.close(fdId).catch(() => {});
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
  for (const contentsId of opsByContents.keys()) cleanupContents(contentsId);
  proxyChild?.kill();
}

/** Register all fsa:* IPC handlers. Call once at startup. */
export function registerFsHandlers(): void {
  ipcMain.handle('fsa:entries', withErrorHandling(withEscalation((fs, dirPath: string) => fs.entries(dirPath))));

  ipcMain.handle('fsa:stat', withErrorHandling(withEscalation((fs, filePath: string) => fs.stat(filePath))));

  ipcMain.handle('fsa:exists', withErrorHandling(withEscalation((fs, filePath: string) => fs.exists(filePath))));

  ipcMain.handle(
    'fsa:open',
    withErrorHandling(async (event, filePath: string) => {
      const ops = getOps(event.sender.id, event.sender);
      try {
        const fdId = await ops.open(filePath);
        trackLocalFd(event.sender.id, fdId);
        return fdId;
      } catch (err) {
        if (!isElevatable(err)) throw err;
        const p = await getProxy();
        const fdId = await p.open(filePath);
        trackProxyFd(event.sender.id, fdId);
        return fdId;
      }
    }),
  );

  ipcMain.handle(
    'fsa:read',
    withErrorHandling(async (event, fdId: string, offset: number, length: number) => {
      if (fdId.startsWith('proxy:')) {
        const p = proxy;
        if (!p?.isAlive) throw new Error('Elevated FS service is not connected');
        const buf = await p.read(fdId, offset, length);
        return buf instanceof Buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf;
      }
      const ops = getOps(event.sender.id, event.sender);
      const buf = await ops.read(fdId, offset, length);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }),
  );

  ipcMain.handle(
    'fsa:close',
    withErrorHandling(async (event, fdId: string) => {
      if (fdId.startsWith('proxy:')) {
        proxyFdsByContents.get(event.sender.id)?.delete(fdId);
        const p = proxy;
        if (!p?.isAlive) return;
        return p.close(fdId);
      }
      localFdsByContents.get(event.sender.id)?.delete(fdId);
      const ops = getOps(event.sender.id, event.sender);
      return ops.close(fdId);
    }),
  );

  ipcMain.handle(
    'fsa:watch',
    withErrorHandling(async (event, watchId: string, dirPath: string) => {
      const ops = getOps(event.sender.id, event.sender);
      try {
        return await ops.watch(watchId, dirPath);
      } catch (err) {
        if (!isElevatable(err)) throw err;
        const p = await getProxy();
        const result = await p.watch(watchId, dirPath);
        trackProxyWatch(event.sender.id, watchId);
        return result;
      }
    }),
  );

  ipcMain.handle(
    'fsa:unwatch',
    withErrorHandling(async (event, watchId: string) => {
      proxyWatchesByContents.get(event.sender.id)?.delete(watchId);
      const ops = getOps(event.sender.id, event.sender);
      await ops.unwatch(watchId);
      if (proxy?.isAlive) {
        await proxy.unwatch(watchId).catch(() => {});
      }
    }),
  );
}
