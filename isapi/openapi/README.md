# Hikvision ISAPI · OpenAPI + catálogo

Superficie ISAPI **generada automáticamente** desde los manuales oficiales de Hikvision
que están en `isapi/*.pdf`. No se escribió a mano: un pipeline lee los PDFs, reconstruye
los ejemplos XML anotados y los convierte en JSON Schema. Por eso se puede **regenerar**
cuando Hikvision publique manuales nuevos.

## Qué hay acá

| Archivo | Qué es |
|---|---|
| `deepinview.yaml` · `ipc-value.yaml` · `anpr.yaml` · `dvr-pro.yaml` · `dvr-value.yaml` | Un OpenAPI 3.1 **autocontenido** por familia de equipos (válido contra openapi-spec-validator) |
| `catalog.json` | Índice único cross-familia: cada endpoint, en qué manuales aparece, sección y página |
| `catalog.sqlite` | El mismo catálogo consultable con SQL + FTS5 (búsqueda full-text) |
| `common/error-codes.json` | 2.269 códigos `statusCode`/`subStatusCode`/`errorCode` con descripción |
| `common/field-dictionary.json` | 171 campos con sus 1.954 valores de enum documentados |
| `index.html` | Swagger UI local con selector de familia |

## Números

| Familia | Manual | Paths | Operaciones | Schemas |
|---|---|--:|--:|--:|
| `deepinview` | Network Cameras DeepinView (892 p.) | 350 | 558 | 470 |
| `anpr` | Vehicle Access Control / ANPR (448 p.) | 191 | 278 | 249 |
| `dvr-value` | DVR Value Series (317 p.) | 143 | 215 | 204 |
| `dvr-pro` | DVR Pro con AcuSense (306 p.) | 122 | 187 | 182 |
| `ipc-value` | Network Cameras Value Series (231 p.) | 91 | 157 | 152 |

Catálogo unificado: **941 endpoints** — 834 con schema formal (`tier: reference`) y 107
que los manuales sólo mencionan en prosa/ejemplos (`tier: narrative`, p. ej.
`GET /ISAPI/Event/notification/alertStream`, que vive en el capítulo Quick Start).

## Cómo consultarlo

```bash
# CLI (no necesita pip install)
python3 ../tools/hik.py stats
python3 ../tools/hik.py find intrusion detection
python3 ../tools/hik.py show PUT /ISAPI/Smart/FieldDetection/{channelID}
python3 ../tools/hik.py schema FieldDetection --family deepinview
python3 ../tools/hik.py err riskPassword
python3 ../tools/hik.py field vehicleEntryExitingStatus

# Swagger UI
python3 -m http.server 8080     # y abrir http://localhost:8080/

# SQL directo
sqlite3 catalog.sqlite "SELECT method,path FROM endpoint WHERE path LIKE '%Smart%'"
```

## Extensiones `x-hik-*` (por qué existen)

Todo lo que el OpenAPI estándar no sabe expresar, pero el manual sí dice:

| Extensión | Dónde | Significado |
|---|---|---|
| `x-hik-source` | operación | `{document, section, page, breadcrumb}` — trazabilidad exacta al PDF |
| `x-hik-family` / `x-hik-devices` | operación | a qué familia de equipos aplica |
| `x-hik-section` | operación | número de sección del manual |
| `x-hik-schema-version` | operación / schema | versión del esquema ISAPI (`ver10` → 1.0, `ver20` → 2.0) |
| `x-hik-namespace` | schema | namespace XML del root (`http://www.isapi.org/ver20/XMLSchema`) |
| `x-hik-protocol-version` | schema | atributo `version` del root |
| `x-hik-unit` / `x-hik-step` | campo | unidad (`s`, `ms`, `min`, `°`) y paso |
| `x-hik-dep` | campo | dependencia condicional, p. ej. `and,{$.LaserLight.mode,eq,manual}` |
| `x-hik-enum-source` | campo | de dónde salieron los valores: `sample-attribute` (atributo `opt=` del ejemplo) o `field-dictionary` |
| `x-hik-also-documented-in` | operación | el mismo método+path aparece en otra sección del mismo manual |
| `x-hik-parse` | schema | `recovered` = el XML del PDF venía dañado y se reparó (17 de 1.681 bloques) |
| `x-hik-json-sample` | body | endpoints que hablan JSON en vez de XML |

