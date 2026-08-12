// preload.js — puente seguro web ↔ shell de escritorio (contextIsolation ON).
// Además: siembra el operario logueado en localStorage ANTES de que arranque la
// web, para que el panel no vuelva a pedir login (la cookie ya autentica el resto).
const { contextBridge, ipcRenderer } = require('electron');

try {
  const arg = (process.argv || []).find((s) => typeof s === 'string' && s.startsWith('--eventos-operator='));
  if (arg) {
    const json = Buffer.from(arg.slice('--eventos-operator='.length), 'base64').toString('utf8');
    const op = JSON.parse(json);
    if (op && op.operatorId) {
      const seed = () => { try { window.localStorage.setItem('eventos.operator', JSON.stringify(op)); } catch { /* noop */ } };
      seed();
      window.addEventListener('DOMContentLoaded', seed);
    }
  }
} catch { /* sin operario inyectado (login/splash) */ }

contextBridge.exposeInMainWorld('eventosDesktop', {
  isDesktop: true,
  version: 2,
  // Notificación nativa del SO.
  notify: (title, body) => ipcRenderer.send('eventos:notify', { title, body }),
  // Abrir una ruta de EventOS en otra ventana/monitor.
  open: (route) => ipcRenderer.send('eventos:open', route),
  // POPUP NATIVO con sonido, siempre-encima (aunque la ventana esté en bandeja).
  alert: (event) => ipcRenderer.send('eventos:alert', event),
  // Hotkeys globales (ack/escalate/next/prev) → la web decide qué hacer.
  onHotkey: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const fn = (_e, name) => cb(name);
    ipcRenderer.on('eventos:hotkey', fn);
    return () => ipcRenderer.removeListener('eventos:hotkey', fn);
  },
  // Foco a un evento puntual (desde el popup nativo "Ver").
  onFocusEvent: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const fn = (_e, id) => cb(id);
    ipcRenderer.on('eventos:focus-event', fn);
    return () => ipcRenderer.removeListener('eventos:focus-event', fn);
  },
  // Login / logout nativos (usados por la pantalla de login).
  auth: {
    login: (payload) => ipcRenderer.invoke('auth:login', payload),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  getConfig: () => ipcRenderer.invoke('cfg:get'),
});
