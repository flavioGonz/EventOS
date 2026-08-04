# Video: vivo, snapshot, grabación (ISAPI/RTSP)

## Snapshot (JPEG) — el más confiable
`GET /ISAPI/Streaming/channels/<ch>01/picture` (Digest) → JPEG del momento.
- Es **decodificado por la propia cámara**, así que SIEMPRE sale nítido aunque el
  RTSP venga corrupto. Base del "near-live" y del MJPEG en EventOS.
- `<ch>` = nº de canal; sufijo `01` principal, `02` sub.

## Vivo (RTSP)
`rtsp://user:pass@host:554/Streaming/Channels/<ch>0X`  (X=1 main, 2 sub).
- En NVR detrás de NAT el RTSP puede estar en otro puerto (en Cesimco: 10002/10003).
- `tracks/<ch>0X` da 400 en algunos DS-9632NI → usar `channels/`.

## Grabación / playback
- Buscar grabaciones: `/ISAPI/ContentMgmt/search` (POST con rango de tiempo).
- Reproducir por RTSP con rango: `.../Streaming/Channels/<ch>01?starttime=YYYYMMDDThhmmssZ&endtime=...`
  (**UTC con `Z`**). También `/ISAPI/ContentMgmt/record/tracks`.

## ⚠️ Lección crítica de campo (EventOS): H.264+ corrupto
- El **restream RTSP del NVR** (puerto NAT) de estas cámaras llega
  **genuinamente corrupto**: ~50% de macrobloques con errores
  (`sps_id out of range`, `frame num change`, `non-existing PPS`). Patrón típico
  de **H.264+ / SmartCodec (SVC)** de Hikvision: GOP no estándar que rompe TODO
  decodificador (ffmpeg y navegador). Ni transcode ni descarte lo arreglan
  (transcode re-encoda puré gris; descarte pierde el SPS → basura).
- **La cámara DIRECTA (su IP propia en 554) sale LIMPIA.** O sea: lo corrupto es
  el restream del NVR, no la cámara. Solución EventOS: poblar `camIp` (vía
  `InputProxy`, ver `auth-discovery.md`) y servir el directo con **go2rtc** (copy,
  SPS válido). Si no hay camIp/ruta → fallback **MJPEG** (snapshots ~10 fps).
- Arreglo de raíz si se quiere RTSP del NVR limpio: **apagar H.264+/SmartCodec**
  en cada cámara (UI del NVR → Vídeo, o ISAPI por canal — a veces no expuesto).
- **Cámaras fisheye/cuadradas:** su SPS puede ser rechazado por MSE en el navegador
  aunque ffprobe lo lea — pendiente.
