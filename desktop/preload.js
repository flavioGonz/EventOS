// preload.js — puente seguro entre la web de EventOS y el shell de escritorio.
// Expone window.eventosDesktop SOLO con lo necesario (contextIsolation ON).
// La web es opcionalmente "consciente" del desktop: si window.eventosDesktop
// existe, puede disparar notificaciones nativas o escuchar hotkeys globales.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eventosDesktop', {
  isDesktop: true,
  version: 1,
  // Notificación nativa del SO (sirve aunque la ventana esté minimizada/en otro monitor).
  notify: (title, body) => ipcRenderer.send('eventos:notify', { title, body }),
  // Abrir una ruta de EventOS en otra ventana/monitor.
  open: (route) => ipcRenderer.send('eventos:open', route),
  // Suscribirse a los hotkeys globales (ack/escalate/next/prev). La web decide qué hacer.
  onHotkey: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const fn = (_e, name) => cb(name);
    ipcRenderer.on('eventos:hotkey', fn);
    return () => ipcRenderer.removeListener('eventos:hotkey', fn);
  },
});
