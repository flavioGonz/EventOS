# EventOS — Contrato canónico (v1)

Centro de monitoreo / ARC. Recibe eventos de NVRs, cámaras, alarmas Hikvision, porteros
Akuvox, etc., los normaliza, los distribuye en tiempo real a los operarios del call center
y registra los procedimientos de acción.

> Este archivo es la **fuente de verdad** del MVP. El `server/`, el `web/` y el `deploy/`
> deben respetar exactamente estos nombres de eventos, rutas y formas de datos.

---

## 1. Evento canónico (Event)

Todo payload de cualquier fabricante se normaliza a esta forma antes de distribuirse:

```jsonc
{
  "id": "evt_3f9c…",                 // uuid v4 con prefijo evt_
  "ts": "2026-06-13T10:57:00.123Z",  // ISO 8601, momento de recepción en el server
  "deviceTs": "2026-06-13T10:56:59Z",// ISO, timestamp reportado por el dispositivo (opcional)
  "source": {
    "type": "hikvision",             // hikvision | akuvox | nvr | alarm | generic
    "vendor": "Hikvision",
    "deviceId": "DS-2CD-1234",
    "deviceName": "Cámara Acceso Norte",
    "channel": 1,                    // canal / puerta / zona (number|string, opcional)
    "ip": "192.168.99.50",
    "site": "Planta Central"         // sitio / cliente
  },
  "type": "line_crossing",           // ver catálogo §2
  "category": "video",               // video | access | intrusion | system
  "priority": 2,                     // 1 = crítico … 5 = informativo
  "title": "Cruce de línea",
  "message": "Cruce de línea detectado en Acceso Norte (canal 1)",
  "media": {
    "snapshotUrl": null,             // URL absoluta o null
    "clipUrl": null
  },
  "zone": "Acceso Norte",
  "procedureId": "proc_line_crossing", // procedimiento sugerido (ver §5), puede ser null
  "status": "new",                   // new | assigned | ack | in_progress | resolved | escalated
  "assignedTo": null,                // operatorId | null
  "disposition": null,               // al resolver: real | false_alarm | test | no_action
  "log": [                           // bitácora append-only
    { "ts": "…", "operatorId": "op_1", "operatorName": "Ana", "action": "claim", "note": "" }
  ],
  "raw": { }                         // payload original del fabricante (para auditoría)
}
```

### Acciones de bitácora (`log[].action`)
`receive` · `assign` · `claim` · `ack` · `note` · `in_progress` · `resolve` · `escalate`

---

## 2. Catálogo de tipos de evento

| type            | category  | priority por defecto | title             |
|-----------------|-----------|----------------------|-------------------|
| `line_crossing` | video     | 2 | Cruce de línea                       |
| `intrusion`     | intrusion | 1 | Intrusión detectada                  |
| `motion`        | video     | 4 | Movimiento                           |
| `face`          | video     | 3 | Detección de rostro                  |
| `lpr`           | video     | 3 | Matrícula (LPR)                      |
| `tamper`        | system    | 2 | Sabotaje de cámara                   |
| `video_loss`    | system    | 2 | Pérdida de video                     |
| `doorbell`      | access    | 3 | Llamada de portero                   |
| `door_forced`   | access    | 1 | Puerta forzada                       |
| `door_held`     | access    | 3 | Puerta mantenida abierta             |
| `access_denied` | access    | 4 | Acceso denegado                      |
| `alarm`         | intrusion | 1 | Alarma de pánico/intrusión           |
| `tamper_alarm`  | intrusion | 2 | Tamper de central de alarma          |
| `system`        | system    | 5 | Evento de sistema                    |

La prioridad puede ser sobre-escrita por reglas (§5) o por el payload entrante.

---

## 3. API HTTP (Express)

Base: el server escucha en `127.0.0.1:$PORT` (nginx hace el proxy). Prefijo `/api`.

### Salud y meta
- `GET  /api/health` → `{ ok: true, uptime, redis: "connected"|"memory", operators, queue }`

### Ingesta (webhooks de dispositivos)
Auth: header `X-Ingest-Token: $INGEST_TOKEN` **o** query `?token=…`. Si no coincide → `401`.
Cada endpoint acepta el payload nativo del fabricante, lo normaliza y devuelve el Event creado.

- `POST /api/ingest/hikvision`  — Hik ISAPI / notificación de alarma (JSON o XML simplificado a JSON)
- `POST /api/ingest/akuvox`     — Akuvox (llamada de portero, apertura de puerta)
- `POST /api/ingest/nvr`        — NVR genérico (canal + tipo)
- `POST /api/ingest/alarm`      — central de alarmas (zona + tipo)
- `POST /api/ingest/generic`    — ya viene casi-canónico (para integraciones nuevas)

Respuesta: `201 { event }`.

### Consulta de eventos
- `GET  /api/events?status=&limit=50` → `{ events: Event[] }` (más recientes primero)
- `GET  /api/events/:id` → `{ event }`

### Operarios
- `GET  /api/operators` → `{ operators: Operator[] }`

### Simulador (para demo / pruebas de carga)
- `POST /api/sim/burst`  body `{ count?: 5 }` → genera N eventos aleatorios realistas
- `POST /api/sim/start`  body `{ everyMs?: 4000 }` → arranca flujo continuo
- `POST /api/sim/stop`   → detiene el flujo

Todas las rutas de ingesta y simulador comparten el mismo pipeline:
**normalizar → aplicar reglas → persistir → publicar en bus → emitir por socket**.

---

## 4. Protocolo Socket.io

Namespace: **`/console`**. Path por defecto `/socket.io` (nginx hace upgrade WebSocket).

