// EventOS · ARC — shell de escritorio (Electron)
// Envuelve la web de EventOS en una app nativa: ventana dedicada (sin navegador),
// decode de video por HARDWARE forzado (GPU), audio de alarma sin el bloqueo de
// autoplay, multi-monitor, bandeja, hotkeys globales, instancia única y wake-lock.
//
// La web NO se reescribe: se carga desde el servidor (config.url). Cuando hay
// nuevas versiones publicadas en nginx, esta app las toma al recargar.

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, screen,
  nativeImage, powerSaveBlocker, ipcMain, Notification,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// ─────────────────────────────────────────────────────────────────────────────
// Config: assets/config.json (empaquetado) o %APPDATA%/EventOS ARC/eventos-desktop.json
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULTS = { url: 'http://172.26.20.247', kiosk: false, startMaximized: true };
function loadConfig() {
  let cfg = { ...DEFAULTS };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) }; } catch { /* opcional */ }
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'eventos-desktop.json'), 'utf8')) }; } catch { /* opcional */ }
  return cfg;
}
const config = loadConfig();
const BASE = String(config.url || DEFAULTS.url).replace(/\/+$/, '');

// ─────────────────────────────────────────────────────────────────────────────
// GPU / decodificación por HARDWARE (deben setearse ANTES de app.ready).
// Esto es lo que un navegador/PWA no te deja controlar: forzamos que el video
// se decodifique en la GPU (D3D11VA / NVDEC / QSV / VAAPI) y no en CPU — clave
// para el videowall con muchas cámaras a la vez.
// ─────────────────────────────────────────────────────────────────────────────
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-accelerated-mjpeg-decode');
app.commandLine.appendSwitch(
  'enable-features',
  'PlatformHEVCDecoderSupport,VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,CanvasOopRasterization,AcceleratedVideoDecodeLinuxGL'
);
app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');
if (process.platform === 'win32') app.commandLine.appendSwitch('use-angle', 'd3d11');
// Alarma sonora sin requerir gesto del usuario (ventaja real sobre la PWA).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ─────────────────────────────────────────────────────────────────────────────
const windows = new Set();
let tray = null;
let psbId = null;

function iconImage() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    return img.isEmpty() ? null : img;
  } catch { return null; }
}

function makeWindow({ route = '/', displayIndex = null, kiosk = false } = {}) {
  let bounds = {};
  if (displayIndex != null) {
    const displays = screen.getAllDisplays();
    const d = displays[displayIndex] || screen.getPrimaryDisplay();
    bounds = {
      x: d.workArea.x + 30, y: d.workArea.y + 30,
      width: Math.max(900, Math.min(1680, d.workArea.width - 60)),
      height: Math.max(600, Math.min(980, d.workArea.height - 60)),
    };
  }
  const ico = iconImage();
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    backgroundColor: '#0a0d12',
    autoHideMenuBar: true,
    kiosk: kiosk || !!config.kiosk,
    icon: ico || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // NO frenar video/socket en ventanas de fondo (otros monitores)
      spellcheck: false,
    },
  });
  win.loadURL(BASE + route);
  win.once('ready-to-show', () => {
    win.show();
    if (config.startMaximized && displayIndex == null && !config.kiosk) win.maximize();
  });
  // Permitir que window.open() de la web (pop-out de tabla/wall) abra ventanas dentro de la app.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      backgroundColor: '#0a0d12', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    },
  }));
  win.on('closed', () => windows.delete(win));
  windows.add(win);
  return win;
}

// Abre una ruta en el "siguiente" monitor disponible (rota por displays).
function openOnNextDisplay(route) {
  const displays = screen.getAllDisplays();
  const idx = displays.length > 1 ? (windows.size % displays.length) : null;
  return makeWindow({ route, displayIndex: idx });
}

function focusFirst() {
  const w = [...windows][0];
  if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  else makeWindow({ route: '/' });
}

function buildTray() {
  const ico = iconImage();
  tray = new Tray(ico ? ico.resize({ width: 18, height: 18 }) : nativeImage.createEmpty());
  tray.setToolTip('EventOS · ARC');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'EventOS · ARC', enabled: false },
    { type: 'separator' },
    { label: 'Consola', accelerator: 'Ctrl+Alt+1', click: () => focusFirst() },
    { label: 'Centro de alarmas', accelerator: 'Ctrl+Alt+C', click: () => makeWindow({ route: '/center' }) },
    { label: 'Videowall (otro monitor)', accelerator: 'Ctrl+Alt+W', click: () => openOnNextDisplay('/wall') },
    { label: 'Tabla desacoplada (otro monitor)', accelerator: 'Ctrl+Alt+T', click: () => openOnNextDisplay('/center?popout=table') },
    { type: 'separator' },
    { label: 'Recargar todo', accelerator: 'Ctrl+Alt+R', click: () => windows.forEach((w) => w.reload()) },
    { label: 'Pantalla completa (ventana activa)', accelerator: 'Ctrl+Alt+F', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.setFullScreen(!w.isFullScreen()); } },
    { label: 'Diagnóstico GPU (chrome://gpu)', click: () => { const w = makeWindow({ route: '/' }); w.loadURL('chrome://gpu'); } },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuiting = true; app.quit(); } },
  ]));
  tray.on('double-click', focusFirst);
}

function registerShortcuts() {
  const reg = (acc, fn) => { try { globalShortcut.register(acc, fn); } catch { /* ocupado por el SO */ } };
  reg('CommandOrControl+Alt+1', focusFirst);
  reg('CommandOrControl+Alt+C', () => makeWindow({ route: '/center' }));
  reg('CommandOrControl+Alt+W', () => openOnNextDisplay('/wall'));
  reg('CommandOrControl+Alt+T', () => openOnNextDisplay('/center?popout=table'));
  reg('CommandOrControl+Alt+R', () => windows.forEach((w) => w.reload()));
  reg('CommandOrControl+Alt+F', () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.setFullScreen(!w.isFullScreen()); });
  // Acciones in-app: la web puede escucharlas vía window.eventosDesktop.onHotkey(name).
  const fwd = (name) => { const w = BrowserWindow.getFocusedWindow() || [...windows][0]; if (w) w.webContents.send('eventos:hotkey', name); };
  reg('CommandOrControl+Alt+A', () => fwd('ack'));      // acusar
  reg('CommandOrControl+Alt+E', () => fwd('escalate')); // escalar
  reg('CommandOrControl+Alt+Down', () => fwd('next'));  // siguiente alarma
  reg('CommandOrControl+Alt+Up', () => fwd('prev'));    // anterior
}

// IPC desde el preload (la web pide cosas nativas).
ipcMain.on('eventos:notify', (_e, { title, body } = {}) => {
  try { new Notification({ title: title || 'EventOS · ARC', body: body || '' }).show(); } catch { /* sin soporte */ }
});
ipcMain.on('eventos:open', (_e, route) => openOnNextDisplay(String(route || '/')));

// ─────────────────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusFirst);
  app.whenReady().then(() => {
    try { psbId = powerSaveBlocker.start('prevent-display-sleep'); } catch { /* opcional */ }
    makeWindow({ route: '/' });
    buildTray();
    registerShortcuts();
    app.on('activate', () => { if (windows.size === 0) makeWindow({ route: '/' }); });
  });
  // No salir al cerrar todas las ventanas: queda en la bandeja (consola 24/7).
  app.on('window-all-closed', () => { /* permanece en tray; salir desde el menú */ });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (psbId != null) { try { powerSaveBlocker.stop(psbId); } catch { /* noop */ } }
  });
}
