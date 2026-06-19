# EventOS — Contrato v3 (Operadores, Cliente/Llamadas, Flujos de Eventos)

Extiende CONTRACT.md / V2. Cuatro bloques nuevos. Fuente de verdad de la fase 3.

---

## 1. Presencia de operador, pausas y tiempo contabilizado

Estado runtime por operador: `available` | `paused` | `offline`. La pausa lleva motivo:
`descanso` | `almuerzo` | `capacitacion` | `bano` | `otro`.

**dispatch/store.js** — por cada operador online, acumular:
```jsonc
{ id, name, skills, online, status, pauseReason,
  load,                         // eventos activos asignados
  sessionStart,                 // ISO, al primer operator:hello
  msAvailable, msPaused,        // acumuladores (ms), actualizados al cambiar de estado
  pauseSince,                   // ISO mientras está en pausa
  handled,                      // # eventos resueltos por él en la sesión
  lastSeen }
```
Recalcular acumuladores cada vez que cambia el estado (delta desde el último cambio).

**Socket (cliente→servidor):** `operator:pause {reason}`, `operator:resume`.
**Servidor→cliente:** `operators:state {operators}` (con los campos de arriba) y
`operator:self {stats}` dirigido al socket del operador (su propio contador en vivo).

**Motor de dispatch:** los operadores en `paused`/`offline` se EXCLUYEN de candidatos
(en `selectCandidates`). Si todos están en pausa, fallback broadcast (queda `new`).

**Persistencia (tiempo contabilizado):** al cerrar sesión o resolver, append a
`server/data/operator-log.jsonl` `{ts, operatorId, name, event:"login|pause|resume|logout|handled", reason?, ms?}`. Endpoint admin `GET /api/admin/operators/stats?from=&to=` → agregados por operador
(tiempo disponible, en pausa por motivo, eventos atendidos, tiempo medio de atención).

---

## 2. Cliente / contactos — llamar ante alarma

Cada **site** gana datos de cliente operables desde el popup:
```jsonc
{ id, name, address, account,            // nº de cuenta/cliente
  protocol,                              // protocolo de actuación (texto)
  contacts: [ { name, role, phone, order } ]   // lista de llamada priorizada
}
```
Admin: el formulario de **Sitios** edita address/account/protocol + lista de contactos
(añadir/quitar/ordenar, con teléfono y rol).

Público para la consola (sin tokens admin): `GET /api/client?site=<nombre o siteId>` →
`{ site:{name,address,account,protocol}, contacts:[...] }`.

**Popup:** panel **"Cliente / Contactos"** — muestra cuenta, dirección, protocolo y la lista
de llamada; cada contacto con botón **Llamar** (`tel:` + registra en bitácora).
**Socket:** `event:call {eventId, contactName, phone}` → log `action:"call"` con la nota
`Llamó a <contacto> (<phone>)`.

---

## 3. Analítica de flujo (para el módulo Flujos)

**Log de eventos:** el pipeline hace append de cada evento a `server/data/events.jsonl`
`{ts, type, category, priority, vendor, site, status}` (sin payload). Rotar/recortar si
supera ~50 MB (mantener cola). No bloquear el hot-path (append async, tolerante a fallo).

**Endpoint:** `GET /api/admin/analytics/flow` (X-Admin-Token) con query:
`from`, `to` (ISO), `bucket` (`minute|hour|day`, default hour), `groupBy`
(`priority|type|category|vendor|site`, default priority), y filtros opcionales
`site=`, `type=`, `priority=`, `vendor=`. Devuelve:
```jsonc
{ from, to, bucket, groupBy,
  buckets: [ "2026-06-13T10:00:00Z", ... ],     // eje de tiempo
  series:  [ { key:"1", label:"Crítico", total:42, values:[..por bucket..] }, ... ],
  total: 318,
  byPriority: {1:.., 2:..}, byType:{...}, bySite:{...}, byVendor:{...}  // totales para filtros/KPIs
}
```
Lee de `events.jsonl` (y/o del store en memoria como respaldo). Tolerante a archivo ausente.

---

## 4. Módulo "Flujos de Eventos" (frontend)

Nueva ruta admin **`/admin/flujos`** (item de nav "Flujos", icono `layers`/`gauge`).
Estética **Caudal Forense** (ver design/CAUDAL_FORENSE.md): stream-graph oscuro de área
apilada por prioridad sobre el tiempo, con ribbons de vidrio y temperatura cromática
(usar `--p1..--p5`). Hand-rolled en SVG (sin dependencias de charting).

Contenido:
- **KPIs** arriba: total de eventos, % críticos, tasa por hora, sitio más activo.
- **Stream-graph** central: área apilada/streamgraph por la dimensión `groupBy`, eje de
  tiempo abajo, tooltip al pasar (bucket + desglose). Animación de entrada ultra-rápida.
- **Filtros** (barra): rango (Hoy / 24h / 7d / personalizado), `bucket`, `groupBy`
  (Prioridad/Tipo/Categoría/Vendor/Sitio), y filtros por sitio/tipo/prioridad/vendor
  (multi-select con las primitivas + labels.js).
- **Tabla/leyenda** lateral con totales por serie (ordenable).
- Refresco en vivo (poll cada ~10s) y respeta dark/light.

Propiedad de archivos (para no pisarse):
- **server/** → agente Backend.
- **web/src/admin/Flujos.jsx** (+ FlowGraph en web/src/admin/) y registro en AdminApp nav → agente Flujos.
- **web/src/components/EventPopup.jsx** (panel cliente) → agente Popup.
- **web/src/components/OperatorBar.jsx** + **web/src/admin/Operators.jsx** (pausas/tiempo) → agente Operadores.
- **web/src/lib/socket.js** (acciones pause/resume/call + estado self) → orquestador (ya hecho).
- **web/src/admin/Sites.jsx** (contactos/cliente) → agente Popup (coordina con cliente).
