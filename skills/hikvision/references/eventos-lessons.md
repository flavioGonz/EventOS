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
