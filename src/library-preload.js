const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('library', {
  list: () => ipcRenderer.invoke('lib:list'),
  add: () => ipcRenderer.invoke('lib:add'),
  addFiles: (files) => ipcRenderer.invoke('lib:add-paths', Array.from(files).map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  remove: (id) => ipcRenderer.invoke('lib:remove', id),
  reportState: (state) => ipcRenderer.send('lib:now-playing', state),
  onControl: (fn) => ipcRenderer.on('lib:control', (_e, action) => fn(action)),
  // Imported playlists can include your files; the app then drives what plays next
  onQueue: (fn) => ipcRenderer.on('lib:queue', (_e, on) => fn(on)),
  reportEnded: (id) => ipcRenderer.send('lib:ended', id),
  queueStep: (dir) => ipcRenderer.send('lib:queue-step', dir),
  queueExit: () => ipcRenderer.send('lib:queue-exit'),
  close: () => ipcRenderer.send('lib:close'), // back to YouTube Music (the song keeps playing)
  // Uploads songs to your YouTube Music library (Library > Uploads), where they
  // work like any other song, including in your YouTube Music playlists
  uploadToYtm: (ids) => ipcRenderer.invoke('lib:upload-ytm', ids),
});
