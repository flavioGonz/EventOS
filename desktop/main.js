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
  dialog, shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// ── Config ───────────────────────────────────────────────────────────────────
const DEFAULTS = { url: '', kiosk: false, startMaximized: true, popupMinPriority: 3, popupSound: true, servers: [], disableGpu: false, autostart: true, video: { quality: 'auto', maxLive: 8 } };
// Prefs de video del cliente → base64 para inyectar al preload de la web.
function vprefsArg() {
  const v = (config.video && typeof config.video === 'object') ? config.video : {};
  const payload = { quality: v.quality || 'auto', maxLive: Number(v.maxLive) || 8 };
  return '--eventos-vprefs=' + Buffer.from(JSON.stringify(payload)).toString('base64');
}
const USER_CFG = () => path.join(app.getPath('userData'), 'eventos-desktop.json');
function loadConfig() {
  let cfg = { ...DEFAULTS };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) }; } catch { /* opcional */ }
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(USER_CFG(), 'utf8')) }; } catch { /* opcional */ }
  if (!Array.isArray(cfg.servers)) cfg.servers = [];
  return cfg;
}
let config = loadConfig();
let BASE = String(config.url || DEFAULTS.url).replace(/\/+$/, '');
function saveConfig(patch = {}) {
  config = { ...config, ...patch };
  if (patch.url != null) BASE = String(config.url || '').replace(/\/+$/, '');
  try { fs.writeFileSync(USER_CFG(), JSON.stringify(config, null, 2)); } catch { /* noop */ }
}

// ── Perfiles de servidor (multi-servidor, guardado local por operador) ────────
// El cliente NO tiene IP hardcodeada: cada instalación guarda su lista de
// servidores (nombre + URL) en el disco (userData). El operador elige uno en el
// login. Así una misma app sirve a varios clientes/instancias.
function normUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s;
}
function serversList() { return Array.isArray(config.servers) ? config.servers : []; }
function serversAdd({ name, url } = {}) {
  const u = normUrl(url);
  if (!u) return { ok: false, error: 'bad_url' };
  const list = serversList().slice();
  const id = 's' + Date.now().toString(36);
  const existing = list.find((s) => normUrl(s.url) === u);
  if (existing) { existing.name = String(name || existing.name || u); }
  else list.push({ id, name: String(name || u), url: u });
  saveConfig({ servers: list });
  return { ok: true, servers: list, current: BASE };
}
function serversRemove(id) {
  const list = serversList().filter((s) => s.id !== id);
  saveConfig({ servers: list });
  return { ok: true, servers: list, current: BASE };
}

// ── GPU / decode por HARDWARE (antes de app.ready) ───────────────────────────
// IMPORTANTE (anti-cuelgue): VaapiVideoDecoder es de LINUX. Forzarlo en Windows
// desestabiliza el proceso GPU (cuelgues/negros). En Windows el decode va por
// D3D11VideoDecoder (+ HEVC por PlatformHEVCDecoderSupport). Cada plataforma con lo suyo.
// Si el usuario desactivó la GPU (tras cuelgues), no aplicamos aceleración.
// META: el decode por HARDWARE debe funcionar. Flags MÍNIMOS y estables: sólo
// destrabamos la blocklist y habilitamos el decodificador de video por HW (D3D11 en
// Windows, VAAPI en Linux). NADA de gpu-rasterization/zero-copy/angle forzado ni de
// disable-crash-limit: eso hacía crashear el proceso GPU en el driver Intel y disparaba
// el auto-apagado. Chromium ya usa el decode por HW por defecto; sólo lo confirmamos.
if (config.disableGpu) {
  try { app.disableHardwareAcceleration(); } catch { /* noop */ }
} else if (process.platform !== 'win32') {
  // En Linux (servidor) sí habilitamos VAAPI explícito.
  app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder');
}
// En WINDOWS: NADA. Defaults puros de Chromium (idénticos a Chrome, que en esta
// máquina SÍ usa la GPU y el decode por HW). Forzar ignore-gpu-blocklist hacía
// crashear el proceso GPU del driver Intel y Chromium apagaba TODA la GPU (software).
// El HEVC se resuelve por el transcode a H264 en el server; no lo necesitamos acá.
// Alarma sonora sin gesto del usuario (ventaja real sobre la PWA).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── Estado ───────────────────────────────────────────────────────────────────
const extra = new Set();        // ventanas extra (wall / pop-out en otros monitores)
let splashWin = null, loginWin = null, mainWin = null, popupWin = null, settingsWin = null, tray = null, psbId = null;
let currentOperator = null;
let splashShownAt = 0;
let pendingPopup = null;
let gpuCrashes = 0;
let perfTimer = null;
let liveStreams = { active: 0, max: 8 };
let lastPerf = { cpu: 0, memMB: 0, procs: 0, gpuOn: false, live: 0, liveMax: 8 };

