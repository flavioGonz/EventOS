// EventOS · ARC — shell de escritorio (Electron)
// Splash animado → login nativo → panel por rol (agente/supervisor), cargando la
// web de EventOS. Suma lo que un navegador/PWA no da: decode por GPU, alarma
// sonora sin bloqueo de autoplay, POPUP NATIVO siempre-encima con sirena,
// multi-monitor, bandeja, hotkeys globales, instancia única y wake-lock.
//
// La web NO se reescribe: se carga desde el servidor (config.url). El login y los
// popups son nativos; el panel es la web ya construida.

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, screen,
  nativeImage, powerSaveBlocker, ipcMain, Notification, net, session,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// ── Config ───────────────────────────────────────────────────────────────────
const DEFAULTS = { url: 'http://192.168.99.6', kiosk: false, startMaximized: true, popupMinPriority: 3, popupSound: true };
const USER_CFG = () => path.join(app.getPath('userData'), 'eventos-desktop.json');
function loadConfig() {
  let cfg = { ...DEFAULTS };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) }; } catch { /* opcional */ }
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(USER_CFG(), 'utf8')) }; } catch { /* opcional */ }
  return cfg;
}
let config = loadConfig();
let BASE = String(config.url || DEFAULTS.url).replace(/\/+$/, '');
function saveConfig(patch = {}) {
  config = { ...config, ...patch };
  if (patch.url) BASE = String(config.url).replace(/\/+$/, '');
  try { fs.writeFileSync(USER_CFG(), JSON.stringify(config, null, 2)); } catch { /* noop */ }
}

// ── GPU / decode por HARDWARE (antes de app.ready) ───────────────────────────
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-accelerated-mjpeg-decode');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,VaapiVideoDecoder,CanvasOopRasterization');
if (process.platform === 'win32') app.commandLine.appendSwitch('use-angle', 'd3d11');
// Alarma sonora sin gesto del usuario (ventaja real sobre la PWA).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── Estado ───────────────────────────────────────────────────────────────────
const extra = new Set();        // ventanas extra (wall / pop-out en otros monitores)
let splashWin = null, loginWin = null, mainWin = null, popupWin = null, tray = null, psbId = null;
let currentOperator = null;
let splashShownAt = 0;
let pendingPopup = null;

const PRELOAD = path.join(__dirname, 'preload.js');
const PRELOAD_POPUP = path.join(__dirname, 'preload-popup.js');
const UI = (name) => path.join(__dirname, 'ui', name);

