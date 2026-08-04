# Verificar el catálogo contra equipos reales (y el gotcha que costó un barrido)

El catálogo dice lo que dicen los manuales. Lo que tu equipo **realmente** soporta
se comprueba sondeándolo con `isapi/tools/hik-verify.py` (sólo GET, nunca
PUT/POST/DELETE) y metiendo el reporte al catálogo con `ingest_verify.py`.

## ⚠️ GOTCHA — el DS-9632NI corta a las ~88 autenticaciones (3-ago-2026)

**Pedí el reto digest UNA vez y reusalo** firmando cada request con `nc`
incremental. Nunca uses un cliente que pida un reto 401 nuevo por request.

Medido en campo contra los NVR Jupiter: el primer barrido usó
`urllib.request.HTTPDigestAuthHandler`, que hace round-trip `401 → auth` en **cada**
request. Resultado: **las sondas 1-88 respondieron perfecto y de la 89 en adelante
TODAS dieron 401.** Corte exacto, no aleatorio → el equipo agota su límite de
sesiones/autenticaciones. No es red, no son credenciales, no es rate-limit de
tráfico: es la cantidad de *autenticaciones nuevas*.

Es exactamente lo que ya decía `auth-discovery.md` y lo que hace
`server/src/util/digestFetch.js` de EventOS — y se ignoró al escribir el
verificador desde cero. Si escribís un cliente ISAPI nuevo, empezá por ahí.

**La forma correcta** (implementada en `hik-verify.py` v3, clase `DigestSession`):

- un `http.client.HTTPConnection` con keep-alive, reutilizado
- el reto (`realm`, `nonce`, `qop`, `opaque`) se cachea
- cada request se firma con `nc` incremental y un `cnonce` propio
- sólo se pide un reto nuevo si el nonce caduca (401 con `stale`)
- **secuencial, no concurrente**: con hilos compartiendo el handler de urllib
  además hay carrera en `nc` y en el contador de reintentos

Medición: **1 reto para 980 sondas** (antes: 980 retos), barrido completo en ~41 s.

## ⚠️ El barrido corre desde la misma IP que EventOS

`hik-verify.py` se ejecuta en el CT101, que es el mismo origen que usa EventOS para
`alertStream` y los snapshots. **Si el NVR corta esa IP, EventOS deja de recibir
eventos.** Después de cualquier barrido:

```bash
journalctl -u eventos-api --since "10 min ago" | tail -20
```

Si hay reconexiones de alertStream o 401, esperá unos minutos a que el equipo se
destrabe. Por eso `hik-verify.py` trae `--abort-after N` (corta tras N respuestas
401 seguidas, 15 por defecto) y `--pause` entre sondas.

## Uso

```bash
# desde el CT101 — saca host/puerto/usuario/clave de la config de EventOS
python3 hik-verify.py --from-eventos --list-devices          # ver qué detectó, sin tocar nada
python3 hik-verify.py --from-eventos --channels 1,6,16 --pause 0.05 --outdir /tmp --emit-b64

# donde vive el catálogo
python3 ingest_verify.py verify-*.json
python3 hik.py verified                       # resumen por equipo
python3 hik.py verified --list not_supported
python3 hik.py show GET /ISAPI/ContentMgmt/InputProxy/channels
```

Resultados: `supported` · `not_supported` (el equipo respondió `notSupport`) ·
`absent` (404) · `auth_failed` · `error_response` · `skipped_params`.

## Lo verificado hasta ahora

**Servidor 2 Jupiter, DS-9632NI-I16 fw V4.50.000 (`192.168.7.91:82`)** — 88 sondas
antes del corte:

- **63 `supported`** — entre ellos `ContentMgmt/InputProxy/channels` (el mapa
  canal→IP que usa EventOS), `InputProxy/channels/status`, `PTZCtrlProxy/channels`,
  `ContentMgmt/capabilities`, `record/tracks`, `sourceSupport`, los overlays y
  privacyMask por canal.
- **23 `not_supported`** — el manual los documenta pero este firmware no los tiene:
  todo `Custom/OpenPlatform/*` (apps HEOP), `ContentMgmt/SmartSearch/capabilities`,
  `ContentMgmt/search/capabilities`, `ContentMgmt/channels/<ch>/capabilities`,
  `Storage/cloud/*/uploadStrategy`, `InputProxy/ipcConfigCSV`.
- **2 raros** — `InputProxy/channels/capabilities` devuelve **HTTP 503
  serviceUnavailable**, y `ContentMgmt/SearchByTargetType/capabilities` un 400.

Pendiente: completar el barrido de los dos NVR con la versión corregida.
