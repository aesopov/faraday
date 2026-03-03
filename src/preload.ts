import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  fsa: {
    entries: (dirPath: string) => ipcRenderer.invoke('fsa:entries', dirPath),
    stat: (filePath: string) => ipcRenderer.invoke('fsa:stat', filePath),
    exists: (filePath: string) => ipcRenderer.invoke('fsa:exists', filePath),
    open: (filePath: string) => ipcRenderer.invoke('fsa:open', filePath),
    read: (fd: string, offset: number, length: number) => ipcRenderer.invoke('fsa:read', fd, offset, length),
    close: (fd: string) => ipcRenderer.invoke('fsa:close', fd),
    watch: (watchId: string, path: string) => ipcRenderer.invoke('fsa:watch', watchId, path),
    unwatch: (watchId: string) => ipcRenderer.invoke('fsa:unwatch', watchId),
    onFsChange: (callback: (event: { watchId: string; type: string; name: string | null }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { watchId: string; type: string; name: string | null }) => callback(data);
      ipcRenderer.on('fsa:change', listener);
      return () => {
        ipcRenderer.removeListener('fsa:change', listener);
      };
    },
  },
  utils: {
    getAppPath: () => ipcRenderer.invoke('utils:getAppPath'),
    getHomePath: () => ipcRenderer.invoke('utils:getHomePath'),
  },
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    onChange: (callback: (theme: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, theme: string) => callback(theme);
      ipcRenderer.on('theme:changed', listener);
      return () => {
        ipcRenderer.removeListener('theme:changed', listener);
      };
    },
  },
});
