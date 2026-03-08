import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import started from 'electron-squirrel-startup';
import os from 'node:os';
import path from 'node:path';
import { registerFsHandlers, cleanupContents, cleanupAll } from './fs/ipcHandlers';
import { stopWatchPolling } from './fs/native';

if (started) {
  app.quit();
}

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
  stopWatchPolling();
  cleanupAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
