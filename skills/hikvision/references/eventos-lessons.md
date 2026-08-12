# Lecciones de campo — despliegue EventOS (Cesimco)

Gotchas reales verificados contra 2 NVR Hikvision DS-9632NI-I16 + ~57 cámaras.
(Actualizar con cada nuevo aprendizaje, con fecha.)

- **Puertos (jun-2026):** ISAPI en 82 (Servidor 2) y 83 (Servidor 1), NO 8000
  (8000=SDK binario). RTSP por NAT en 10002 (srv2) y 10003 (srv1), NO 554.
  Web FPA-1000 en 80 (otro equipo). Credenciales `admin` / (clave del sitio).
- **LAN vs internet:** ambos NVR alcanzables por la IP LAN `192.168.7.91` (la VPN
  rutea esa IP a los dos, mismos puertos 82/83/10002/10003). La IP "propia" de
  srv1 (192.168.1.64) solo tenía 8000 → inservible para ISAPI/RTSP.
- **Cámaras detrás del NVR:** TODAS en subred `192.168.7.x` con **554 abierto** y
  RTSP **directo LIMPIO** (H.264 Main). El mapeo canal→IP se obtuvo de
  `/ISAPI/ContentMgmt/InputProxy/channels`. Poblando `camIp` en cada device, el
  vivo directo (go2rtc copy) funciona; sin camIp → MJPEG.
- **Video corrupto = restream del NVR (H.264+), no las cámaras.** Ver `video.md`.
- **alertStream:** funcionó tras activar el enlace `center` en los triggers
  (estaban en record/beep → no empujaban). El movimiento (VMD) es flood: se filtra,
  se quedan solo analíticas accionables. Los multipart traen XML + JPEG (evidencia).
- **Clasificación de objetivo:** ~1/3 de los eventos reales traían `target`
  (human/vehicle); el resto sin clasificar (depende de AcuSense por cámara).
- **Snapshot ISAPI** (`/Streaming/channels/<ch>01/picture`) siempre nítido → base
  de evidencia y MJPEG.
- **Relé/puertas:** `PUT /ISAPI/System/IO/outputs/<n>/trigger` (hik-io) y
  `/ISAPI/SecurityCP/control/outputs/<id>` (AX). EventOS `POST /api/device/:id/relay`.
- **ffmpeg del server (5.1.x):** NO acepta `-stimeout` ni `-rw_timeout`. Para HLS,
  `-use_wallclock_as_timestamps 1` mantiene vivo el stream de estas cámaras.
- **Objetivo IA (19-jun):** usar `detectionTarget` (human/vehicle/human_vehicle), NO `targetType` (numérico=tipo de escena). En el alertStream/normalize, priorizar detectionTarget e ignorar targetType numérico. Y `regionID` NO debe caer a un `<ID>` genérico del XML (captura el id equivocado).


## logSearch (registro de eventos del equipo) — NO resuelto en DS-7616NI-Q2 (2026-08-12)

Objetivo: leer el registro nativo del NVR/cámara Hik (aperturas, alarmas, login,
operación) por ISAPI para fusionarlo con los eventos de EventOS en la pestaña Logs.

Estado: **NO funciona todavía contra `DS-7616NI-Q2` (200.125.44.194:80) ni contra
`DS-2CD4A26FWD-IZS` (192.168.99.96:80).** El endpoint existe pero rechaza todos los
cuerpos probados.

Lo verificado en campo:
- `GET /ISAPI/ContentMgmt/logSearch/description` → 200. Dice: método GET/POST,
  `inboundData = CMSearchDescription`, `returnResult = CMSearchResult`. **No trae
  ejemplo real** (el "example follows" es texto fijo).
- **Mecánica de request OK, no es problema de digest ni de canal:** el mismo helper
  (probe `GET /ISAPI/System/time` sin cuerpo → nonce → `POST` con cuerpo una sola vez,
  igual que `contentmgmt.js`) contra `POST /ISAPI/ContentMgmt/search` (grabaciones,
  con `<trackIDList><trackID>101</trackID>`) devuelve **200 + matches**. El descriptor
  que el equipo devuelve en ese resultado es `recordType.meta.hikvision.com/timing`.
  ⚠️ Nota: `searchID` **debe ser GUID** (`crypto.randomUUID()`); el equipo lo eco
  con llaves `{...}` pero en el request van sin llaves. Y el campo va MAL escrito a
  propósito: `<searchResultPostion>` (no "Position").
- `POST /ISAPI/ContentMgmt/logSearch` → **400 `Invalid XML Content` / `badXmlContent`**
  con TODOS estos cuerpos:
  - `<LogSearchDescription>` con `<majorType>all</majorType>` (con y sin namespace/prolog).
  - `<CMSearchDescription>` sin metadata (idéntico al de grabaciones pero sin trackIDList).
  - `<CMSearchDescription>` + `<metadataList><metadataDescriptor>` probando:
    `//metadata.ISAPI.top/log`, `/log/all`, `/log/majorType/0/minorType/0`,
    `//metadata.std-cgi.com/LogSearchDescription`, `//recordType.meta.hikvision.com/log`,
    `/log/all`, `recordType.meta.hikvision.com/timing`.
  - `<CMSearchDescription>` con `<majorType>/<minorType>` como hijos, `<selectType>`,
    y con `<trackIDList>` prestado de grabaciones.
  - Método GET (además de POST) y `?format=json` con cuerpo JSON → `Invalid XML Format`.
- `GET /ISAPI/ContentMgmt/logSearch/capabilities` → 400 (no existe).
- `GET /ISAPI/ContentMgmt/capabilities` → 200 pero **sin schema de log**; expone
  `isSupportLogDataPackage=false`, `recordSearchType`, `pictureSearchType`.

Diagnóstico: es un endpoint **narrative-tier** (no está en los 941 del catálogo);
el schema exacto que acepta este firmware sólo está en el PDF *ISAPI_Service* de la
familia, que todavía no tenemos parseado. El elemento obligatorio que falta no se
pudo derivar por fuerza bruta.

Próximos pasos cuando se retome:
1. Conseguir el manual *HIKVISION ISAPI_Service* (sección Content Management → Log)
   y sacar el `CMSearchDescription` exacto para logs → agregarlo al catálogo
   (`isapi/`, `build_openapi.py`, `make all`) y a esta lección.
2. Alternativa: capturar el request real que hace iVMS-4200 / el navegador del NVR
   al abrir "Registro" (proxy/log del equipo) y copiar ese cuerpo tal cual.
3. Mientras tanto, la pestaña Logs de EventOS muestra para equipos Hik **sólo los
   eventos de EventOS** de ese dispositivo (no el log nativo). Los Akuvox sí traen
   doorlog+calllog nativos (ver eventos-features-2026-08-12).
