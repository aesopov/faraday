import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import started from 'electron-squirrel-startup';
import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (started) {
  app.quit();
}

// IPC handlers — FSA-compatible
ipcMain.handle('fsa:entries', async (_event, dirPath: string) => {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  return Promise.all(
    dirents.map(async (d) => {
      const fullPath = path.join(dirPath, d.name);
      let size = 0;
      let mtimeMs = 0;
      let mode = 0;
      let isSymbolicLink = false;
      try {
        const s = await fs.stat(fullPath);
        size = s.size;
        mtimeMs = s.mtimeMs;
        mode = s.mode;
      } catch {
        // Skip stat errors (e.g. permission denied)
      }
      isSymbolicLink = d.isSymbolicLink();
      return {
        name: d.name,
        kind: d.isDirectory() ? 'directory' : 'file',
        size,
        mtimeMs,
        mode,
        isSymbolicLink,
      };
    }),
  );
});

ipcMain.handle('fsa:readFile', async (_event, filePath: string) => {
  return fs.readFile(filePath, 'utf-8');
});

ipcMain.handle('fsa:stat', async (_event, filePath: string) => {
  const s = await fs.stat(filePath);
  return { size: s.size, mtimeMs: s.mtimeMs };
});

ipcMain.handle('fsa:exists', async (_event, filePath: string) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
});

// Open file descriptors — keyed by webContents id, then fdId
type NodeFileHandle = Awaited<ReturnType<typeof fs.open>>;
const openFdsByContents = new Map<number, Map<string, NodeFileHandle>>();
let nextFdId = 0;

function getOpenFdMap(contentsId: number): Map<string, NodeFileHandle> {
  let map = openFdsByContents.get(contentsId);
  if (!map) {
    map = new Map();
    openFdsByContents.set(contentsId, map);
  }
  return map;
}

function closeAllFdsForContents(contentsId: number): void {
  const map = openFdsByContents.get(contentsId);
  if (!map) return;
  for (const fd of map.values()) fd.close().catch(() => {});
  map.clear();
  openFdsByContents.delete(contentsId);
}

ipcMain.handle('fsa:open', async (event, filePath: string) => {
  const fd = await fs.open(filePath, 'r');
  const fdId = `fd-${nextFdId++}`;
  getOpenFdMap(event.sender.id).set(fdId, fd);
  return fdId;
});

ipcMain.handle('fsa:read', async (event, fdId: string, offset: number, length: number) => {
  const fd = openFdsByContents.get(event.sender.id)?.get(fdId);
  if (!fd) throw new Error('Invalid file descriptor');
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buffer, 0, length, offset);
  return buffer.buffer.slice(0, bytesRead);
});

ipcMain.handle('fsa:close', async (event, fdId: string) => {
  const map = openFdsByContents.get(event.sender.id);
  if (!map) return;
  const fd = map.get(fdId);
  if (fd) {
    map.delete(fdId);
    await fd.close();
  }
});

// File system watchers — keyed by webContents id, then watchId
const watchersByContents = new Map<number, Map<string, FSWatcher>>();

function getWatcherMap(contentsId: number): Map<string, FSWatcher> {
  let map = watchersByContents.get(contentsId);
  if (!map) {
    map = new Map();
    watchersByContents.set(contentsId, map);
  }
  return map;
}

function closeAllWatchersForContents(contentsId: number): void {
  const map = watchersByContents.get(contentsId);
  if (!map) return;
  for (const watcher of map.values()) watcher.close();
  map.clear();
  watchersByContents.delete(contentsId);
}

ipcMain.handle('fsa:watch', async (event, watchId: string, dirPath: string) => {
  try {
    await fs.access(dirPath);
  } catch {
    return { ok: false };
  }

  const contentsId = event.sender.id;
  const map = getWatcherMap(contentsId);

  // Close existing watcher with same ID
  map.get(watchId)?.close();

  const watcher = watch(dirPath, async (eventType, filename) => {
    if (event.sender.isDestroyed()) return;
    let type: string;
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
    event.sender.send('fsa:change', { watchId, type, name: filename ?? null });
  });

  watcher.on('error', () => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('fsa:change', { watchId, type: 'errored', name: null });
    }
    watcher.close();
    map.delete(watchId);
  });

  map.set(watchId, watcher);
  return { ok: true };
});

ipcMain.handle('fsa:unwatch', async (event, watchId: string) => {
  const map = watchersByContents.get(event.sender.id);
  if (!map) return;
  const watcher = map.get(watchId);
  if (watcher) {
    watcher.close();
    map.delete(watchId);
  }
});

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
    closeAllWatchersForContents(contentsId);
    closeAllFdsForContents(contentsId);
  });
  mainWindow.webContents.on('destroyed', () => {
    closeAllWatchersForContents(contentsId);
    closeAllFdsForContents(contentsId);
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
  for (const contentsId of watchersByContents.keys()) closeAllWatchersForContents(contentsId);
  for (const contentsId of openFdsByContents.keys()) closeAllFdsForContents(contentsId);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
