# El catálogo ISAPI — cómo buscarlo, leerlo y regenerarlo

941 endpoints extraídos automáticamente de los manuales oficiales de Hikvision.
No se escribió a mano: un pipeline lee los PDFs, reconstruye los ejemplos XML
anotados y los convierte en JSON Schema. Por eso se puede **regenerar**.

## Dónde vive qué

| Cosa | En la skill | En el repo EventOS |
|---|---|---|
| Índice compacto de endpoints | `assets/endpoints.tsv` (941 filas) | `isapi/openapi/catalog.json` |
| Schemas completos request/response | — | `isapi/openapi/<familia>.yaml` |
| Catálogo consultable con SQL/FTS | — | `isapi/openapi/catalog.sqlite` |
| Códigos de error | `assets/error-codes.json` (2.269) | `isapi/openapi/common/error-codes.json` |
| Enums por campo | `assets/field-enums.json` (171 campos, 1.954 valores) | `isapi/openapi/common/field-dictionary.json` |
| CLI de consulta | `assets/hik.py` | `isapi/tools/hik.py` |
| Swagger UI | — | `isapi/openapi/index.html` |

## Cobertura por familia

| Familia | Manual | Paths | Operaciones | Schemas |
|---|---|--:|--:|--:|
| `deepinview` | Network Cameras DeepinView (892 p.) | 350 | 558 | 470 |
| `anpr` | Vehicle Access Control / ANPR (448 p.) | 191 | 278 | 249 |
| `dvr-value` | DVR Value Series (317 p.) | 143 | 215 | 204 |
| `dvr-pro` | DVR Pro con AcuSense (306 p.) | 122 | 187 | 182 |
| `ipc-value` | Network Cameras Value Series (231 p.) | 91 | 157 | 152 |

Un mismo endpoint suele estar en varias familias con el mismo schema — el
catálogo lo unifica y lista en cuáles aparece, con sección y página de cada manual.

## Buscar

```bash
# TSV (siempre disponible, sin dependencias)
grep -i "intrusion"        assets/endpoints.tsv | cut -f1,2,6
grep -P "^PUT\t/ISAPI/Smart" assets/endpoints.tsv
awk -F'\t' '$3=="narrative"' assets/endpoints.tsv | cut -f1,2   # los que no tienen schema

# CLI completo (necesita el repo)
python3 isapi/tools/hik.py find line crossing
python3 isapi/tools/hik.py show PUT /ISAPI/Smart/FieldDetection/{channelID}
python3 isapi/tools/hik.py schema FieldDetection --family deepinview
python3 isapi/tools/hik.py err badAuthorization
python3 isapi/tools/hik.py field detectionTarget
python3 isapi/tools/hik.py stats

# SQL
sqlite3 isapi/openapi/catalog.sqlite \
  "SELECT method,path FROM endpoint WHERE path LIKE '%SecurityCP%'"
sqlite3 isapi/openapi/catalog.sqlite \
  "SELECT e.method,e.path FROM endpoint_fts f JOIN endpoint e ON e.id=f.rowid
   WHERE endpoint_fts MATCH 'anpr' LIMIT 20"
```

## Cómo leer un schema

Los manuales documentan cada mensaje como un XML de ejemplo con comentarios
anotados. Esta línea:

```xml
<sensitivityLevel>
  <!--ro, opt, int, range:[0,100], unit:s, dep:and,{$.LaserLight.mode,eq,manual}-->0
</sensitivityLevel>
```

se convierte en:

```yaml
sensitivityLevel:
  type: integer
  readOnly: true          # ro   (rw = lectura/escritura, wo = sólo escritura)
  minimum: 0              # range:[0,100]
  maximum: 100
  x-hik-unit: s
  x-hik-dep: "and,{$.LaserLight.mode,eq,manual}"   # sólo aplica si mode==manual
  examples: [0]
  xml: {name: sensitivityLevel}
```

