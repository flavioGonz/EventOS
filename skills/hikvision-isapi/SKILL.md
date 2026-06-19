---
name: hikvision-isapi
description: >-
  Conocimiento práctico para integrar dispositivos Hikvision por ISAPI (HTTP):
  cámaras, NVR/DVR, DeepinView, cámaras ANPR/tráfico y paneles de alarma AX.
  Cubre autenticación digest, recepción de eventos (alertStream y suscripción),
  video (RTSP/snapshot/playback), analíticas Smart (cruce de línea, intrusión,
  zonas), clasificación de objetivo IA (persona/vehículo), ANPR, control de
  salidas/relés (IO y SecurityCP de los AX) y EHome/ISUP. Incluye las LECCIONES
  reales del despliegue EventOS. USAR SIEMPRE que se trabaje con Hikvision,
  ISAPI, alertStream, NVR/cámaras, eventos de cruce de línea/intrusión, ANPR,
  snapshot/RTSP, autenticación digest contra equipos Hik, relés/apertura de
  puertas o paneles AX Pro/Hybrid — aunque no se nombre "ISAPI" explícitamente.
---

# Hikvision · ISAPI — guía de integración

ISAPI es la API HTTP de Hikvision (XML/JSON sobre HTTP, autenticación **Digest**).
Es la vía local, sin nube, para hablar con cámaras, NVR, DeepinView, ANPR y
paneles AX. Esta skill destila los docs oficiales + lo aprendido integrando
EventOS contra equipos reales.

> Fuente oficial (en el repo del proyecto, `isapi/`): *ISAPI Network Cameras —
> DeepinView Series* (892 págs) y *ISAPI Vehicle Access Control — ANPR Cameras*
> (448 págs). Esta skill es el **resumen accionable**; el detalle de cada
> endpoint/XML está en esos PDF.

## Reglas de oro (leé esto siempre)

1. **Autenticación = Digest.** Nunca Basic salvo fallback. El reto (`realm`,
   `nonce`, `qop`, `opaque`) se puede **cachear y reusar** con `nc` incremental
   para evitar el round-trip del 401 en cada request (clave para snapshots a fps).
2. **Capabilities primero.** Antes de asumir que un equipo soporta algo,
   consultá su `*/capabilities` (`/ISAPI/System/capabilities`,
   `/ISAPI/Event/capabilities`, `/ISAPI/Smart/capabilities`, etc.). Los modelos
   y firmwares difieren muchísimo.
3. **El puerto importa (NAT).** El ISAPI HTTP no siempre está en 80. La serie
   **8000 es el SDK propietario (binario, NO habla HTTP)**. Identificá el puerto
   ISAPI por el reto `WWW-Authenticate: Digest`. (En EventOS el ISAPI estaba en 82/83.)
4. **Canales:** un NVR multiplexa cámaras por canal. La convención de stream es
   `channels/<ch>01` (principal), `<ch>02` (sub), `<ch>03` (tercero, a veces
   deshabilitado). Ej. canal 6 → `601` principal, `602` sub.
5. **No reinventes:** EventOS ya tiene `server/src/util/digestFetch.js`
   (`digestGetBuffer` GET, `digestRequest` PUT/POST), `discovery/hikvision.js`
   (descubridor ISAPI) e `ingest/alertStream.js` (recepción en vivo). Reusalos.

## Cómo usar esta skill (mapa de decisión)

| Querés… | Mirá |
|---|---|
| Autenticar, descubrir equipo, leer info/canales | `references/auth-discovery.md` |
| Recibir eventos en vivo (cruce de línea, intrusión, alarma) | `references/events.md` |
| Video: vivo, snapshot, grabación/playback | `references/video.md` |
| Analíticas (línea/zona) y su geometría | `references/analytics.md` |
| Clasificación humano/vehículo, rostro (DeepinView), ANPR/tráfico | `references/analytics.md` |
| Relés / abrir puertas / paneles AX / EHome-ISUP | `references/io-access.md` |
| Gotchas reales del despliegue (video corrupto, puertos, etc.) | `references/eventos-lessons.md` |

## Núcleo práctico (inline)

**Endpoints más usados:**
- `GET /ISAPI/System/deviceInfo` — modelo, firmware, MAC, nº de canales.
- `GET /ISAPI/System/capabilities` · `/ISAPI/Event/capabilities` — qué soporta.
- `GET /ISAPI/ContentMgmt/InputProxy/channels` — (en NVR) mapea canal → IP/credenciales de cada cámara detrás del NVR. **Clave** para llegar directo a la cámara.
- `GET /ISAPI/Event/notification/alertStream` — stream HTTP persistente de eventos (ver `events.md`).
- `GET /ISAPI/Streaming/channels/<ch>01/picture` — snapshot JPEG (póster/MJPEG).
- `rtsp://user:pass@host:554/Streaming/Channels/<ch>0X` — vivo (X=1 main, 2 sub).
- `PUT /ISAPI/System/IO/outputs/<n>/trigger` — disparar relé/salida (abrir puerta).

**Formato:** XML o JSON (algunos endpoints aceptan `?format=json`). Las respuestas
de error traen `<ResponseStatus>` con `statusCode`/`subStatusCode` — parsealos,
no asumas 200=OK ciegamente.

**Tiempo:** ISAPI usa ISO 8601; para playback el rango va en **UTC con `Z`**
(`YYYYMMDDThhmmssZ`).

## Cómo MANTENER y AMPLIAR esta skill

Esta skill está pensada para **crecer**. Cada vez que aprendamos una técnica
nueva con Hikvision (un endpoint que funciona/no funciona, un quirk de firmware,
un panel AX nuevo, etc.):

1. Agregá el hallazgo al `references/*.md` que corresponda, con **fecha** y, si
   aplica, **modelo/firmware** y la **fuente** (PDF + sección, o "verificado en
   campo contra X").
2. Si es un gotcha de campo, va a `references/eventos-lessons.md`.
3. Mantené el SKILL.md como índice/resumen; el detalle, en las referencias.
4. Preferí "qué funcionó de verdad" sobre "qué dice la teoría" — y marcá cuándo
   algo es teoría no verificada.
