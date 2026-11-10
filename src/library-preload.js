const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('library', {
  list: () => ipcRenderer.invoke('lib:list'),
  add: () => ipcRenderer.invoke('lib:add'),
  addFiles: (files) => ipcRenderer.invoke('lib:add-paths', Array.from(files).map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  remove: (id) => ipcRenderer.invoke('lib:remove', id),
  reportState: (state) => ipcRenderer.send('lib:now-playing', state),
  onControl: (fn) => ipcRenderer.on('lib:control', (_e, action) => fn(action)),
});