`req`/`opt` van al `required` del objeto padre. Los `enum` salen del atributo
`opt="a,b,c"` del ejemplo (`x-hik-enum-source: sample-attribute`) o del Field
Dictionary (`x-hik-enum-source: field-dictionary`).

**Modelado XML** (importante: el schema describe el XML real, no un JSON):

- elemento → propiedad con `xml.name`
- atributo → propiedad prefijada `@`, con `xml.attribute: true`
- elemento con atributos **y** texto → objeto con `@attr` + `#text`
- `array, subType:object` o hermanos repetidos → `type: array` con `xml.wrapped`

## Extensiones `x-hik-*`

| Extensión | Dónde | Significado |
|---|---|---|
| `x-hik-source` | operación | `{document, section, page, breadcrumb}` — trazabilidad al PDF |
| `x-hik-family` / `x-hik-devices` | operación | a qué familia de equipos aplica |
| `x-hik-schema-version` | operación / schema | versión del esquema (`ver10` → 1.0, `ver20` → 2.0) |
| `x-hik-namespace` | schema | namespace XML del root |
| `x-hik-protocol-version` | schema | atributo `version` del root |
| `x-hik-unit` / `x-hik-step` | campo | unidad (`s`, `ms`, `min`, `°`) y paso |
| `x-hik-dep` | campo | dependencia condicional entre campos |
| `x-hik-enum-source` | campo | de dónde salieron los valores del enum |
| `x-hik-also-documented-in` | operación | el mismo método+path en otra sección del manual |
| `x-hik-parse` | schema | `recovered` = el XML del PDF venía dañado y se reparó |
| `x-hik-json-sample` | body | endpoints que hablan JSON en vez de XML |

## Regenerar

```bash
cd isapi/tools
make all        # extract → parse → openapi → catalog
make validate   # valida los 5 specs contra openapi-spec-validator
```

Pipeline, en orden:

1. `extract.py` — PDF → JSON de líneas. Filtra la marca de agua diagonal por
   dirección de escritura y conserva fuente/negrita/posición.
2. `parse.py` — detecta encabezados numerados y las etiquetas `Request URL` /
   `Query Parameter` / `Request Message` / `Response Message` de cada sección.
3. `xmlblocks.py` — reconstruye los bloques XML: repara comentarios cortados por
   el salto de línea, descarta líneas "fantasma" (el PDF dibuja algunas dos veces,
   la segunda con glifos rotos) y normaliza la línea del root.
4. `annot.py` + `schemagen.py` — parsean la gramática de los comentarios y arman
   el JSON Schema.
5. `build_openapi.py` — un spec por familia, deduplicando schemas por hash.
6. `supplement.py` + `build_catalog.py` — minan endpoints mencionados sólo en
   prosa y arman el catálogo unificado + SQLite.

Agregar un manual nuevo: dejalo en `isapi/`, sumalo a `FAMILIES` en
`build_openapi.py` y al `Makefile`, corré `make all`, regenerá `endpoints.tsv`.

## Verificar contra equipos reales

El catálogo dice lo que dicen los manuales. Lo que tu NVR realmente soporta se
comprueba sondeándolo. `isapi/tools/verify.py` hace **sólo GET** (nunca PUT/POST/DELETE: no
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

## Límites conocidos

- **17 de 1.681** bloques XML se parsearon en modo recuperación
  (`x-hik-parse: recovered`); pueden tener algún campo de menos. Están marcados.
- Los `tier: narrative` **no tienen schema** — el catálogo dice la página del PDF.
- Los `enum` sin `opt=` en el ejemplo salen del Field Dictionary; si el campo no
  está ahí, queda `string` y la descripción trae los valores en prosa.
- Esto es **lo que dicen los manuales**, no lo que responde tu equipo.
  Consultá siempre `*/capabilities`.
- Faltan 6 manuales de Syscom — ver `pending-sources.md` para qué endpoints tapan.