`readOnly` / `writeOnly` salen del `ro`/`wo` de las anotaciones; `required` del `req`/`opt`;
`minimum`/`maximum`/`minLength`/`maxLength` del `range:[a,b]`.

## Cómo se modela el XML

Los manuales documentan cada mensaje como un XML de ejemplo con comentarios anotados:

```xml
<LaserLight xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0">
  <sensitivityLevel>
    <!--opt, int, range:[0,100], dep:and,{$.LaserLight.mode,eq,manual}-->0
  </sensitivityLevel>
</LaserLight>
```

El pipeline lo convierte a JSON Schema con `xml:` bindings, de modo que el schema describe
**el XML real** que hay que mandar:

- elementos → `properties`, con `xml.name`
- atributos → propiedades prefijadas `@`, con `xml.attribute: true`
- elementos con atributos **y** texto → objeto con `@attr` + `#text`
- `array, subType:object` o hermanos repetidos → `type: array` con `xml.wrapped`

## Regenerar (cuando haya manuales nuevos)

```bash
cd isapi/tools
make all          # extract -> parse -> openapi -> catalog
```

El pipeline, en orden:

1. `extract.py` — PDF → JSON de líneas, filtrando la marca de agua diagonal por dirección
   de escritura, y conservando fuente/negrita/posición.
2. `parse.py` — detecta los encabezados numerados y las etiquetas `Request URL` /
   `Query Parameter` / `Request Message` / `Response Message` de cada sección de API.
3. `xmlblocks.py` — reconstruye los bloques XML: repara comentarios cortados por el salto
   de línea, descarta líneas "fantasma" (el PDF dibuja algunas dos veces, la segunda con
   glifos rotos) y normaliza la línea del root.
4. `annot.py` + `schemagen.py` — parsean la gramática de los comentarios y arman el JSON Schema.
5. `build_openapi.py` — arma un spec por familia, deduplicando schemas por hash.
6. `supplement.py` + `build_catalog.py` — minan endpoints mencionados sólo en prosa y
   arman el catálogo unificado + SQLite.

## Verificar contra equipos reales

El catálogo dice lo que dicen los manuales. Lo que tu NVR realmente soporta se
comprueba sondeándolo. `verify.py` hace **sólo GET** (nunca PUT/POST/DELETE: no
cambia nada) y salta los endpoints peligrosos o que se cuelgan (`alertStream`,
`download`, `reboot`, `updateFirmware`…).

Correlo desde un host con ruta al equipo (p. ej. el CT de EventOS, que llega a la
VPN de cesimco — el sandbox de Cowork **no** alcanza la red privada):

```bash
python3 verify.py --host 192.168.7.91 --port 82 --user admin --password '***' \
    --label "srv2-DS9632NI" --channels 1,2,6 --out verify-srv2.json
python3 verify.py --host 192.168.7.91 --port 83 --user admin --password '***' \
    --label "srv1-DS9632NI" --channels 2,6,9 --out verify-srv1.json

python3 verify.py --host ... --dry-run     # ver qué probaría, sin tocar nada
python3 verify.py --host ... --only Smart  # sólo los /ISAPI/Smart/*
```

Después, donde vive el catálogo:

```bash
python3 ingest_verify.py verify-srv1.json verify-srv2.json
python3 hik.py verified                    # resumen por equipo
python3 hik.py verified --list not_supported
python3 hik.py show GET /ISAPI/Smart/capabilities   # ahora dice qué equipo lo soporta
```

Resultados posibles: `supported` · `not_supported` (el equipo respondió
`subStatusCode: notSupport`) · `absent` (404) · `auth_failed` · `error_response` ·
`skipped_params` (el path pide un id que no supimos rellenar — pasalo con
`--param nombre=valor`).

## Límites conocidos (leer antes de confiar a ciegas)

- **17 de 1.681** bloques XML se parsearon en modo recuperación (`x-hik-parse: recovered`);
  pueden tener algún campo de menos. Están marcados.
- Los endpoints `tier: narrative` **no** tienen schema: el manual los nombra pero no los
  documenta formalmente. Ahí hay que ir al PDF (el catálogo dice página).
- Los `enum` sin `opt=` en el ejemplo salen del Field Dictionary; si el campo no está ahí,
  el schema queda como `string` y la descripción trae los valores en prosa.
- Esto es **lo que dicen los manuales**, no lo que responde tu equipo. El firmware manda:
  consultá siempre `*/capabilities` antes de asumir soporte.
