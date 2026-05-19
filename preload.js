const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  saveBackup: (jsonData) => ipcRenderer.invoke('save-backup', jsonData)
})
