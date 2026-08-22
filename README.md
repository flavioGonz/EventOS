<div align="center">

# ⚡ EventOS · ARC

### Central Receptora de Alarmas (ARC) y Centro de Verificación en Vivo
<img width="1920" height="944" alt="image" src="https://github.com/user-attachments/assets/5378e6de-4828-4a5f-bd71-91715714ed81" />

*Recibí, verificá y despachá eventos de seguridad en tiempo real — de cualquier marca, desde una sola consola.*

`Node.js` · `Express` · `Socket.io` · `Redis` · `PostgreSQL` · `React` · `Vite` · `Leaflet` · `go2rtc` · `multi-marca`

**Versión 1.5.2**

</div>

---

## 📑 Tabla de contenidos

- [¿Qué es EventOS?](#-qué-es-eventos)
- [Modelo multi-marca](#-modelo-multi-marca)
- [Características](#-características)
- [Capturas](#-capturas)
- [Arquitectura](#-arquitectura)
- [Stack tecnológico](#-stack-tecnológico)
- [Kit ISAPI (catálogo Hikvision)](#-kit-isapi--el-catálogo-hikvision)
- [Estructura del repositorio](#-estructura-del-repositorio)
- [Puesta en marcha](#-puesta-en-marcha)
- [Configuración](#-configuración-variables-de-entorno)
- [Despliegue](#-despliegue)
- [Seguridad](#-seguridad)
- [Roadmap](#-roadmap)

---

## 🎯 ¿Qué es EventOS?

**EventOS** es una **central receptora de alarmas (ARC)** moderna, inspirada en plataformas tipo HikCentral pero pensada para operación ágil: el foco es que el operario **verifique y accione un evento en segundos**.

Es **multi-marca y multi-cliente por diseño**: cada fabricante entra como un *adaptador* que traduce su formato al **modelo canónico de evento**; todo lo que viene después — prioridad, reglas, despacho, consola, evidencia — es agnóstico de marca. Hoy el adaptador más completo es Hikvision, pero el núcleo no sabe de Hikvision.

Recibe eventos en vivo (cruce de línea, intrusión de zona, rostro, ANPR, sabotaje, zonas de panel de alarma, puertas…), los **filtra con IA** (persona / vehículo) para recortar falsas alarmas, los reparte entre los operadores según reglas de **despacho**, y le da al operador un **Centro de Verificación** con video en vivo, foto del momento, la zona exacta que disparó dibujada sobre la imagen, protocolo de actuación y un toque para llamar/abrir puertas.

> **Caso real en producción:** sitio *Cesimco* con 2 NVR Hikvision DS-9632NI-I16 y 58 canales, operadores conectados en vivo.

---

## 🧩 Modelo multi-marca

Agregar un fabricante **no toca el núcleo**. Un adaptador sólo tiene que hacer dos cosas:

**1 · Traducir su evento al catálogo canónico.** Un normalizer por marca en
`events/normalize.js` mapea el tipo propietario al catálogo de
[`events/catalog.js`](server/src/events/catalog.js) (`line_crossing`, `intrusion`,
`door_forced`, `alarm`…), que define categoría, prioridad y título. Ya existen
`hikvision`, `akuvox`, `nvr`, `alarm` y `generic`.

**2 · Declarar qué punto disparó.** Todo equipo de ARC manda un identificador
opaco que el operario no entiende: Hikvision manda `regionID 1`, un panel manda
`zona 3`, un control de acceso manda `puerta 2`. El adaptador sólo deja
`pointKind` + `pointId` **canónicos** y el núcleo los traduce a un nombre humano:

| marca | manda | kind canónico | el operario ve |
|---|---|---|---|
| Hikvision | `regionID 1` + `fielddetection` | `region:1` | «Carga · zona» |
| Panel de alarma | `zona 3` | `zone:3` | «Cocina — ventana» |
| Control de acceso | `puerta 2` | `door:2` | «Portón de servicio» |

El registro vive en [`events/points.js`](server/src/events/points.js) e **indexa por
`deviceId` de EventOS** — identidad propia, única entre clientes y marcas. Nunca
por convenciones del fabricante (puerto, slug de NVR, nº de canal), que colisionan
apenas entra el segundo cliente.

**Regla de oro:** si el punto no se puede resolver sin ambigüedad, se devuelve
`null` y se cae al comportamiento anterior. En un ARC un nombre equivocado manda
un operario al domicilio equivocado: vale más no nombrar que nombrar mal.

Además del nombre, el evento lleva la **geometría** del punto
(`event.point.geometry`), para que el popup pinte exactamente la línea o el
polígono que disparó — no todas las reglas de la cámara.

> ⚠️ **Aislamiento entre clientes.** La resolución de cámara filtra **siempre por
> sitio** antes de desempatar por tags. Los tags de fabricante (p. ej. `nvr:srv2`,
> derivado del puerto ISAPI) **no son únicos entre clientes**: dos sitios con un NVR
> en `:82` comparten el tag.

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
- **Video** del evento en una **superficie tipo reproductor** (edge-to-edge, controles flotantes): foto del momento (evidencia), **muro de cámaras en vivo** y **grabación** con línea de tiempo y eventos marcados con iconos.
- **Galería de fotos del caso** + captura on-demand + descarga.
- **La zona exacta que disparó**, dibujada sobre la imagen (línea de cruce / zona de intrusión), con su nombre real — «Carga · zona», no «Región 1».
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

**Grabación / playback:** las cámaras graban en **H.264+**, cuyo RTSP de reproducción es indecodificable para reproductores estándar. EventOS recupera el playback bajando el segmento por **ISAPI ContentMgmt** (MPEG-PS limpio) y sirviéndolo como HLS; con archivos de grabación cortos en el NVR el **seek** cae al instante pedido, con corrección automática de la **zona horaria** del equipo.

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

### 🪪 Badge de acceso en vivo (v1.5.1)
Cuando el operador está verificando un evento, si ese cliente tiene **porteros Akuvox**, cada lectura de acceso **concedido** (tarjeta / PIN / rostro / QR) aparece como un **badge animado y efímero** sobre el video en vivo — en el **popup** y en el **videowall** — mostrando el **nombre del usuario** que entró y por qué método. Las lecturas concedidas **no** son alarmas: no entran a la cola, se empujan por socket (`access:read`) como overlay DOM que **no toca el `<video>`** ni el pipeline de video, y se registran en PostgreSQL (`access_reads`) para auditoría (el PIN se enmascara). El diseño es **agnóstico de marca** — un objeto canónico `AccessRead` con adaptador por fabricante — listo para sumar otros porteros (Hikvision, etc.) sin tocar el badge.

**Toggle por portero / cliente (v1.5.2):** el badge se puede mostrar u ocultar por **portero** (ficha del equipo → «Mostrar / Ocultar / Heredar del cliente») con *fallback* al **default del cliente/sitio** (ficha del sitio); activo por defecto. El toggle **sólo** controla el aviso visual: la lectura **siempre se registra** en `access_reads` para auditoría.

### 📲 PWA instalable por rol
Dos apps instalables desde un mismo código: **EventOS · Operador** (abre al Centro de alarmas) y **EventOS · Supervisor** (panel de supervisión + videowall). Ventana propia, sonido de alarma, *offline-shell* y **auto-update** desde el servidor (service worker). Página `/instalar` para instalar con un clic según el rol.

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

**Flujo de un evento:** el equipo empuja (`alertStream` ISAPI, webhook o el transporte de su marca) → `ingest` **normaliza** al modelo canónico con el adaptador del fabricante → el núcleo **resuelve el punto** (`points.js`: `region:1` → «Carga · zona» + geometría) → `reglas` asignan prioridad/procedimiento y filtran falsas (IA) → `dispatch` elige operador(es) → `bus` (Redis) publica → `socket` emite a la consola. La evidencia (foto del momento) se guarda por evento.

---

## 🧰 Stack tecnológico

**Backend:** Node.js · Express · Socket.io · Redis · **PostgreSQL** (persistencia durable) · go2rtc (binario) · ffmpeg
**Frontend:** React · Vite · React Router · Leaflet (mapas) · hls.js
**Protocolos / integraciones:** Hikvision **ISAPI** (alertStream, Smart, IO/SecurityCP, snapshot, ContentMgmt), **ONVIF** (Perfil S/M), RTSP, SIP/tel:, webhooks genéricos
**Infra:** LXC (Proxmox) · nginx (proxy + SPA) · systemd

---

## 🗄️ Persistencia (PostgreSQL)

Desde **v1.5.0** EventOS suma una capa de persistencia durable en **PostgreSQL**, montada
de forma **incremental y tolerante**: la caché en memoria sigue siendo la fuente de lectura
síncrona (cero cambios aguas abajo) y PG es el respaldo durable con **escritura dual** +
hidratación al arranque. **Si PG no está o cae, el server sigue funcionando con memoria/JSON.**

- **Eventos** — tabla `events` (jsonb + columnas indexadas ts/status/site/device). Historial
  paginado por keyset: `GET /api/events/history`. Las vistas pesadas (**Escaladas**,
  **Evidencias**) paginan desde PG con scroll infinito en vez de cargar miles en memoria →
  resuelve los cuelgues por tormentas de alarmas.
- **Inventario / config** — tablas `config_items` (una fila por device/site/operator/… ) y
  `config_kv` (dispatch/video/evidence). Escritura por-item; reconstrucción de la caché
  desde PG al boot.
- **Cola en vivo** — se rehidrata desde PG al arrancar (merge add-only, no pisa lo que llega
  en vivo); `events.json` queda como espejo.
- **Sesiones** — la cookie de operador se persiste en la tabla `sessions` → **sobreviven a un
  reinicio del server** (el operario no re-loguea).
- **Accesos concedidos** — tabla `access_reads` (lecturas de tag/PIN/rostro/QR de porteros)
  para el badge en vivo y auditoría; keyset para una futura pestaña de accesos.
- **Backups** — `pg_dump` nocturno comprimido (systemd timer, retención 14 días).

`DATABASE_URL` en `/etc/eventos/eventos.env` activa PG; sin esa variable, arranca en modo
memoria/JSON como antes.

### Fiabilidad de recepción (no perder alarmas)

- **Watchdog de inactividad** en los alertStream de NVR y de paneles AX: una conexión
  "medio-abierta" (el equipo acepta el TCP pero deja de emitir) se detecta por ausencia de
  datos y se reconecta — antes se colgaba en silencio y se perdían alarmas.
- **Deduplicación de tormentas**: los duplicados recientes del mismo equipo/tipo se colapsan
  en un único incidente vivo con contador (`dupCount`), en todos los caminos de ingesta
  (webhook push incluido) — evita 40 filas por una sola puerta abierta.
- **Snapshot diferido**: si el evento llega sin foto, se emite al instante y la captura ISAPI
  se adjunta después por `event:update` — no retrasa la recepción bajo tormenta.
- **Timeout de descarga** de playback (ContentMgmt): un NVR que acepta el socket pero no
  responde ya no cuelga la request indefinidamente.
- **Re-despacho tras hidratar PG**: al arrancar, los eventos recuperados desde PostgreSQL que
  quedaron apropiados por operarios sin conexión se devuelven a la cola y se re-enrutan.

---

## 📚 Kit ISAPI — el catálogo Hikvision

Integrar una marca a ciegas es caro. Para Hikvision, `isapi/` tiene la superficie
completa **generada** desde los manuales oficiales — no escrita a mano, por eso se
regenera cuando salgan manuales nuevos.

| | |
|---|---|
| **941 endpoints** catalogados | 834 con schema formal + 107 que los manuales sólo mencionan en prosa |
| **5 specs OpenAPI 3.1** | uno por familia (DeepinView, Value, DVR Pro/Value, ANPR), los cinco validados |
| **1.257 schemas** | request/response completos, con `readOnly`, `required`, rangos, unidades y enums |
| **2.269 códigos de error** · **1.954 valores de enum** | extraídos de `ErrorCode.xlsx` y `Field Dictionary.xlsx` |
| **458 endpoints verificados en campo** | contra los DS-9632NI reales: qué soporta el firmware y qué devuelve `notSupport` |

Cada operación lleva `x-hik-source` con documento, sección y **página** del PDF, así
que siempre se puede volver a la fuente.

```bash
python3 isapi/tools/hik.py find intrusion detection
python3 isapi/tools/hik.py show PUT /ISAPI/Smart/FieldDetection/{channelID}
python3 isapi/tools/hik.py verified            # qué soporta CADA equipo probado
cd isapi/openapi && python3 -m http.server 8080   # Swagger UI
```

### Herramientas

| Script | Qué hace |
|---|---|
| `hik.py` | consulta el catálogo (endpoints, schemas, errores, enums) |
| `hik-verify.py` | sondea el catálogo contra un equipo real — **sólo GET**, autocontenido |
| `hik-audit.py` | audita canal por canal: qué analítica soporta y qué reglas tiene dibujadas |
| `build_points.py` | de la auditoría al registro de puntos indexado por `deviceId` |
| `make all` | regenera todo el catálogo desde los PDFs |

> **Gotcha que costó un barrido:** estos NVR cortan con `401` tras unas **88
> autenticaciones digest nuevas**. Hay que pedir el reto **una vez** y reusarlo con
> `nc` incremental — es lo que hacen `util/digestFetch.js` y las herramientas de
> `isapi/tools/`. Un cliente que pide un reto por request muere en la sonda 89.

La skill [`skills/hikvision/`](skills/hikvision) empaqueta todo esto como
conocimiento reutilizable, incluidas las lecciones de campo.

---

## 📂 Estructura del repositorio

```
EventOS/
├── server/                 # Backend (Express + Socket.io)
│   └── src/
│       ├── http/           # api.js · admin.js · ingest.js   (REST + webhooks)
│       ├── ingest/         # alertStream.js                  (pull ISAPI Hikvision)
│       ├── events/         # normalize.js · catalog.js       (adaptadores + catálogo canónico)
│       │                   # points.js                       (registro de puntos, vendor-neutral)
│       ├── rules/          # engine.js · defaults.js         (reglas + prioridad)
│       ├── dispatch/       # engine.js · pipeline.js · store  (reparto + persistencia)
│       ├── discovery/      # hikvision.js · onvif.js          (descubrimiento)
│       ├── playback/       # hls.js · contentmgmt.js          (grabación: HLS + descarga ISAPI)
│       ├── evidence/       # galería de fotos por caso + retención
│       ├── alerts/         # policy.js                        (alertado por dispositivo)
│       ├── socket/         # console.js                       (tiempo real)
│       ├── bus/            # redisBus.js                      (pub/sub entre procesos)
│       ├── auth/           # pin.js                           (PIN de operador)
│       ├── config/         # store.js                         (sitios, dispositivos, reglas)
│       ├── simulator/      # generador de eventos de prueba
│       └── util/           # digestFetch.js                   (ISAPI digest reusando el reto)
│   └── data/               # datos + secretos + points.json   (NO versionado)
├── web/                    # Frontend (React + Vite)
│   └── src/
│       ├── admin/          # Páginas del panel de administración
│       ├── components/     # Consola, popup, video, mapa, etc.
│       ├── ui/             # primitives, tokens (theme), shell
│       └── lib/            # adminApi, formato, video-rtc, etc.
├── isapi/                  # Kit Hikvision
│   ├── openapi/            # 5 specs OpenAPI 3.1 + catálogo (JSON/SQLite) + Swagger UI
│   ├── tools/              # pipeline de generación, verificación, auditoría y despliegue
│   ├── reports/            # salidas de verificación/auditoría (NO versionado: datos de cliente)
│   └── *.pdf               # manuales oficiales (fuente del catálogo)
├── skills/                 # Conocimiento reutilizable (hikvision, …)
├── desktop/                # Envoltorio Electron (app de escritorio)
├── deploy/                 # Scripts de despliegue + .env.example
├── docs/                   # HIKVISION.md · img/
└── CONTRACT*.md            # Contratos de API entre backend y frontend
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

Para desplegar desde Windows al contenedor hay scripts de **un comando** en
`isapi/tools/` que hacen backup, `chmod a+rX` (sin eso el usuario `eventos` no
puede leer los archivos y la API entra en crash-loop), **`node --check` antes de
tocar el servicio** y verificación posterior, e imprimen la línea de rollback:

```powershell
powershell -ExecutionPolicy Bypass -File isapi\tools\deploy-points.ps1
```

> `server/data/` no se versiona, así que `points.json` se **genera en el propio
> contenedor** a partir de `zones-raw.json` + `eventos.config.json`. Como es sólo
> datos, regenerarlo **no requiere reiniciar** — el registro relee el archivo cada minuto.

---

## 🔒 Seguridad

- **No se versionan secretos ni datos**: `server/data/` (config con credenciales, eventos, evidencia, logs) está en `.gitignore`.
- Las credenciales de dispositivos se almacenan server-side y se usan para componer RTSP/snapshot; **nunca** se exponen al cliente ni van en URLs.
- **Cifrado en reposo** (v1.5.0): las contraseñas de equipos se guardan cifradas (**AES-256-GCM**) tanto en PostgreSQL como en el JSON de config. La clave vive en `ENC_KEY` (env); la caché en memoria queda en claro para los adaptadores. Retro-compatible: sin `ENC_KEY` funciona en texto plano como antes, y descifrar tolera valores viejos sin cifrar. ⚠️ Si se pierde `ENC_KEY`, los valores cifrados son irrecuperables — respaldá `eventos.env`.
- **Endpoints protegidos**: la cola en vivo (`/api/events`), el historial (`/api/events/history`), la metadata/captura de evidencia, los **datos de cliente/inventario** (`/sites`, `/client`, `/clientGroups`, `/operators`, `/groups`, `/camera/:id/info`, `/device/:id/logs`) y la **gestión de usuarios del portero** (`akuvox-user/-users/-raw/-face`) exigen sesión de operador (cookie) **o** `X-Admin-Token`. La provisión de credenciales en el portero exige además rol **supervisor/admin**. Las fotos (`/api/evidence/:file`) y el `/roster` del login siguen públicos.
- **Fail-closed de administración**: en producción, si falta `ADMIN_TOKEN` el server **aborta el arranque** en vez de dejar `/api/admin` abierto (override sólo con `ALLOW_OPEN_ADMIN=1` para pruebas). `EVENTOS_SOCKET_OPEN=1` se **ignora** en producción.
- **Rate limiting** anti fuerza-bruta en `/auth/login` (por IP y por IP+usuario) y en intentos fallidos del token de ingesta.
- **Token de admin en el cliente**: vive en `sessionStorage` (se borra al cerrar la pestaña), nunca en `localStorage`; migración transparente que purga cualquier copia persistente vieja.
- **Robustez de la consola (Error Boundary)**: un render que lance (evento malformado, payload inesperado) ya **no** deja la pantalla en blanco — se aísla con opción de reintentar; el popup de evento tiene su propio límite, así un evento roto no ciega la consola.
- **TLS**: el instalador ofrece HTTPS (Let's Encrypt) por defecto y fija `SESSION_SECURE=1`; la cookie de sesión es `Secure` detrás de un proxy HTTPS.
- El control de relé / apertura de puerta es una **acción física**: requiere **confirmación explícita del operador**. Cada apertura se registra en una **bitácora de auditoría durable** (`audit_log`: quién —de la sesión, nunca del body—, qué equipo, salida, resultado, IP) para no-repudio.
- **Autorización por evento en el socket**: un operario sólo puede accionar (tomar/ack/en curso/nota/resolver/escalar/transferir/llamar) sobre eventos **libres o propios**; los ajenos sólo los toca un **supervisor/admin**. La sesión se **revalida en vivo** en cada acción y en el heartbeat: si se cerró sesión o venció, el socket se desconecta.
- Tokens de admin/ingesta por variables de entorno.
- **Aislamiento entre clientes:** la resolución de dispositivo filtra por sitio antes de desempatar por tags de fabricante, que no son únicos entre clientes.
- Los datos de campo (`isapi/reports/`, `server/data/`) **no se versionan**: llevan nombres de cámara, IPs y topología de cliente.

---

## 🗺️ Roadmap

- [x] Recepción de eventos en vivo (Hikvision alertStream)
- [x] Filtrado IA humano/vehículo + analítica de objetivo
- [x] Video en vivo (RTSP directo / go2rtc / MJPEG fallback)
- [x] Grabación: playback + descarga de clip (ContentMgmt, H.264+ recuperable)
- [x] Evidencias: galería por caso + retención
- [x] Mapa operativo GIS · Despacho/balanceo · Grupos
- [x] Control de relé / apertura de puertas (Hikvision IO / AX)
- [x] Alta de dispositivo por fabricante
- [x] **Centro de alarmas** (vista única tipo HikCentral) con beep y cola de escaladas
- [x] **Playback H.264+ recuperado** vía ISAPI ContentMgmt (download → HLS) + seek por packing corto y zona horaria
- [x] **PWA instalable por rol** (operador / supervisor) con service worker y auto-update
- [x] **Videowall** pro: acciones por canal, doble-clic a pantalla completa, **visual tracking** (iconos de camaras vecinas sobre el video) y **descarga de clips MP4**
- [x] **Panel de supervisor** con visibilidad completa: eventos clicables (popup solo-lectura con video/evidencia/bitacora), bitacora por operario, feed de actividad y reasignacion a grupo
- [x] Catálogo ISAPI (941 endpoints) + verificación contra equipos reales
- [x] Registro de puntos vendor-neutral: el evento nombra la zona real que disparó
- [x] **Badge de acceso en vivo** (Akuvox): lectura de tag/PIN/rostro/QR concedido sobre el vivo (popup + videowall), efímero + histórico en `access_reads`, agnóstico de marca
- [ ] Pintar en el popup **sólo** la zona que disparó (ya viaja en `event.point.geometry`)
- [ ] Armado horario: leer `/ISAPI/Event/schedules/*` para detectar agujeros de cobertura nocturna
- [ ] Audio bidireccional (disuasión por voz desde el popup) — verificado disponible en los NVR
- [ ] PTZ a preset ante evento
- [ ] Recepción de eventos de paneles **AX** (webhook / alertStream ISAPI)
- [ ] Tipo de dispositivo **parlante SIP** dedicado
- [ ] Más fabricantes (Dahua, etc.) — vía adaptador, sin tocar el núcleo
- [ ] Adaptador de acceso **Hikvision** (`AccessControllerEvent` → mismo modelo `AccessRead`) + foto del acceso en **MinIO/S3**
- [ ] Video de cámaras *fisheye* (decodificación en navegador)

---

<div align="center">
<sub>EventOS · ARC — central receptora de alarmas y verificación en vivo.</sub>
</div>
