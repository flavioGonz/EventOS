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

// Preferencias de video del cliente (calidad/maxLive) inyectadas por main.js.
let _vprefs = null;
try {
  const a = (process.argv || []).find((s) => typeof s === 'string' && s.startsWith('--eventos-vprefs='));
  if (a) _vprefs = JSON.parse(Buffer.from(a.slice('--eventos-vprefs='.length), 'base64').toString('utf8'));
} catch { _vprefs = null; }

contextBridge.exposeInMainWorld('eventosDesktop', {
  isDesktop: true,
  version: 3,
  // Overrides de video por puesto (la web los aplica sobre la config del server).
  videoPrefs: _vprefs,
  // La web reporta cuántos flujos en vivo hay activos (para el HUD de rendimiento).
  reportLive: (active, max) => ipcRenderer.send('client:live-count', { active, max }),
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
  // Perfiles de servidor (multi-servidor local, por operador).
  servers: {
    get: () => ipcRenderer.invoke('servers:get'),
    add: (name, url) => ipcRenderer.invoke('servers:add', { name, url }),
    remove: (id) => ipcRenderer.invoke('servers:remove', id),
    select: (url) => ipcRenderer.invoke('servers:select', url),
  },
  // Insignia de alarmas pendientes en la barra de tareas (la web informa el conteo).
  setBadge: (count) => ipcRenderer.send('eventos:badge', count),
  // Configuración NATIVA del cliente de escritorio (NO abre /admin del sistema).
  openSettings: () => ipcRenderer.send('client:open-settings'),
  // Controles de la ventana sin marco (login / settings).
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    close: () => ipcRenderer.send('win:close'),
  },
  client: {
    get: () => ipcRenderer.invoke('client:get'),
    set: (patch) => ipcRenderer.invoke('client:set', patch),
    restart: () => ipcRenderer.invoke('client:restart'),
  },
  // Rendimiento del cliente (CPU/mem): valor puntual + suscripción en vivo.
  getPerf: () => ipcRenderer.invoke('perf:get'),
  // Aviso de que el servidor publicó una versión nueva (para banner "sincronizar").
  onUpdateAvailable: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const fn = (_e, info) => cb(info);
    ipcRenderer.on('client:update-available', fn);
    return () => ipcRenderer.removeListener('client:update-available', fn);
  },
  onPerf: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('perf:tick', fn);
    return () => ipcRenderer.removeListener('perf:tick', fn);
  },
});
