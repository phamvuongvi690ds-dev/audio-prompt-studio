const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('studioAPI', {
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  process: (payload) => ipcRenderer.invoke('audio:process', payload),
  info: (payload) => ipcRenderer.invoke('audio:info', payload),
  saveConfig: (payload) => ipcRenderer.invoke('config:save', payload),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveText: (payload) => ipcRenderer.invoke('dialog:saveText', payload),
  readText: (payload) => ipcRenderer.invoke('dialog:readText', payload)
});