### Cliente → Servidor
| evento            | payload                                   | efecto |
|-------------------|-------------------------------------------|--------|
| `operator:hello`  | `{ operatorId, name, skills?: string[] }` | registra/identifica al operario, recibe snapshot de cola |
| `event:claim`     | `{ eventId }`                             | el operario toma el evento (status→assigned/ack) |
| `event:ack`       | `{ eventId }`                             | acuse de recibo (status→ack) |
| `event:progress`  | `{ eventId, note? }`                      | status→in_progress + log |
| `event:note`      | `{ eventId, note }`                       | añade nota a la bitácora |
| `event:resolve`   | `{ eventId, disposition, note? }`         | status→resolved |
| `event:escalate`  | `{ eventId, note? }`                      | status→escalated |

### Servidor → Cliente
| evento             | payload              | cuándo |
|--------------------|----------------------|--------|
| `event:new`        | `{ event }`          | llega un evento nuevo (broadcast a la consola) |
| `event:update`     | `{ event }`          | cambia el estado de un evento |
| `queue:state`      | `{ counts, top }`    | resumen de cola: `counts` por status/priority, `top` = N eventos activos |
| `operators:state`  | `{ operators }`      | lista de operarios conectados y su carga |
| `snapshot`         | `{ events, operators }` | al conectar, estado actual |

### Operator
```jsonc
{ "id": "op_1", "name": "Ana", "skills": ["video","access"],
  "online": true, "load": 2, "lastSeen": "…" }
```

---

## 5. Reglas y procedimientos

Una **regla** mapea condiciones del evento → prioridad efectiva + procedimiento.
Los **procedimientos** son checklists de acción que el operario sigue en el popup.

```jsonc
// Regla
{ "id": "r1", "match": { "type": ["intrusion","alarm","door_forced"] },
  "setPriority": 1, "procedureId": "proc_intrusion" }

// Procedimiento
{ "id": "proc_intrusion", "name": "Intrusión confirmada", "slaSeconds": 60,
  "steps": [
    "Verificar video en vivo del canal afectado",
    "Confirmar si hay personas en zona",
    "Avisar a vigilancia física / patrulla",
    "Si confirmado: llamar al 911 y notificar al cliente",
    "Registrar disposición y cerrar"
  ] }
```

Reglas y procedimientos del MVP viven en `server/src/rules/defaults.js` (seed en memoria/Redis).

---

## 6. Bus de eventos (Redis con fallback)

- Si `REDIS_URL` está definido y conecta: pub/sub en canal `eventos:events` (fan-out
  entre instancias) + `eventos:recent` (lista recortada a 500 para snapshot).
- Si no hay Redis: **fallback en memoria** (EventEmitter + array). El server arranca igual.
- `GET /api/health` reporta `redis: "connected"` o `"memory"`.

El adaptador expone: `bus.publish(event)`, `bus.subscribe(fn)`, `bus.recent(limit)`,
`bus.save(event)` (upsert para updates).

---

## 7. Variables de entorno (`deploy/.env.example`)

```
HOST=127.0.0.1
PORT=4010
NODE_ENV=production
REDIS_URL=redis://127.0.0.1:6379   # vacío = fallback en memoria
INGEST_TOKEN=                      # generado por el instalador
CORS_ORIGIN=*                      # en prod: el dominio nginx
```

---

## 8. Estructura de carpetas

```
EventOS/
├─ CONTRACT.md                este archivo
├─ server/                    Node + Express + Socket.io + ioredis
│  ├─ package.json
│  └─ src/
│     ├─ index.js             arranque (http + socket + express)
│     ├─ config.js            lee env
│     ├─ bus/redisBus.js      pub/sub + fallback memoria
│     ├─ events/normalize.js  fabricante → Event canónico
│     ├─ events/catalog.js    catálogo §2
│     ├─ rules/engine.js      aplica reglas §5
│     ├─ rules/defaults.js    reglas + procedimientos seed
│     ├─ dispatch/store.js    estado de eventos + operarios
│     ├─ http/ingest.js       rutas /api/ingest/*
│     ├─ http/api.js          /api/events, /api/operators, /api/health
│     ├─ http/sim.js          /api/sim/*
│     ├─ socket/console.js    namespace /console
│     └─ simulator/gen.js     generador de eventos realistas
├─ web/                       React + Vite
│  ├─ package.json
│  ├─ vite.config.js          proxy /api y /socket.io → server en dev
│  └─ src/
│     ├─ main.jsx, App.jsx
│     ├─ lib/socket.js        cliente socket.io + hooks
│     ├─ components/EventPopup.jsx   popup de recepción + procedimiento
│     ├─ components/LiveBoard.jsx    tablero de eventos en vivo
│     ├─ components/Procedures.jsx   checklist + registro de acción
│     ├─ components/OperatorBar.jsx  identidad + estado de operarios
│     └─ styles.css
└─ deploy/                    despliegue en LXC (Debian)
   ├─ install.sh              instala Node 20, Redis, nginx, systemd
   ├─ update.sh               deploy continuo
   ├─ provision-lxc.sh        crea el contenedor LXC en el host Proxmox
   ├─ .env.example
   └─ systemd/eventos-api.service
```

---

## 9. Despliegue (Proxmox LXC)

Mismo patrón que el proyecto hermano *Preventis*: nginx (SPA + reverse proxy + TLS) →
Node por systemd endurecido (usuario `eventos`, bind `127.0.0.1`) + Redis local.
`provision-lxc.sh` se corre en el host Proxmox (pve03) para crear el contenedor;
`install.sh` se corre dentro del contenedor.
