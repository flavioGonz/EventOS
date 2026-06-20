<div align="center">

# ⚡ EventOS · ARC

### Central Receptora de Alarmas (ARC) y Centro de Verificación en Vivo
<img width="1920" height="944" alt="image" src="https://github.com/user-attachments/assets/5378e6de-4828-4a5f-bd71-91715714ed81" />

*Recibí, verificá y despachá eventos de seguridad en tiempo real — cámaras, NVR, analíticas de IA, alarmas y control de accesos — desde una sola consola.*

`Node.js` · `Express` · `Socket.io` · `Redis` · `React` · `Vite` · `Leaflet` · `go2rtc` · `Hikvision ISAPI`

</div>

---

## 📑 Tabla de contenidos

- [¿Qué es EventOS?](#-qué-es-eventos)
- [Características](#-características)
- [Capturas](#-capturas)
- [Arquitectura](#-arquitectura)
- [Stack tecnológico](#-stack-tecnológico)
- [Estructura del repositorio](#-estructura-del-repositorio)
- [Puesta en marcha](#-puesta-en-marcha)
- [Configuración](#-configuración-variables-de-entorno)
- [Despliegue](#-despliegue)
- [Seguridad](#-seguridad)
- [Roadmap](#-roadmap)

---

## 🎯 ¿Qué es EventOS?

**EventOS** es una **central receptora de alarmas (ARC)** moderna, inspirada en plataformas tipo HikCentral pero pensada para operación ágil: el foco es que el operario **verifique y accione un evento en segundos**.

Recibe eventos en vivo de **cámaras y NVR Hikvision** (cruce de línea, intrusión de zona, rostro, ANPR, sabotaje…), los **filtra con IA** (persona / vehículo) para recortar falsas alarmas, los reparte entre los operadores según reglas de **despacho**, y le da al operador un **Centro de Verificación** con video en vivo, foto del momento, analíticas dibujadas sobre la imagen, protocolo de actuación y un toque para llamar/abrir puertas.

> **Caso real en producción:** sitio *Cesimco* con 2 NVR Hikvision DS-9632NI-I16 y ~57 cámaras, operadores conectados en vivo.

---

## ✨ Características

### 🖥️ Consola del operador
Pantalla completa con **mapa operativo (GIS)** y **board tipo kanban por criticidad (P1–P5)**. Los eventos entran en vivo por WebSocket, con alerta sonora, SLA con cuenta regresiva y auto-escalado.

<!-- 📸 docs/img/consola-board.png -->
![Board de eventos](docs/img/consola-board.png)

<!-- 📸 docs/img/mapa.png -->
![Mapa operativo](docs/img/mapa.png)

### 🔎 Centro de Verificación en Vivo (popup)
El corazón de la operación. Al abrir un evento, el operador ve:
- **Video** del evento: foto del momento (evidencia), **vivo** y **grabación**.
- **Galería de fotos del caso** + captura on-demand + descarga.
- **Analíticas dibujadas sobre la imagen** (línea de cruce / zona de intrusión).
- **Panel de respuesta**: protocolo de actuación, lista de llamada priorizada, parlantes SIP y escalación a emergencias.
- **Atajos de teclado** (T=Tomar · A=Acuse · P=En curso · E=Escalar · Esc) y barra de acciones fija para resolver rápido.

<!-- 📸 docs/img/popup.png -->
![Centro de Verificación](docs/img/popup.png)

### ⚖️ Despacho y balanceo
Reparto de eventos entre operadores: **simultáneo**, **secuencial** (round-robin / menos cargado) o **por reglas**. Tiempos de ack, reasignación, máximo concurrente, enrutado por competencia y grupos de operadores.

<!-- 📸 docs/img/balanceo.png -->
![Balanceo](docs/img/balanceo.png)

### 📷 Dispositivos (cámaras, NVR, alarmas)
Alta **por fabricante** (Hikvision, Dahua, Akuvox, parlante/intercom SIP, ONVIF) que preconfigura puertos y endpoints. Lista **agrupada por NVR** con sus canales desplegables. Descubrimiento automático por **ISAPI** y **ONVIF**. Configuración de **alertas por dispositivo** (qué eventos alertan, prioridad, filtro por objetivo, horario) y **relés / puertas**.

<!-- 📸 docs/img/dispositivos.png -->
![Dispositivos](docs/img/dispositivos.png)

### 🎥 Video en vivo
Pipeline robusto: **RTSP directo a cada cámara** (vía VPN) servido por **go2rtc** (WebRTC/MSE), con caída elegante a **MJPEG** (snapshots ISAPI) cuando el stream del NVR llega corrupto. Snapshots near-live en las rejillas y vivo real al abrir una cámara.

### 🧠 Filtrado de IA (AcuSense / DeepinView)
Clasificación **humano / vehículo** del objetivo para descartar falsas alarmas, con filtro por objetivo en reglas y por dispositivo. Dimensión **"Objetivo (IA)"** en la analítica para ver cobertura de clasificación.

### 🗂️ Evidencias
Foto del momento por evento, **galería por caso**, captura on-demand y **política de retención** automática.

### 📈 Flujos (Caudal forense)
Analítica de volumen de eventos en el tiempo, por prioridad, tipo, sitio, cámara y objetivo IA — para detectar picos y cámaras ruidosas.

<!-- 📸 docs/img/flujos.png -->
![Flujos](docs/img/flujos.png)

### 🔌 Alarmas y control de accesos
Integración de **paneles de alarma Hikvision AX** y **control de relés** para **abrir puertas** (relé IP), con confirmación del operador. Recepción de eventos por **webhook HTTP** o **alertStream ISAPI**.

---

## 🖼️ Capturas

> Reemplazá estos espacios con capturas reales (PNG, ~1600px de ancho, en `docs/img/`).

| | |
|---|---|
| ![](docs/img/cap-1.png) | ![](docs/img/cap-2.png) |
| ![](docs/img/cap-3.png) | ![](docs/img/cap-4.png) |

<!-- 📸 Tema claro y oscuro lado a lado → docs/img/tema-claro-oscuro.png -->

---

## 🏗️ Arquitectura

<!-- 📸 docs/img/arquitectura.png -->
![Arquitectura](docs/img/arquitectura.png)

```
   NVR / Camaras Hikvision            Paneles AX / Reles IP
   (ISAPI - alertStream - RTSP)       (ISAPI SecurityCP - webhook)
            |                                   |
            v                                   v
   +------------------------------------------------------+
   |                  EventOS - Backend                    |
   |  Express (HTTP/API) - Socket.io (tiempo real) - Redis |
   |  ingest -> normalize -> reglas -> dispatch -> socket  |
   |  alertStream (pull ISAPI) - go2rtc (video) - evidencia|
   +------------------------------------------------------+
            | WebSocket + REST                  | HLS/MJPEG/WebRTC
            v                                   v
   +------------------------------------------------------+
   |             EventOS - Frontend (React/Vite)           |
   |   Consola operador - Centro de verificacion - Admin   |
   +------------------------------------------------------+
```

**Flujo de un evento:** el NVR empuja por `alertStream` → `ingest` normaliza (mapa de tipos Hikvision/Akuvox/alarma) → `reglas` asignan prioridad/procedimiento y filtran falsas (IA) → `dispatch` elige operador(es) → `bus` (Redis) publica → `socket` emite a la consola y enruta. La evidencia (foto ISAPI) se guarda por evento.

---

## 🧰 Stack tecnológico

**Backend:** Node.js · Express · Socket.io · Redis · go2rtc (binario) · ffmpeg
**Frontend:** React · Vite · React Router · Leaflet (mapas) · hls.js
**Protocolos / integraciones:** Hikvision **ISAPI** (alertStream, Smart, IO/SecurityCP, snapshot), **ONVIF** (Perfil S/M), RTSP, SIP/tel:, webhooks
**Infra:** LXC (Proxmox) · nginx (proxy + SPA) · systemd

---

## 📂 Estructura del repositorio

```
EventOS/
├── server/                 # Backend (Express + Socket.io)
│   └── src/
│       ├── http/           # api.js · admin.js · ingest.js   (REST + webhooks)
│       ├── ingest/         # alertStream.js                  (pull ISAPI Hikvision)
│       ├── events/         # normalize.js · catalog.js       (normalizacion + catalogo)
│       ├── rules/          # engine.js · defaults.js         (reglas + prioridad)
│       ├── dispatch/       # engine.js · pipeline.js · store  (reparto + persistencia)
│       ├── discovery/      # hikvision.js · onvif.js          (descubrimiento)
│       ├── playback/       # hls.js                           (RTSP->HLS transcode)
│       ├── alerts/         # policy.js                        (alertado por dispositivo)
│       ├── socket/         # console.js                       (tiempo real)
│       └── util/           # digestFetch.js                   (ISAPI digest)
│   └── data/               # datos + secretos (NO versionado)
├── web/                    # Frontend (React + Vite)
│   └── src/
│       ├── admin/          # Paginas del panel de administracion
│       ├── components/     # Consola, popup, video, mapa, etc.
│       ├── ui/             # primitives, tokens (theme), shell
│       └── lib/            # adminApi, formato, etc.
├── deploy/                 # Scripts de despliegue + .env.example
└── docs/img/               # Capturas para este README
```

---

## 🚀 Puesta en marcha

> Requisitos: Node.js 18+, Redis, ffmpeg y go2rtc (para video).

```bash
# Backend
cd server
npm install
cp ../deploy/.env.example .env     # completar credenciales/tokens
npm start                          # escucha en 127.0.0.1:4010

# Frontend
cd ../web
npm install
npm run dev                        # desarrollo (Vite)
npm run build                      # produccion -> web/dist (servido por nginx)
```

---

## ⚙️ Configuración (variables de entorno)

| Variable | Descripción |
|---|---|
| `ADMIN_TOKEN` | Token del panel de administración (`/api/admin/*`). Si no se define, queda abierto (modo dev). |
| `INGEST_TOKEN` | Token para los webhooks de ingesta (`/api/ingest/*`). |
| `EVENTOS_ALERTSTREAM` | `1` para activar la recepción en vivo desde los NVR. |
| `EVENTOS_MAX_HLS` | Máximo de sesiones HLS simultáneas. |
| `EVENTOS_MJPEG_CONCURRENCY` | Fetches de snapshot en paralelo para MJPEG. |

> Las **credenciales de cada dispositivo** (NVR/cámara) se guardan en su ficha (no en variables de entorno) y nunca viajan en la URL.

---

## 📦 Despliegue

El frontend es estático (`web/dist`) servido por **nginx**, que también hace proxy al backend (`eventos-api`, systemd) y a **go2rtc**. Un cambio de solo-frontend se publica con `vite build` + `nginx -s reload` **sin reiniciar el backend** (los operadores no se desconectan). Los cambios de backend requieren reiniciar `eventos-api`.

```bash
# Solo frontend (sin cortar operadores)
cd web && npm run build && nginx -s reload
# Backend (reinicia el servicio)
systemctl restart eventos-api
```

---

## 🔒 Seguridad

- **No se versionan secretos ni datos**: `server/data/` (config con credenciales, eventos, evidencia, logs) está en `.gitignore`.
- Las credenciales de dispositivos se almacenan server-side y se usan para componer RTSP/snapshot; **nunca** se exponen al cliente ni van en URLs.
- El control de relé / apertura de puerta es una **acción física**: requiere **confirmación explícita del operador**.
- Tokens de admin/ingesta por variables de entorno.

---

## 🗺️ Roadmap

- [x] Recepción de eventos en vivo (Hikvision alertStream)
- [x] Filtrado IA humano/vehículo + analítica de objetivo
- [x] Video en vivo (RTSP directo / go2rtc / MJPEG fallback)
- [x] Evidencias: galería por caso + retención
- [x] Mapa operativo GIS · Despacho/balanceo · Grupos
- [x] Control de relé / apertura de puertas (Hikvision IO / AX)
- [x] Alta de dispositivo por fabricante
- [ ] Recepción de eventos de paneles **AX** (webhook / alertStream ISAPI)
- [ ] Tipo de dispositivo **parlante SIP** dedicado
- [ ] Más fabricantes (Dahua, etc.)
- [ ] Video de cámaras *fisheye* (decodificación en navegador)

---

<div align="center">
<sub>EventOS · ARC — central receptora de alarmas y verificación en vivo.</sub>
</div>
