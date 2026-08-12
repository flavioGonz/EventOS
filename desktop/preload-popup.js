// preload-popup.js — puente del popup nativo de alarma.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('popupApi', {
  ready: () => ipcRenderer.send('popup:ready'),
  onEvent: (cb) => { const fn = (_e, ev) => cb(ev); ipcRenderer.on('popup:event', fn); return () => ipcRenderer.removeListener('popup:event', fn); },
  ack: (id) => ipcRenderer.send('popup:ack', id),
  dismiss: () => ipcRenderer.send('popup:dismiss'),
});
