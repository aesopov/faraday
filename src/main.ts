import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import started from 'electron-squirrel-startup';
import os from 'node:os';
import path from 'node:path';

if (started) {
  app.quit();
}

const isHeadless = process.argv.includes('--headless');

if (isHeadless) {
  // ── Headless mode: HTTP + WebSocket server, no GUI ──────────────
  app.on('ready', async () => {
    const fs = await import('node:fs');
    const { startHeadlessServer } = await import('./fs/wsServer');
    const port = parseInt(process.env.FARADAY_PORT || '3001', 10);
    const host = process.env.FARADAY_HOST || '127.0.0.1';
    const appPath = app.isPackaged ? process.resourcesPath : app.getAppPath();

    // Production: renderer is bundled alongside the main process
    // Dev: fall back to dist-web/ (from `pnpm build:web`)
    const prodDir = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
    const devDir = path.join(app.getAppPath(), 'dist-web');
    const staticDir = fs.existsSync(path.join(prodDir, 'index.html')) ? prodDir : devDir;

    startHeadlessServer({ port, host, staticDir, appPath });
  });

  app.on('window-all-closed', () => {
    // Keep running — no windows expected in headless mode
  });
} else {
  // ── Normal Electron GUI mode ────────────────────────────────────
  // Dynamic imports to avoid loading the Zig native module in headless mode
  (async () => {
    const { registerFsHandlers, cleanupContents, cleanupAll } = await import('./fs/ipcHandlers');
    const { clearWatchCallback } = await import('./fs/native');

    registerFsHandlers();

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

      mainWindow.webContents.on('did-start-navigation', () => cleanupContents(contentsId));
      mainWindow.webContents.on('destroyed', () => cleanupContents(contentsId));

      if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      } else {
        mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
      }
    };

    app.on('ready', createWindow);

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });

    app.on('will-quit', () => {
      clearWatchCallback();
      cleanupAll();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })();
}
