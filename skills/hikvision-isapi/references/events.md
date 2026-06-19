# Recepción de eventos (ISAPI)

Hay DOS modelos de "arming" (suscripción a eventos) en ISAPI:

## 1) alertStream — stream HTTP persistente (PULL)
`GET /ISAPI/Event/notification/alertStream` (con Digest) deja una conexión HTTP
abierta y el equipo va **empujando** `EventNotificationAlert` (XML) a medida que
ocurren. Es el modelo que usa EventOS (`server/src/ingest/alertStream.js`).

- El cuerpo puede ser **XML** o **multipart** (`multipart/...; boundary=`): cada
  parte trae el XML del evento y, si está configurado, una **imagen JPEG**
  (la foto del momento, p.ej. del cruce de línea). Hay que parsear el multipart
  y emparejar cada XML con su parte `image/jpeg`.
- Campos típicos del XML: `eventType`, `eventState` (active/inactive),
  `channelID`/`dynChannelID`, `dateTime`, `ipAddress`, `regionID`,
  `detectionTarget`/`targetType` (si la cámara clasifica).
- **Heartbeats:** llegan `videoloss`/`VMD` sin relevancia → filtralos. El
  movimiento crudo (VMD/motion) suele ser un diluvio; conviene quedarse solo con
  analíticas accionables (linedetection, fielddetection, region*, face, anpr,
  io/alarm, tamper).
- **IMPORTANTE — el enlace "center":** para que un trigger EMPUJE por alertStream,
  su acción de notificación debe incluir `<notificationMethod>center` ("Notify
  Surveillance Center"). Si los triggers solo tienen record/beep, NO empujan.
  Se setea por UI o por `PUT /ISAPI/Event/triggers/<trigger>` agregando `center`.

## 2) Suscripción (PUSH HTTP a un host) — modelo nuevo
- `GET /ISAPI/Event/notification/subscribeEventCap` → qué se puede suscribir.
- `POST /ISAPI/Event/notification/subscribeEvent` → suscribís tipos y un
  destino HTTP (el equipo hace POST de los eventos a tu URL = webhook/"alarm host").
- `POST /ISAPI/Event/notification/unSubscribeEvent` → cancela.
- Útil cuando preferís PUSH (el equipo llama a EventOS) en vez de PULL.

## Triggers y capacidades
- `GET /ISAPI/Event/capabilities` y `/ISAPI/Event/triggersCap` → eventos soportados.
- `GET /ISAPI/Event/triggers` → lista de triggers con sus notificaciones.
- `/ISAPI/Event/triggers/<tipo>-<canal>` (ej. `VMD-1`, `faceSnap-1`) → trigger puntual.

## Mapa eventType (Hik) → tipo canónico (EventOS `normalize.js`)
`linedetection`→line_crossing · `fielddetection`→intrusion ·
`regionEntrance`/`regionExiting`→region_* · `facedetection`→face ·
`VMD`/`motion`→motion · `tamperdetection`/`shelteralarm`→tamper ·
`io`/`alarmlocal`/`inputproxy`/`alarm`→alarm · ANPR→ver `analytics.md`.
