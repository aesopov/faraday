import { app, BrowserWindow, ipcMain } from 'electron';
import started from 'electron-squirrel-startup';
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

ipcMain.handle('fsa:readSlice', async (_event, filePath: string, offset: number, length: number) => {
  const fd = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, offset);
    return buffer.buffer.slice(0, bytesRead);
  } finally {
    await fd.close();
  }
});

ipcMain.handle('utils:getAppPath', () =>
  app.isPackaged ? process.resourcesPath : app.getAppPath(),
);

ipcMain.handle('utils:getHomePath', () => os.homedir());

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
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

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
