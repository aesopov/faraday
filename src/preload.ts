import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  fsa: {
    entries: (dirPath: string) => ipcRenderer.invoke('fsa:entries', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('fsa:readFile', filePath),
    stat: (filePath: string) => ipcRenderer.invoke('fsa:stat', filePath),
    exists: (filePath: string) => ipcRenderer.invoke('fsa:exists', filePath),
    readSlice: (filePath: string, offset: number, length: number) =>
      ipcRenderer.invoke('fsa:readSlice', filePath, offset, length),
  },
  utils: {
    getAppPath: () => ipcRenderer.invoke('utils:getAppPath'),
    getHomePath: () => ipcRenderer.invoke('utils:getHomePath'),
  },
});
