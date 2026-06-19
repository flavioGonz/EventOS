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


## ✅ PLAYBACK H.264+ RECUPERADO vía ContentMgmt DOWNLOAD (19-jun-2026, verificado en campo)
El restream RTSP del NVR de grabaciones H.264+ es indecodificable (SPS/PPS rotos). PERO el
**DOWNLOAD HTTP de ISAPI entrega el archivo como MPEG Program Stream con SPS/PPS intactos →
decodifica LIMPIO** (ffmpeg copy directo). Receta probada contra DS-9632NI-I16 (cesimco):

1. **El search ISAPI es MUY estricto en estos NVR.** Gotchas (cada uno daba `badXmlContent`/`statusCode 6`):
   - **`searchID` DEBE ser un GUID con guiones** (p.ej. `crypto.randomUUID()`). Un id arbitrario (32 hex sin guiones) → "two root tags". ESTE fue el bloqueante principal.
   - **El probe del digest debe ir SIN cuerpo.** Si mandás el body en el request 401 (curl `--digest` y `digestRequest` de EventOS lo hacen), el NVR **bufferea ese cuerpo y lo concatena** con el autenticado → "Tag N is invalid (two root tags)". Hacé: GET probe (sin body) → tomá el nonce → POST con body UNA vez. (curl: agregá `-H 'Expect:'`, pero igual conviene el probe sin body.)
   - Cuerpo mínimo que funciona: `<CMSearchDescription><searchID>{guid}</searchID><trackIDList><trackID>{ch}01</trackID></trackIDList><timeSpanList><timeSpan><startTime>ISO-Z</startTime><endTime>ISO-Z</endTime></timeSpan></timeSpanList><maxResults>40</maxResults><searchResultPostion>0</searchResultPostion></CMSearchDescription>` (tiempo ISO **con guiones y `Z`**, NO el compacto).
   - **trackID = canal*100 + 1 (MAIN).** En cesimco el NVR graba SOLO el main (801): sub (802) y MJPEG (803) → "NO MATCHES". Por eso el playback de EventOS (que usaba el SUBflujo `channels/802`) salía GRIS: ¡no existe grabación del sub! El playback debe ir al **801**.
2. **Download:** `POST /ISAPI/ContentMgmt/download` (puerto ISAPI, p.ej. :83) con body `<downloadRequest version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><playbackURI>{el playbackURI EXACTO del search, con &amp;}</playbackURI></downloadRequest>`. Responde `Content-Type: Opaque/data`, MPEG-PS h264. ffmpeg lo lee y `-c:v copy -f hls` da `.ts` limpios (sin re-encode).
3. **LÍMITE de seek:** el download **arranca SIEMPRE al inicio del archivo** del segmento (lo fija el `name=` del playbackURI). El **header `Range: bytes=` se ANUNCIA (`accept-ranges`) pero se IGNORA** (devuelve 200 desde el principio, no 206). Buscar con ventana angosta NO recorta: el `playbackURI` siempre trae el span completo del archivo. Los segmentos son largos (~40-70 min continuos). ⇒ Para seek a un instante profundo hay que transferir hasta ahí (input-seek de ffmpeg ~45 Mbit/s) o reproducir desde el inicio del archivo. Mitigación de raíz: configurar el NVR para archivos de grabación más cortos.
4. **Velocidad:** ~8 MB en 1.4 s (~45 Mbit/s) por la VPN.