function iconImage() {
  try { const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')); return img.isEmpty() ? null : img; }
  catch { return null; }
}

// ── Red (usa el cookie-jar de la sesión por defecto: el mismo que la ventana) ─
async function apiFetch(pathname, opts = {}) {
  const r = await net.fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { /* no-json */ }
  return { ok: r.ok, status: r.status, json };
}

// ── Splash ───────────────────────────────────────────────────────────────────
function createSplash() {
  splashShownAt = Date.now();
  splashWin = new BrowserWindow({
    width: 460, height: 300, frame: false, resizable: false, movable: false,
    center: true, show: false, backgroundColor: '#0a0d12', transparent: false,
    skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  splashWin.loadFile(UI('splash.html'));
  splashWin.once('ready-to-show', () => splashWin && splashWin.show());
}
function closeSplashSoon(after) {
  const MIN = 1800; // que se vea la animación
  const wait = Math.max(0, MIN - (Date.now() - splashShownAt));
  setTimeout(() => { if (splashWin) { splashWin.close(); splashWin = null; } if (typeof after === 'function') after(); }, wait);
}

// ── Login nativo ─────────────────────────────────────────────────────────────
function createLogin() {
  if (loginWin) { loginWin.focus(); return; }
  const ico = iconImage();
  loginWin = new BrowserWindow({
    width: 440, height: 620, frame: false, resizable: false, center: true, show: false,
    backgroundColor: '#0a0d12', icon: ico || undefined, skipTaskbar: false,
    webPreferences: { preload: PRELOAD, sandbox: false, contextIsolation: true, nodeIntegration: false },
  });
  loginWin.loadFile(UI('login.html'));
  loginWin.once('ready-to-show', () => { loginWin.show(); closeSplashSoon(); });
  loginWin.on('closed', () => { loginWin = null; if (!mainWin) { /* cerró sin loguear */ } });
}

// ── Ventana principal (panel web por rol) ────────────────────────────────────
function routeForRole(role) { return '/'; } // la web ya enruta por rol; el agente entra a la consola

function createMain(operator) {
  currentOperator = operator || currentOperator;
  const ico = iconImage();
  const opB64 = Buffer.from(JSON.stringify(currentOperator || {})).toString('base64');
  mainWin = new BrowserWindow({
    show: false, backgroundColor: '#0a0d12', autoHideMenuBar: true,
    kiosk: !!config.kiosk, icon: ico || undefined,
    webPreferences: {
      preload: PRELOAD, sandbox: false, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false,
      additionalArguments: ['--eventos-operator=' + opB64],
    },
  });
  mainWin.loadURL(BASE + routeForRole(currentOperator && currentOperator.role));
  mainWin.once('ready-to-show', () => {
    mainWin.show();
    if (config.startMaximized && !config.kiosk) mainWin.maximize();
    closeSplashSoon();
    if (loginWin) { loginWin.close(); loginWin = null; }
  });
  // window.open() de la web (pop-out) abre dentro de la app.
  mainWin.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      backgroundColor: '#0a0d12', autoHideMenuBar: true,
      webPreferences: { preload: PRELOAD, sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    },
  }));
  // Cerrar = ocultar en bandeja (la consola sigue viva 24/7 recibiendo eventos).
  mainWin.on('close', (e) => {
    if (!app.isQuiting) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

// Abre una ruta (wall / center) en el "siguiente" monitor.
function openOnNextDisplay(route) {
  const displays = screen.getAllDisplays();
  const d = displays.length > 1 ? displays[(extra.size + 1) % displays.length] : screen.getPrimaryDisplay();
  const ico = iconImage();
  const win = new BrowserWindow({
    x: d.workArea.x + 24, y: d.workArea.y + 24,
    width: Math.max(900, Math.min(1680, d.workArea.width - 48)),
    height: Math.max(600, Math.min(980, d.workArea.height - 48)),
    show: false, backgroundColor: '#0a0d12', autoHideMenuBar: true, icon: ico || undefined,
    webPreferences: { preload: PRELOAD, sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadURL(BASE + route);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => extra.delete(win));
  extra.add(win);
  return win;
}

function focusMain() {
  if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
  else if (currentOperator) createMain(currentOperator);
  else createLogin();
}

// ── Popup NATIVO con sonido (siempre-encima) ─────────────────────────────────
function absMedia(u) {
  if (!u || typeof u !== 'string') return null;
  if (/^https?:\/\//i.test(u)) return u;
  return BASE + (u.startsWith('/') ? u : '/' + u);
}
function showPopup(event) {
  if (!event) return;
  if ((event.priority ?? 5) > (config.popupMinPriority ?? 3)) return; // filtro de ruido
  const payload = {
    id: event.id, type: event.type, priority: event.priority ?? 5,
    title: event.title || event.typeLabel || event.type || 'Evento',
    site: (event.source && (event.source.siteName || event.source.site)) || event.siteName || '',
    device: (event.source && (event.source.deviceName || event.source.device)) || event.deviceName || '',
    detail: event.detail || event.message || '',
    ts: event.ts || new Date().toISOString(),
    snapshot: absMedia(event.media && (event.media.snapshotUrl || event.media.evidenceUrl)),
    sound: config.popupSound !== false,
  };
  pendingPopup = payload;
  const d = screen.getPrimaryDisplay();
  const W = 400, H = 232, M = 18;
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.webContents.send('popup:event', payload);
    popupWin.showInactive();
    return;
  }
  popupWin = new BrowserWindow({
    width: W, height: H, x: d.workArea.x + d.workArea.width - W - M, y: d.workArea.y + d.workArea.height - H - M,
    frame: false, resizable: false, movable: false, show: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
    webPreferences: { preload: PRELOAD_POPUP, sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  popupWin.setAlwaysOnTop(true, 'screen-saver');
  popupWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popupWin.loadFile(UI('popup.html'));
  popupWin.once('ready-to-show', () => popupWin.showInactive());
  popupWin.on('closed', () => { popupWin = null; });
}

// ── Tray + hotkeys ────────────────────────────────────────────────────────────
function buildTray() {
  const ico = iconImage();
  tray = new Tray(ico ? ico.resize({ width: 18, height: 18 }) : nativeImage.createEmpty());
  tray.setToolTip('EventOS · ARC');
  const rebuild = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: currentOperator ? `${currentOperator.name} · ${currentOperator.role}` : 'EventOS · ARC', enabled: false },
    { type: 'separator' },
    { label: 'Consola', accelerator: 'Ctrl+Alt+1', click: focusMain },
    { label: 'Centro de alarmas', accelerator: 'Ctrl+Alt+C', click: () => openOnNextDisplay('/center') },
    { label: 'Videowall (otro monitor)', accelerator: 'Ctrl+Alt+W', click: () => openOnNextDisplay('/wall') },
    { label: 'Panel de supervisor', click: () => openOnNextDisplay('/supervisor') },
    { type: 'separator' },
    { label: 'Recargar todo', accelerator: 'Ctrl+Alt+R', click: () => { if (mainWin) mainWin.reload(); extra.forEach((w) => w.reload()); } },
    { label: 'Pantalla completa (activa)', accelerator: 'Ctrl+Alt+F', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.setFullScreen(!w.isFullScreen()); } },
    { type: 'separator' },
    { label: 'Cerrar sesión', click: doLogout },
    { label: 'Salir', click: () => { app.isQuiting = true; app.quit(); } },
  ]));
  rebuild();
  tray.on('double-click', focusMain);
  tray._rebuild = rebuild;
}

function registerShortcuts() {
  const reg = (acc, fn) => { try { globalShortcut.register(acc, fn); } catch { /* ocupado */ } };
  reg('CommandOrControl+Alt+1', focusMain);
  reg('CommandOrControl+Alt+C', () => openOnNextDisplay('/center'));
  reg('CommandOrControl+Alt+W', () => openOnNextDisplay('/wall'));
  reg('CommandOrControl+Alt+R', () => { if (mainWin) mainWin.reload(); extra.forEach((w) => w.reload()); });
  reg('CommandOrControl+Alt+F', () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.setFullScreen(!w.isFullScreen()); });
  const fwd = (name) => { const w = BrowserWindow.getFocusedWindow() || mainWin; if (w) w.webContents.send('eventos:hotkey', name); };
  reg('CommandOrControl+Alt+A', () => fwd('ack'));
  reg('CommandOrControl+Alt+E', () => fwd('escalate'));
  reg('CommandOrControl+Alt+Down', () => fwd('next'));
  reg('CommandOrControl+Alt+Up', () => fwd('prev'));
}

// ── Sesión: arranque / login / logout ────────────────────────────────────────
async function boot() {
  createSplash();
  let authed = false, operator = null;
  try {
    const me = await apiFetch('/api/auth/me');
    if (me.ok && me.json && me.json.operator) { authed = true; operator = me.json.operator; }
  } catch { /* offline / sin sesión */ }
  if (authed) createMain(operator);
  else createLogin();
}
async function doLogout() {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { /* noop */ }
  try { await session.defaultSession.clearStorageData({ storages: ['cookies'] }); } catch { /* noop */ }
  currentOperator = null;
  if (mainWin) { const w = mainWin; mainWin = null; app.isQuiting = false; w.destroy(); }
  extra.forEach((w) => w.destroy()); extra.clear();
  if (tray && tray._rebuild) tray._rebuild();
  createLogin();
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('auth:login', async (_e, { server, username, password } = {}) => {
  if (server && String(server).replace(/\/+$/, '') !== BASE) saveConfig({ url: String(server).replace(/\/+$/, '') });
  try {
    const r = await apiFetch('/api/auth/login', { method: 'POST', body: { username, password } });
    if (r.ok && r.json && r.json.operator) {
      currentOperator = r.json.operator;
      if (tray && tray._rebuild) tray._rebuild();
      createMain(currentOperator);
      return { ok: true, operator: r.json.operator };
    }
    const code = (r.json && r.json.error) || ('http_' + r.status);
    return { ok: false, error: code };
  } catch (err) {
    return { ok: false, error: 'network', message: String((err && err.message) || err) };
  }
});
ipcMain.handle('cfg:get', () => ({ url: BASE, kiosk: !!config.kiosk }));
ipcMain.handle('auth:logout', async () => { await doLogout(); return { ok: true }; });
ipcMain.on('eventos:notify', (_e, { title, body } = {}) => { try { new Notification({ title: title || 'EventOS · ARC', body: body || '' }).show(); } catch { /* noop */ } });
ipcMain.on('eventos:open', (_e, route) => openOnNextDisplay(String(route || '/')));
ipcMain.on('eventos:alert', (_e, event) => showPopup(event));
ipcMain.on('popup:ready', () => { if (popupWin && pendingPopup) popupWin.webContents.send('popup:event', pendingPopup); });
ipcMain.on('popup:ack', (_e, id) => { focusMain(); if (mainWin && id) mainWin.webContents.send('eventos:focus-event', id); if (popupWin) { popupWin.close(); popupWin = null; } });
ipcMain.on('popup:dismiss', () => { if (popupWin) { popupWin.close(); popupWin = null; } });

// ── Ciclo de vida ─────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusMain);
  app.whenReady().then(() => {
    try { psbId = powerSaveBlocker.start('prevent-display-sleep'); } catch { /* opcional */ }
    // Auto-arranque con Windows (consola 24/7).
    try { if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] }); } catch { /* noop */ }
    buildTray();
    registerShortcuts();
    boot();
    app.on('activate', () => { if (!mainWin && !loginWin) focusMain(); });
  });
  app.on('window-all-closed', () => { /* queda en bandeja; salir desde el menú */ });
  app.on('before-quit', () => { app.isQuiting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (psbId != null) { try { powerSaveBlocker.stop(psbId); } catch { /* noop */ } }
  });
}
