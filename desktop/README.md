# EventOS · ARC — Consola de escritorio (Electron)

App de escritorio para la **estación del operador / supervisor** de la central de
monitoreo. **No reescribe la web**: carga el panel de EventOS desde el servidor
(`config.json → url`) y le agrega la capa nativa que un navegador/PWA no puede dar.

## Qué aporta sobre el navegador
- **Splash animado** (SVG) al iniciar.
- **Login nativo** (usuario/clave) contra `/api/auth/login`; la cookie de sesión
  queda en el jar de Electron y autentica el panel, el video y el socket.
- **Popup NATIVO de alarma con sirena** (WebAudio), siempre-encima de otras apps,
  aunque la ventana esté minimizada en la bandeja. Se dispara desde el evento real
  ruteado al operador (no es la notificación limitada del SO).
- **Sonido sin bloqueo de autoplay** (`autoplay-policy=no-user-gesture-required`).
- **Decode de video por GPU** (D3D11/NVDEC/QSV) para el videowall.
- **Multi-monitor**, **bandeja**, **hotkeys globales**, **instancia única**,
  **wake-lock** y **auto-arranque con Windows**.

## Requisitos
- Node.js 18+ y npm en la PC donde se compila.
- Windows para generar el instalador `.exe` (NSIS).

## Ejecutar en desarrollo
```bash
cd desktop
npm install
npm start
```

## Compilar el instalador de Windows
```bash
cd desktop
npm install
npm run dist:win     # genera dist\EventOS ARC Setup x.y.z.exe (NSIS)
```
El instalador crea accesos directos en Escritorio y Menú Inicio.

## Configuración
`config.json` (empaquetado) o `%APPDATA%\EventOS ARC\eventos-desktop.json` (por PC):
```json
{
  "url": "https://eventos.infratec.com.uy",
  "kiosk": false,
  "startMaximized": true,
  "popupMinPriority": 3,
  "popupSound": true
}
```
- `url`: servidor de EventOS que carga la app. Se puede cambiar desde el login
  (⚙ Servidor).
- `kiosk`: pantalla completa sin bordes (puesto dedicado).
- `popupMinPriority`: prioridad máxima que dispara popup nativo (1=crítico … 5=traza).
  Con `3` aparecen P1–P3; la sirena continua es solo para P1/P2.
- `popupSound`: sonido del popup on/off.

## Hotkeys globales
- `Ctrl+Alt+1` consola · `Ctrl+Alt+C` centro de alarmas · `Ctrl+Alt+W` videowall
  (otro monitor) · `Ctrl+Alt+R` recargar · `Ctrl+Alt+F` pantalla completa.
- `Ctrl+Alt+A` acusar · `Ctrl+Alt+E` escalar · `Ctrl+Alt+↑/↓` anterior/siguiente
  (la web decide qué hacer con estos).

## Arquitectura (resumen)
- `main.js`: ciclo de vida, ventanas (splash/login/panel/popup), red (`net.fetch`
  con el cookie-jar de sesión), tray, hotkeys, auto-arranque, popup nativo.
- `preload.js`: puente seguro `window.eventosDesktop` (notify/open/alert/onHotkey/
  auth) + siembra del operario en localStorage para no re-pedir login.
- `preload-popup.js` + `ui/popup.html`: popup de alarma con sirena WebAudio.
- `ui/splash.html`, `ui/login.html`: pantallas nativas animadas.
- La web (EventOS) llama a `window.eventosDesktop.alert(evento)` en cada evento
  nuevo (prioridad ≤ 3) → dispara el popup nativo.

## Notas
- El servidor `EVENTOS` debe estar accesible desde la PC (misma red/VPN o dominio
  público). El login usa la cookie `eventos_sid` (sesión de 12 h).
- Para un puesto dedicado 24/7: dejar `kiosk:true` y el auto-arranque hace el resto.
