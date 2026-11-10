const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pl', {
  list: () => ipcRenderer.invoke('pl:list'),
  get: (id) => ipcRenderer.invoke('pl:get', id),
  remove: (id) => ipcRenderer.invoke('pl:remove', id),
  rename: (id, name) => ipcRenderer.invoke('pl:rename', id, name),
  retry: (id) => ipcRenderer.invoke('pl:retry', id),
  play: (opts) => ipcRenderer.invoke('pl:play', opts),
  queue: () => ipcRenderer.invoke('pl:queue'),
  importFile: () => ipcRenderer.invoke('pl:import-file'),
  search: (query) => ipcRenderer.invoke('pl:search', query),
  setMatch: (id, index, match) => ipcRenderer.invoke('pl:set-match', id, index, match),
  onChanged: (fn) => ipcRenderer.on('pl:changed', (_e, ev) => fn(ev)),
  onQueue: (fn) => ipcRenderer.on('pl:queue', (_e, q) => fn(q)),
});

contextBridge.exposeInMainWorld('sp', {
  status: () => ipcRenderer.invoke('sp:status'),
  setClientId: (id) => ipcRenderer.invoke('sp:set-client-id', id),
  connect: () => ipcRenderer.invoke('sp:connect'),
  disconnect: () => ipcRenderer.invoke('sp:disconnect'),
  playlists: () => ipcRenderer.invoke('sp:playlists'),
  import: (items) => ipcRenderer.invoke('sp:import', items),
});
