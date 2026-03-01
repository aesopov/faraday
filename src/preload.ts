import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  fsa: {
    entries: (dirPath: string) => ipcRenderer.invoke('fsa:entries', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('fsa:readFile', filePath),
  },
  utils: {
    getAppPath: () => ipcRenderer.invoke('utils:getAppPath'),
    getHomePath: () => ipcRenderer.invoke('utils:getHomePath'),
  },
});
