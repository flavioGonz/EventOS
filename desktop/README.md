# EventOS · ARC — Consola de escritorio (Electron)

Shell de escritorio que envuelve la web de EventOS en una app nativa para la estación del operador. **No reescribe la web**: la carga desde el servidor (`config.json → url`) y toma las nuevas versiones al recargar.

## Qué aporta sobre el navegador / PWA

- **Decode de video por HARDWARE forzado (GPU)** — flags de Chromium que el navegador no deja tocar: `ignore-gpu-blocklist`, `enable-accelerated-video-decode`, `enable-zero-copy`, `use-angle=d3d11` (Windows). Clave para el videowall con muchas cámaras (D3D11VA / NVDEC / QSV). Verificá en la bandeja → *Diagnóstico GPU (chrome://gpu)*.
- **Audio de alarma sin bloqueo de autoplay** (`autoplay-policy=no-user-gesture-required`): el beep suena sin necesidad de un clic previo.
- **Multi-monitor**: abre Consola / Centro / Videowall / Tabla desacoplada en monitores distintos. Las ventanas de fondo **no se frenan** (`backgroundThrottling:false`), así el video/socket siguen vivos en otros monitores.
- **Bandeja del sistema** (sigue corriendo aunque cierres las ventanas), **instancia única**, **wake-lock** (no se apaga la pantalla).
- **Hotkeys globales** (funcionan aunque otra app tenga el foco).
- **Notificaciones nativas** del SO para alarmas (la web las usa si está disponible `window.eventosDesktop`).

## Hotkeys globales

| Atajo | Acción |
|---|---|
| Ctrl+Alt+1 | Foco a la consola |
| Ctrl+Alt+C | Abrir Centro de alarmas |
| Ctrl+Alt+W | Videowall en otro monitor |
| Ctrl+Alt+T | Tabla desacoplada en otro monitor |
| Ctrl+Alt+R | Recargar todo |
| Ctrl+Alt+F | Pantalla completa (ventana activa) |
| Ctrl+Alt+A / E | Acusar / Escalar (la web debe engancharlos) |
| Ctrl+Alt+↑/↓ | Alarma anterior / siguiente |

## Configuración

Editá `config.json` (o `%APPDATA%/EventOS ARC/eventos-desktop.json` para sobrescribir sin reinstalar):

```json
{ "url": "http://172.26.20.247", "kiosk": false, "startMaximized": true }
```

- `url`: dónde está EventOS (servidor).
- `kiosk`: `true` = ventana bloqueada sin marco (estación dedicada, no se puede cerrar/salir salvo por bandeja).

## Probar (desarrollo)

```bash
cd desktop
npm install
npm start
```

## Generar instalador

- **Windows** (.exe NSIS): `npm run dist:win` → queda en `desktop/dist/`.
- **Linux** (AppImage): `npm run dist:linux`.

> El instalador Windows se genera mejor **en Windows** (electron-builder baja el runtime correcto). Reemplazá `assets/icon.png` por tu logo (≥512×512) antes de compilar si querés branding propio.

## Integración opcional con la web (hotkeys de acción)

La web puede detectar el desktop y reaccionar a los hotkeys globales:

```js
if (window.eventosDesktop?.isDesktop) {
  window.eventosDesktop.onHotkey((name) => {
    // name: 'ack' | 'escalate' | 'next' | 'prev'
  })
  // y notificaciones nativas:
  window.eventosDesktop.notify('Intrusión', 'Pasillo 03 · Cesimco')
}
```

Esto es opcional: el shell funciona sin tocar la web (ventana, GPU, multi-monitor, tray ya andan). Enganchar `onHotkey`/`notify` en EventOS es un agregado chico que se puede hacer después.
