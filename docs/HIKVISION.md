# Integración Hikvision (NVR / DVR / cámaras IP) → EventOS

EventOS ingiere directamente las analíticas reales de los equipos Hikvision. Los
dispositivos **empujan** los eventos por HTTP ("Notificar al centro de vigilancia" /
"Servidor de alarma" / "HTTP Listening") posteando un documento `EventNotificationAlert`
a nuestro endpoint de ingesta.

## 1. Endpoint (webhook)

```
POST http://<host>/api/ingest/hikvision?token=<INGEST_TOKEN>
```

- Autenticación: query `?token=…` **o** header `X-Ingest-Token: <INGEST_TOKEN>`.
  El token lo genera el instalador (variable `INGEST_TOKEN`).
- Acepta el payload **nativo** de Hik:
  - `application/xml` o `text/xml` — el `EventNotificationAlert` como XML (lo más común).
  - `text/plain` — algunos firmwares lo mandan así.
  - `multipart/form-data` — una parte XML + un JPEG (snapshot) opcional. EventOS aísla
    automáticamente la subcadena `<EventNotificationAlert>…</EventNotificationAlert>`
    e ignora la imagen binaria.
  - `application/json` — si la integración ya viene en JSON.
- Respuesta: `201 { event }` con el Event canónico ya normalizado.

> Como Hik **no permite** poner el token en la query en todos los menús, también se
> acepta el header `X-Ingest-Token`. Si tu firmware no deja añadir headers, usa la URL
> con `?token=…`.

## 2. Dónde configurarlo en el equipo Hikvision

Hay dos caminos según el firmware/modelo:

**A. HTTP Listening (servidor HTTP genérico)**
`Configuración → Red → Configuración avanzada → HTTP Listening`
(o "Configuración de notificación de alarma" / "Alarm Server"). Indica:
- IP/host de EventOS, puerto (80/443 según nginx), protocolo HTTP/HTTPS.
- URL/ruta: `/api/ingest/hikvision?token=<INGEST_TOKEN>`.

**B. Vinculación por evento (recomendado, por analítica)**
`Configuración → Evento → Evento básico` (o `Evento inteligente`) → elige la analítica
(p.ej. *Cruce de línea*, *Intrusión*, *Entrada/Salida de región*) → pestaña
**Vinculación / Método de activación** → marca **"Notificar al centro de vigilancia"**
y/o configura el **Servidor de alarma** apuntando a la URL de arriba.

Ajusta el horario de armado ("Programación de armado") para que los eventos se envíen
24/7 o según el turno del cliente.

## 3. Analíticas soportadas

| `eventType` Hikvision                                   | Tipo canónico EventOS | Título            |
|--------------------------------------------------------|-----------------------|-------------------|
| `linedetection`                                        | `line_crossing`       | Cruce de línea    |
| `fielddetection`, `intrusion`                          | `intrusion`           | Intrusión         |
| `regionEntrance`                                       | `region_entrance`     | Entrada a zona    |
| `regionExiting` / `regionExit`                         | `region_exit`         | Salida de zona    |
| `VMD`, `motion`, `motionDetection`                     | `motion`              | Movimiento        |
| `videoloss`                                            | `video_loss`          | Pérdida de video  |
| `tamperdetection`, `shelteralarm`, `scenechangedetection` | `tamper`           | Sabotaje          |
| `facesnap`, `faceDetection`                            | `face`                | Rostro            |
| `ANPR`, `vehicledetection` (+ matrícula)               | `lpr`                 | Matrícula (LPR)   |
| `io`, `AlarmLocal`, `inputProxy`, `alarm`              | `alarm`               | Alarma de entrada |
| (desconocido)                                          | `system`              | Evento de sistema |

El match es **insensible a mayúsculas/minúsculas** y a separadores (`-`, `_`, espacios).

**Zonas (regiones):** para `regionEntrance`/`regionExiting`, `intrusion` y `linedetection`,
EventOS extrae el nombre o ID de la región (`<RegionID>` / `<regionName>` /
`DetectionRegionList`) y lo coloca en el campo `zone` del evento — esto es lo que el
operario ve como "zona afectada".

**LPR:** la matrícula (`<licensePlate>` / `<plateNumber>`) se coloca en `message` y `zone`.

**`eventState`:** Hik envía `active` al iniciar el evento e `inactive` al terminar.
EventOS crea el evento en ambos casos, pero a los `inactive` les **baja una prioridad**
(menos urgentes que el `active`).

## 4. Campos extraídos del `EventNotificationAlert`

- `source.deviceName` ← `<channelName>` (o `<deviceID>`)
- `source.channel`    ← `<channelID>` / `<dynChannelID>`
- `source.ip`         ← `<ipAddress>`
- `source.deviceId`   ← `<deviceID>` / `<macAddress>`
- `deviceTs`          ← `<dateTime>`
- `zone`              ← región / matrícula (ver arriba)
- `raw`               ← el XML original (truncado si es enorme)

## 5. Prueba de extremo a extremo (curl)

Postea un `EventNotificationAlert` real de **cruce de línea** y deberías recibir
`201 { event }` con `type: "line_crossing"`:

```bash
curl -i -X POST \
  "http://<host>/api/ingest/hikvision?token=<INGEST_TOKEN>" \
  -H "Content-Type: application/xml" \
  --data-binary '<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <ipAddress>192.168.99.50</ipAddress>
  <channelID>1</channelID>
  <dateTime>2026-06-13T10:56:59-03:00</dateTime>
  <eventType>linedetection</eventType>
  <eventState>active</eventState>
  <eventDescription>Line Detection alarm</eventDescription>
  <channelName>Camara Acceso Norte</channelName>
  <DetectionRegionList>
    <DetectionRegionEntry>
      <regionID>1</regionID>
    </DetectionRegionEntry>
  </DetectionRegionList>
</EventNotificationAlert>'
```

Ejemplo de **entrada a zona** (`region_entrance`, con nombre de región):

```bash
curl -i -X POST \
  "http://<host>/api/ingest/hikvision?token=<INGEST_TOKEN>" \
  -H "Content-Type: application/xml" \
  --data-binary '<EventNotificationAlert>
  <ipAddress>192.168.99.51</ipAddress>
  <channelID>2</channelID>
  <dateTime>2026-06-13T11:02:00-03:00</dateTime>
  <eventType>regionEntrance</eventType>
  <eventState>active</eventState>
  <channelName>Perimetro Este</channelName>
  <regionName>Patio de carga</regionName>
</EventNotificationAlert>'
```

El primer comando produce un evento `line_crossing` (prioridad 2, procedimiento
"Cruce de línea"); el segundo, `region_entrance` (prioridad 2, procedimiento
"Entrada / salida de zona") con `zone: "Patio de carga"`.
