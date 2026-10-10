const { contextBridge, ipcRenderer } = require('electron');

// Everything the renderer is allowed to ask the host for. The renderer treats
// this as optional: when it is absent (plain `vite dev` in a browser) the app
// falls back to File System Access / download-based paths.
contextBridge.exposeInMainWorld('samplerNative', {
  openAudio: () => ipcRenderer.invoke('dlg:openAudio'),
  openFolder: () => ipcRenderer.invoke('dlg:openFolder'),
  chooseDir: (title) => ipcRenderer.invoke('dlg:chooseDir', title),
  saveFile: (name, filters) => ipcRenderer.invoke('dlg:saveFile', name, filters),

  read: (p) => ipcRenderer.invoke('fs:read', p),
  write: (p, data) => ipcRenderer.invoke('fs:write', p, data),
  mkdir: (p) => ipcRenderer.invoke('fs:mkdir', p),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  remove: (p) => ipcRenderer.invoke('fs:remove', p),
  listAudio: (dir) => ipcRenderer.invoke('fs:listAudio', dir),
  join: (...parts) => ipcRenderer.invoke('fs:join', ...parts),
  basename: (p) => ipcRenderer.invoke('fs:basename', p),

  userData: () => ipcRenderer.invoke('app:userData'),
  documents: () => ipcRenderer.invoke('app:documents'),

  version: () => ipcRenderer.invoke('app:version'),
  updatesCheck: () => ipcRenderer.invoke('updates:check'),
  updatesDownload: () => ipcRenderer.invoke('updates:download'),
  updatesInstall: () => ipcRenderer.invoke('updates:install'),
  onUpdateProgress: (fn) => {
    const listener = (_e, p) => fn(p);
    ipcRenderer.on('updates:progress', listener);
    return () => ipcRenderer.removeListener('updates:progress', listener);
  },

  setDirty: (dirty) => ipcRenderer.send('app:setDirty', !!dirty),
  closeReady: () => ipcRenderer.send('app:closeReady'),
  onCloseRequest: (fn) => {
    const listener = (_e, action) => fn(action);
    ipcRenderer.on('app:closeRequest', listener);
    return () => ipcRenderer.removeListener('app:closeRequest', listener);
  },
});

// The audio host bridge. `send` is fire-and-forget; everything the host has to
// say comes back through the single `onEvent` stream.
contextBridge.exposeInMainWorld('samplerAudio', {
  platform: process.platform,
  start: () => ipcRenderer.invoke('audio:start'),
  stop: () => ipcRenderer.invoke('audio:stop'),
  send: (msg) => ipcRenderer.send('audio:send', msg),
  onEvent: (fn) => {
    const listener = (_e, msg) => fn(msg);
    ipcRenderer.on('audio:event', listener);
    return () => ipcRenderer.removeListener('audio:event', listener);
  },
});
