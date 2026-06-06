const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokenUsage', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  getData: () => ipcRenderer.invoke('data:get'),
  refreshData: () => ipcRenderer.invoke('data:refresh'),
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  getSessionDetail: (params) => ipcRenderer.invoke('session:getDetail', params),

  onDataPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch {} };
    ipcRenderer.on('data:push', listener);
    return () => ipcRenderer.removeListener('data:push', listener);
  },

  onSettingsPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch {} };
    ipcRenderer.on('settings:push', listener);
    return () => ipcRenderer.removeListener('settings:push', listener);
  }
});
