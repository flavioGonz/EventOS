# Autenticación y descubrimiento (ISAPI)

## Autenticación Digest
- Hik usa **HTTP Digest** (RFC 2617). El primer request sin auth devuelve `401`
  con `WWW-Authenticate: Digest realm="...", nonce="...", qop="auth", opaque="..."`.
- Se responde con `Authorization: Digest ...` calculando
  `HA1=md5(user:realm:pass)`, `HA2=md5(method:uri)`,
  `response=md5(HA1:nonce:nc:cnonce:qop:HA2)`.
- **Optimización (verificada en EventOS):** cachear el reto por host y reusar el
  `nonce` incrementando `nc` evita el 401 en cada llamada → ~2x fps en MJPEG.
  El reto expira; ante 401 se re-desafía. Ver `digestFetch.js`.
- Fallback **Basic** solo si el equipo no ofrece Digest (raro; algún panel viejo).

## Identificar el puerto ISAPI (NAT / port-forwarding)
- ISAPI HTTP suele estar en 80, pero detrás de NAT puede ser cualquiera.
- **Puerto 8000 = SDK propietario de Hikvision (binario): acepta TCP pero NO
  habla HTTP/ISAPI.** No lo uses para ISAPI.
- Regla: el puerto ISAPI es el que responde con reto `WWW-Authenticate: Digest`.
- En el sitio Cesimco (EventOS): ISAPI real en **82 y 83** (no 8000), RTSP en
  10002/10003 (NAT), no 554. Cada deployment es distinto.

## Descubrimiento básico
- `GET /ISAPI/System/deviceInfo` → `<deviceName>`, `<model>`, `<firmwareVersion>`,
  `<macAddress>`, `<deviceType>`.
- `GET /ISAPI/System/capabilities` → árbol de lo que soporta el equipo.
- `GET /ISAPI/ContentMgmt/InputProxy/channels` → **en NVR**, lista los canales
  con su `<id>` y `<sourceInputPortDescriptor><ipAddress>` (la IP real de cada
  cámara). Sirve para mapear canal→IP y llegar **directo a la cámara** (clave para
  video limpio; ver `video.md`).
- `GET /ISAPI/Streaming/channels` → canales y perfiles de stream.
- EventOS implementa esto en `server/src/discovery/hikvision.js` (y ONVIF en
  `discovery/onvif.js`). Reusalo.

## Familias de equipos documentadas (mismo framework ISAPI, distintas capabilities)
- **Cámaras DeepinView** — deep learning (rostro, humano/vehículo, FDLib, AIOpenPlatform).
- **Cámaras Value Series** — gama de entrada.
- **DVR Pro con AcuSense** — DVR con clasificación humano/vehículo.
- **DVR Value Series** — DVR de entrada.
- **NVR** (DS-9632NI-I16 en EventOS), **cámaras ANPR/ITC**, **paneles AX** (SecurityCP).
Regla: el framework (digest, capabilities, alertStream) es común; cambia QUÉ
soporta cada familia -> consultá siempre `*/capabilities`. Docs por familia en `isapi/`.