const PRELOAD = path.join(__dirname, 'preload.js');
const PRELOAD_POPUP = path.join(__dirname, 'preload-popup.js');
const UI = (name) => path.join(__dirname, 'ui', name);

function iconImage() {
  try { const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')); return img.isEmpty() ? null : img; }
  catch { return null; }
}

// ── Integración Windows: insignia de conteo + parpadeo de la barra de tareas ──
// Dibuja un badge rojo con el número de alarmas pendientes sobre el ícono de la
// app en la barra de tareas (overlay icon), y también usa app.setBadgeCount.
let lastBadge = -1;
function badgeImage(count) {
  const n = count > 99 ? '99+' : String(count);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <circle cx="16" cy="16" r="15" fill="#dc2626" stroke="#fff" stroke-width="2"/>
    <text x="16" y="22" font-family="Segoe UI,Arial" font-size="${n.length > 2 ? 13 : 17}" font-weight="700"
      fill="#fff" text-anchor="middle">${n}</text></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}
function setTaskbarBadge(count) {
  if (count === lastBadge) return;
  lastBadge = count;
  try { app.setBadgeCount(count > 0 ? count : 0); } catch { /* noop */ }
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    if (count > 0) mainWin.setOverlayIcon(badgeImage(count), `${count} alarma(s) pendientes`);
    else mainWin.setOverlayIcon(null, '');
  } catch { /* noop */ }
}
function attention() {
  // Llama la atención cuando entra una alarma y la ventana no está en foco.
  try { if (mainWin && !mainWin.isDestroyed() && !mainWin.isFocused()) mainWin.flashFrame(true); } catch { /* noop */ }
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
    // Doble panel (formulario + escena viva), como el login web → ventana ancha.
    width: 1000, height: 660, minWidth: 900, minHeight: 600, frame: false, resizable: true, center: true, show: false,
    backgroundColor: '#f4f5f7', icon: ico || undefined, skipTaskbar: false,
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
      additionalArguments: ['--eventos-operator=' + opB64, vprefsArg()],
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
  watchUnresponsive(mainWin);
  // Al enfocar la consola, dejar de parpadear (el operador ya la está mirando).
  mainWin.on('focus', () => { try { mainWin.flashFrame(false); } catch { /* noop */ } });
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
    webPreferences: { preload: PRELOAD, sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, additionalArguments: [vprefsArg()] },
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
// Trae las analíticas dibujadas de la cámara y, si el popup sigue mostrando este
// evento, le manda una versión enriquecida para superponerlas sobre la foto. No
// bloquea la aparición de la notificación (se muestra ya, y esto llega un instante
// después). `fetch` global está disponible en Electron/Node 18+.
async function maybeFetchAnalytics(payload) {
  if (!payload || !payload.deviceId || typeof fetch !== 'function') return;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${BASE}/api/camera/${payload.deviceId}/analytics`, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(to);
    if (!r || !r.ok) return;
    const data = await r.json().catch(() => null);
    if (!data || !Array.isArray(data.rules) || !data.rules.length) return;
    if (!popupWin || popupWin.isDestroyed() || (pendingPopup && pendingPopup.id !== payload.id)) return;
    const enriched = { ...payload, rules: data.rules, space: data.space || 1000 };
    pendingPopup = enriched;
    try { popupWin.webContents.send('popup:event', enriched); } catch { /* ventana cerrándose */ }
  } catch { /* best-effort: sin analíticas, el popup igual muestra la foto */ }
}

function showPopup(event) {
  if (!event) return;
  if ((event.priority ?? 5) > (config.popupMinPriority ?? 3)) return; // filtro de ruido
  const deviceId = (event.source && event.source.deviceId) || event.deviceId || null;
  const raw = event.raw || {};
  const triggerId = raw.regionID ?? raw.RegionID ?? raw.lineID ?? raw.regionId ?? null;
  const payload = {
    id: event.id, type: event.type, priority: event.priority ?? 5,
    title: event.title || event.typeLabel || event.type || 'Evento',
    site: (event.source && (event.source.siteName || event.source.site)) || event.siteName || '',
    device: (event.source && (event.source.deviceName || event.source.device)) || event.deviceName || '',
    detail: event.detail || event.message || '',
    ts: event.ts || new Date().toISOString(),
    snapshot: absMedia(event.media && (event.media.snapshotUrl || event.media.evidenceUrl)),
    sound: config.popupSound !== false,
    deviceId, triggerId, space: 1000, rules: null,
  };
  pendingPopup = payload;
  attention(); // parpadeo de la barra de tareas si la ventana no está en foco
  maybeFetchAnalytics(payload); // enriquece la foto con las analíticas dibujadas (best-effort)
  const d = screen.getPrimaryDisplay();
  const W = 400, H = 300, M = 18;
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

// ── Configuración NATIVA del cliente de escritorio ───────────────────────────
// La config de la APP de Windows (servidores, GPU, arranque, popups, rendimiento)
// vive acá, NO en /admin (eso es config del sistema EventOS). Ventana propia.
function createSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  const ico = iconImage();
  settingsWin = new BrowserWindow({
    width: 720, height: 640, minWidth: 560, minHeight: 480, frame: false, resizable: true,
    center: true, show: false, backgroundColor: '#f4f5f7', icon: ico || undefined,
    webPreferences: { preload: PRELOAD, sandbox: false, contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.loadFile(UI('settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ── Rendimiento: CPU/memoria del propio cliente (app.getAppMetrics) ──────────
function samplePerf() {
  let metrics = [];
  try { metrics = app.getAppMetrics() || []; } catch { metrics = []; }
  let cpu = 0, memKB = 0;
  for (const m of metrics) {
    cpu += (m.cpu && m.cpu.percentCPUUsage) || 0;
    memKB += (m.memory && m.memory.workingSetSize) || 0;
  }
  let gpuOn = false;
  try { gpuOn = !config.disableGpu && app.getGPUFeatureStatus && /enabled/i.test((app.getGPUFeatureStatus().video_decode || '')); } catch { gpuOn = !config.disableGpu; }
  lastPerf = { cpu: Math.round(cpu), memMB: Math.round(memKB / 1024), procs: metrics.length, gpuOn, live: liveStreams.active, liveMax: liveStreams.max };
  if (tray) { try { tray.setToolTip(`EventOS · ARC\nCPU ${lastPerf.cpu}%  ·  Mem ${lastPerf.memMB} MB  ·  GPU ${gpuOn ? 'on' : 'off'}`); } catch { /* noop */ } }
  if (settingsWin && !settingsWin.isDestroyed()) { try { settingsWin.webContents.send('perf:tick', lastPerf); } catch { /* noop */ } }
  if (mainWin && !mainWin.isDestroyed()) { try { mainWin.webContents.send('perf:tick', lastPerf); } catch { /* noop */ } }
}
function startPerf() { if (perfTimer) return; perfTimer = setInterval(samplePerf, 2000); samplePerf(); }

// ── Recuperación ante cuelgues (lo más importante para el operador 24/7) ─────
// En vez de quedar congelada: si el render muere → recargar la ventana; si el
// proceso GPU se cae repetido → desactivar GPU y relanzar con software.
function reloadWin(wc) {
  try { const w = BrowserWindow.fromWebContents(wc); if (w && !w.isDestroyed()) w.reload(); } catch { /* noop */ }
}
function wireCrashRecovery() {
  app.on('render-process-gone', (_e, wc, details) => {
    // reason: 'crashed' | 'oom' | 'killed' | ...
    if (details && details.reason !== 'clean-exit') setTimeout(() => reloadWin(wc), 800);
  });
  app.on('child-process-gone', (_e, details) => {
    if (details && details.type === 'GPU') {
      // NO desactivamos la GPU automáticamente (eso mataba el decode por HW). Chromium
      // reinicia solo el proceso GPU; si de verdad no puede, cae a software por su cuenta.
      // Sólo contamos para diagnóstico. El apagado de GPU es MANUAL desde Configuración.
      gpuCrashes++;
    }
  });
}
function watchUnresponsive(win) {
  if (!win) return;
  win.on('unresponsive', () => {
    // No matar de una: dar un respiro y recargar; si el operador quiere, decide.
    setTimeout(() => { try { if (win && !win.isDestroyed() && win.webContents) win.webContents.reloadIgnoringCache(); } catch { /* noop */ } }, 1200);
  });
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
    { label: 'Configuración del cliente', accelerator: 'Ctrl+Alt+,', click: createSettings },
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

// ── Actualización OBLIGATORIA (la versión de escritorio respeta la del server) ──
// La app de escritorio DEBE coincidir con la última versión publicada por el
// servidor (el mismo release que la web). Al arrancar consulta /api/desktop/latest;
// si el server tiene una versión más nueva que la instalada, se exige actualizar:
// se ofrece descargar e instalar (corre el NSIS y cierra la app) o salir. No se
// permite seguir usando una versión desactualizada. Un fallo de red NO bloquea
// (se sigue con la versión actual y se reintenta el próximo arranque).
function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
// Ventana de progreso de la actualización (frameless, oscura, con barra en vivo).
function createUpdateWindow(latest) {
  const win = new BrowserWindow({
    width: 448, height: 272, resizable: false, frame: false, show: false,
    backgroundColor: '#0d1322', center: true, alwaysOnTop: true, maximizable: false,
    minimizable: false, fullscreenable: false, title: 'Actualizando EventOS ARC',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'ui', 'updating.html'));
  win.once('ready-to-show', () => { win.show(); });
  return win;
}
// Descarga el instalador MOSTRANDO progreso, avisa que se cierra la consola y aplica
// la actualización, lanza el NSIS (one-click, auto-instala y reabre) y cierra la app.
async function downloadAndRunInstaller(latest) {
  const tmp = path.join(app.getPath('temp'), latest.filename || `EventOS-ARC-Setup-${latest.version}.exe`);
  const win = createUpdateWindow(latest);
  const js = (code) => { try { if (win && !win.isDestroyed()) win.webContents.executeJavaScript(code).catch(() => {}); } catch { /* noop */ } };
  await new Promise((r) => { if (win.webContents.isLoadingMainFrame && !win.webContents.isLoadingMainFrame()) return r(); win.webContents.once('did-finish-load', r); });
  js(`window.__ver && window.__ver(${JSON.stringify('v' + (latest.version || ''))})`);
  js(`window.__phase && window.__phase('download')`);
  try {
    const r = await net.fetch(BASE + (latest.url || '/api/desktop/download'));
    if (!r.ok || !r.body) throw new Error('download_http_' + (r && r.status));
    const total = Number(r.headers.get('content-length')) || Number(latest.sizeBytes) || 0;
    const reader = r.body.getReader();
    const chunks = []; let recv = 0, lastSent = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); recv += value.length;
      const now = Date.now();
      if (now - lastSent > 120) { lastSent = now; const pct = total ? Math.round((recv / total) * 100) : null; js(`window.__progress && window.__progress(${pct === null ? 'null' : pct}, ${recv}, ${total})`); }
    }
    js(`window.__progress && window.__progress(100, ${recv}, ${total})`);
    const bin = Buffer.concat(chunks);
    // Verificación de integridad ANTES de ejecutar: comparamos el SHA-256 del binario
    // descargado con el que publica el server (/api/desktop/latest). Sin esto, un MITM
    // o un server comprometido podría servir un instalador malicioso → RCE en la
    // estación del operador. Si el server no publica sha256 (versión vieja), avisamos
    // pero no rompemos el flujo de actualización obligatoria.
    if (latest.sha256) {
      const got = crypto.createHash('sha256').update(bin).digest('hex');
      if (got.toLowerCase() !== String(latest.sha256).toLowerCase()) {
        throw new Error('checksum_mismatch: el instalador no coincide con el publicado por el servidor');
      }
    }
    fs.writeFileSync(tmp, bin);
  } catch (e) {
    js(`window.__phase && window.__phase('error')`);
    await new Promise((res) => setTimeout(res, 900));
    try { if (win && !win.isDestroyed()) win.close(); } catch { /* noop */ }
    throw e;
  }
  // Handoff claro: se cierra la consola y el instalador continúa solo (one-click) y reabre.
  js(`window.__phase && window.__phase('install')`);
  await new Promise((res) => setTimeout(res, 1300));
  await shell.openPath(tmp);
  await new Promise((res) => setTimeout(res, 700));
  app.isQuiting = true; app.quit();
}
// Devuelve true si HAY que detener el arranque (se está actualizando o el usuario
// eligió salir); false si la versión está al día (o no se pudo verificar).
async function checkForcedUpdate() {
  if (!BASE) return false;
  let latest = null;
  try {
    const r = await apiFetch('/api/desktop/latest');
    if (r.ok && r.json && r.json.available) latest = r.json;
  } catch { return false; } // sin red / server → no bloquea
  if (!latest || !latest.version) return false;
  const installed = app.getVersion();
  if (cmpVer(latest.version, installed) <= 0) return false; // al día o más nueva
  // Hay versión más nueva → actualización obligatoria.
  try { if (splashWin) splashWin.hide(); } catch { /* noop */ }
  const mb = await dialog.showMessageBox({
    type: 'warning', noLink: true, defaultId: 0, cancelId: 1,
    title: 'Actualización obligatoria',
    message: `Hay una nueva versión de EventOS ARC (v${latest.version}).`,
    detail: `Tenés instalada la v${installed}. Para seguir usando la consola de escritorio es necesario actualizar a la v${latest.version}, que coincide con la versión del servidor.`,
    buttons: ['Descargar e instalar ahora', 'Salir'],
  });
  if (mb.response === 0) {
    try {
      // Sin diálogo bloqueante: la ventana de progreso muestra la descarga en vivo,
      // avisa que se cierra la consola, y el instalador one-click continúa y reabre.
      await downloadAndRunInstaller(latest);
    } catch (e) {
      await dialog.showMessageBox({ type: 'error', buttons: ['Salir'], noLink: true,
        title: 'No se pudo actualizar',
        message: 'No se pudo descargar el instalador.',
        detail: `${(e && e.message) || e}\n\nDescargalo manualmente desde ${BASE}${latest.url || '/api/desktop/download'}` });
      app.isQuiting = true; app.quit();
    }
  } else {
    app.isQuiting = true; app.quit();
  }
  return true;
}

// ── Chequeo periódico de versión → NOTIFICAR que hay que sincronizar ─────────
// La consola corre 24/7; no la cortamos de golpe, pero avisamos al operador (y le
// mandamos un aviso a la web para banner "sincronizar") cuando el server publica una
// versión nueva. La actualización obligatoria se aplica en el próximo login/arranque.
let updateNotified = null;
async function softUpdateCheck() {
  if (!BASE) return;
  try {
    const r = await apiFetch('/api/desktop/latest');
    if (!(r.ok && r.json && r.json.available && r.json.version)) return;
    if (cmpVer(r.json.version, app.getVersion()) <= 0) return;
    if (updateNotified === r.json.version) return; // no repetir la misma
    updateNotified = r.json.version;
    try { new Notification({ title: 'Actualización disponible', body: `Hay una nueva versión de EventOS ARC (v${r.json.version}). Reiniciá el cliente para sincronizar.` }).show(); } catch { /* noop */ }
    if (mainWin && !mainWin.isDestroyed()) { try { mainWin.webContents.send('client:update-available', r.json); } catch { /* noop */ } }
  } catch { /* sin red */ }
}

// ── Sesión: arranque / login / logout ────────────────────────────────────────
async function boot() {
  createSplash();
  // Sin servidor configurado → directo al login (que muestra el selector de
  // servidor). No intentamos /api/auth/me contra una URL vacía.
  if (!BASE) { createLogin(); return; }
  // Antes de nada: exigir que la versión de escritorio esté al día con el server.
  if (await checkForcedUpdate()) return;
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
      // Al loguearse: si la versión está desfasada respecto al server, NO se entra
      // (actualización obligatoria antes de abrir la consola).
      if (await checkForcedUpdate()) return { ok: true, updating: true };
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
ipcMain.handle('cfg:get', () => ({ url: BASE, kiosk: !!config.kiosk, servers: serversList() }));
// ── Configuración del cliente (ventana nativa de settings) ───────────────────
ipcMain.on('client:open-settings', createSettings);
// La web reporta cuántos flujos en vivo hay activos → HUD de rendimiento.
ipcMain.on('client:live-count', (_e, d) => {
  if (d && typeof d === 'object') {
    liveStreams = { active: Number(d.active) || 0, max: Number(d.max) || liveStreams.max };
    lastPerf = { ...lastPerf, live: liveStreams.active, liveMax: liveStreams.max };
    if (settingsWin && !settingsWin.isDestroyed()) { try { settingsWin.webContents.send('perf:tick', lastPerf); } catch { /* noop */ } }
  }
});
ipcMain.handle('client:get', () => ({
  version: app.getVersion(),
  url: BASE,
  disableGpu: !!config.disableGpu,
  startMaximized: config.startMaximized !== false,
  kiosk: !!config.kiosk,
  autostart: config.autostart !== false,
  popupMinPriority: config.popupMinPriority ?? 3,
  popupSound: config.popupSound !== false,
  video: { quality: (config.video && config.video.quality) || 'auto', maxLive: (config.video && Number(config.video.maxLive)) || 8 },
  gpu: (() => { try { return app.getGPUFeatureStatus(); } catch { return null; } })(),
  gpuInfo: null,
  perf: lastPerf,
}));
ipcMain.handle('client:set', (_e, patch = {}) => {
  const allow = {};
  for (const k of ['disableGpu', 'startMaximized', 'kiosk', 'popupMinPriority', 'popupSound', 'autostart']) {
    if (patch[k] !== undefined) allow[k] = patch[k];
  }
  // Prefs de video (calidad / maxLive) — objeto anidado.
  let videoChanged = false;
  if (patch.video && typeof patch.video === 'object') {
    const cur = (config.video && typeof config.video === 'object') ? config.video : {};
    allow.video = { quality: patch.video.quality || cur.quality || 'auto', maxLive: Number(patch.video.maxLive) || Number(cur.maxLive) || 8 };
    videoChanged = true;
  }
  saveConfig(allow);
  if (allow.autostart !== undefined && process.platform === 'win32') {
    try { app.setLoginItemSettings({ openAtLogin: allow.autostart !== false, args: ['--hidden'] }); } catch { /* noop */ }
  }
  // Prefs de video: se inyectan al crear la ventana, así que para aplicarlas RECREAMOS
  // la consola (toma los nuevos --eventos-vprefs). Sin perder la sesión (cookie).
  if (videoChanged && mainWin && !mainWin.isDestroyed() && currentOperator) {
    try {
      const old = mainWin; mainWin = null;
      old.destroy();
      extra.forEach((w) => { try { w.destroy(); } catch { /* noop */ } }); extra.clear();
      createMain(currentOperator);
    } catch { /* noop */ }
  }
  const needsRestart = allow.disableGpu !== undefined;
  return { ok: true, needsRestart };
});
ipcMain.handle('client:restart', () => { try { app.relaunch(); } catch { /* noop */ } app.isQuiting = true; app.exit(0); });
ipcMain.handle('perf:get', () => lastPerf);
// Controles de ventana para las ventanas sin marco (login / settings).
ipcMain.on('win:minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.on('win:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
// Perfiles de servidor (multi-servidor local).
ipcMain.handle('servers:get', () => ({ servers: serversList(), current: BASE }));
ipcMain.handle('servers:add', (_e, payload) => serversAdd(payload || {}));
ipcMain.handle('servers:remove', (_e, id) => serversRemove(String(id || '')));
ipcMain.handle('servers:select', (_e, url) => { const u = normUrl(url); if (u) saveConfig({ url: u }); return { ok: !!u, current: BASE }; });
// Insignia de la barra de tareas (conteo de alarmas pendientes) — integración Windows.
ipcMain.on('eventos:badge', (_e, count) => setTaskbarBadge(Number(count) || 0));
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
    // Auto-arranque con Windows (consola 24/7) — respetando la preferencia del usuario.
    try { if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: config.autostart !== false, args: ['--hidden'] }); } catch { /* noop */ }
    wireCrashRecovery();   // recuperación ante cuelgues (GPU / render)
    // DIAGNÓSTICO GPU: volcamos el estado de aceleración (incluye video_decode) a un
    // archivo, para saber si Chromium habilitó el decode por hardware y, si no, por qué.
    try {
      const feat = app.getGPUFeatureStatus();
      const out = { ts: new Date().toISOString(), version: app.getVersion(), disableGpu: !!config.disableGpu, features: feat };
      fs.writeFileSync(path.join(app.getPath('userData'), 'gpu-status.json'), JSON.stringify(out, null, 2));
      app.getGPUInfo('basic').then((gi) => {
        try { fs.writeFileSync(path.join(app.getPath('userData'), 'gpu-info.json'), JSON.stringify(gi, null, 2)); } catch { /* noop */ }
      }).catch(() => {});
    } catch { /* noop */ }
    startPerf();           // muestreo de rendimiento (CPU/mem) para el tray y settings
    buildTray();
    registerShortcuts();
    // Jump list de Windows (clic derecho en la barra de tareas → accesos rápidos).
    try {
      if (process.platform === 'win32') app.setUserTasks([
        { program: process.execPath, arguments: '--open=/center', title: 'Centro de alarmas', description: 'Abrir el centro de verificación', iconPath: process.execPath, iconIndex: 0 },
        { program: process.execPath, arguments: '--open=/wall', title: 'Videowall', description: 'Abrir el videowall', iconPath: process.execPath, iconIndex: 0 },
      ]);
    } catch { /* noop */ }
    boot();
    // Aviso de sincronización: revisa la versión del server cada 30 min.
    setInterval(softUpdateCheck, 30 * 60 * 1000);
    app.on('activate', () => { if (!mainWin && !loginWin) focusMain(); });
  });
  app.on('window-all-closed', () => { /* queda en bandeja; salir desde el menú */ });
  app.on('before-quit', () => { app.isQuiting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (psbId != null) { try { powerSaveBlocker.stop(psbId); } catch { /* noop */ } }
  });
}
