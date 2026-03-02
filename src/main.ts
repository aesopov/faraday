import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import started from 'electron-squirrel-startup';
import os from 'node:os';
import path from 'node:path';
import { FsOps } from './fsOps';
import { FsProxy } from './fsProxy';
import { launchElevated, type ElevatedChild } from './elevate';
import type { FsaRawEntry, FsChangeEvent } from './types';

if (started) {
  app.quit();
}

// Per-webContents FsOps instances
const opsByContents = new Map<number, FsOps>();

function getOps(contentsId: number, sender: Electron.WebContents): FsOps {
  let ops = opsByContents.get(contentsId);
  if (!ops) {
    ops = new FsOps((event) => {
      if (!sender.isDestroyed()) {
        sender.send('fsa:change', event);
      }
    });
    opsByContents.set(contentsId, ops);
  }
  return ops;
}

function cleanupContents(contentsId: number): void {
  const ops = opsByContents.get(contentsId);
  if (ops) {
    ops.closeAll();
    opsByContents.delete(contentsId);
  }
}

// Elevated FS proxy — singleton, lazily launched
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

      // Clean up when child disconnects
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

function isElevatable(err: unknown): boolean {
  // Only escalate EACCES (traditional Unix permission denied).
  // EPERM means a MAC policy (macOS TCC/SIP, Linux SELinux/AppArmor)
  // that even root cannot bypass — prompting for a password won't help.
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EACCES';
}

function withErrorHandling<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<{ result?: T; error?: Error }> {
  return (...args: A) =>
    fn(...args)
      .then((result) => ({ result }))
      .catch((err) => ({ error: err }));
}

// Escalation wrapper: try local first, on EACCES/EPERM retry via elevated proxy
function withEscalation<A extends unknown[], R>(localFn: (ops: FsOps, ...args: A) => Promise<R>, proxyFn: (proxy: FsProxy, ...args: A) => Promise<R>) {
  return async (event: Electron.IpcMainInvokeEvent, ...args: A): Promise<R> => {
    const ops = getOps(event.sender.id, event.sender);
    try {
      return await localFn(ops, ...args);
    } catch (err) {
      if (!isElevatable(err)) throw err;
      const p = await getProxy();
      return proxyFn(p, ...args);
    }
  };
}

// IPC handlers — FSA-compatible, with automatic escalation
ipcMain.handle(
  'fsa:entries',
  withErrorHandling(
    withEscalation(
      (ops, dirPath: string) => ops.entries(dirPath),
      (p, dirPath: string) => {
        return p.entries(dirPath) as Promise<FsaRawEntry[]>;
      },
    ),
  ),
);

ipcMain.handle(
  'fsa:readFile',
  withEscalation(
    (ops, filePath: string) => ops.readFile(filePath),
    (p, filePath: string) => p.readFile(filePath) as Promise<string>,
  ),
);

ipcMain.handle(
  'fsa:stat',
  withErrorHandling(
    withEscalation(
      (ops, filePath: string) => ops.stat(filePath),
      (p, filePath: string) => p.stat(filePath) as Promise<{ size: number; mtimeMs: number }>,
    ),
  ),
);

ipcMain.handle(
  'fsa:exists',
  withErrorHandling(
    withEscalation(
      (ops, filePath: string) => ops.exists(filePath),
      (p, filePath: string) => p.exists(filePath) as Promise<boolean>,
    ),
  ),
);

ipcMain.handle(
  'fsa:open',
  withErrorHandling(
    withEscalation(
      (ops, filePath: string) => ops.open(filePath),
      (p, filePath: string) => p.open(filePath),
    ),
  ),
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
      const p = proxy;
      if (!p?.isAlive) return;
      return p.close(fdId);
    }
    const ops = getOps(event.sender.id, event.sender);
    return ops.close(fdId);
  }),
);

ipcMain.handle(
  'fsa:watch',
  withErrorHandling(
    withEscalation(
      (ops, watchId: string, dirPath: string) => ops.watch(watchId, dirPath),
      (p, watchId: string, dirPath: string) => p.watch(watchId, dirPath) as Promise<{ ok: boolean }>,
    ),
  ),
);

ipcMain.handle(
  'fsa:unwatch',
  withErrorHandling(async (event, watchId: string) => {
    const ops = getOps(event.sender.id, event.sender);
    await ops.unwatch(watchId);
    // Also unwatch from proxy in case it was escalated
    if (proxy?.isAlive) {
      await proxy.unwatch(watchId).catch(() => {});
    }
  }),
);

ipcMain.handle('utils:getAppPath', () => (app.isPackaged ? process.resourcesPath : app.getAppPath()));

ipcMain.handle('utils:getHomePath', () => os.homedir());

ipcMain.handle('theme:get', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  nativeTheme.on('updated', () => {
    mainWindow.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  });

  const contentsId = mainWindow.webContents.id;

  // Clean up watchers and open fds on reload or window close
  mainWindow.webContents.on('did-start-navigation', () => {
    cleanupContents(contentsId);
  });
  mainWindow.webContents.on('destroyed', () => {
    cleanupContents(contentsId);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  for (const contentsId of opsByContents.keys()) cleanupContents(contentsId);
  proxyChild?.kill();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
