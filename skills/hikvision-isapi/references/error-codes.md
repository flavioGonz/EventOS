# Códigos de error ISAPI (debug de respuestas)

ISAPI devuelve un `<ResponseStatus>` (XML) o JSON equivalente. **No confíes solo
en HTTP 200** — parseá el cuerpo. Campos: `statusCode` (nivel alto), `statusString`,
`subStatusCode` (string), `errorCode` (hex).

## statusCode (nivel alto)
| código | significado |
|---|---|
| 1 | OK |
| 2 | Device Busy (ocupado/sin respuesta -> reintentar) |
| 3 | Device Error |
| 4 | Invalid Operation (no soportado / sin permiso / auth) |
| 5 | Invalid Format |
| 6 | Invalid Content (parámetros/XML/JSON mal) |
| 7 | Reboot Required |
| 8 | Batch Operation |

## subStatusCode más útiles
- `notSupport` (0x40000001) — la función NO existe en este modelo/firmware -> consultá `*/capabilities`.
- `lowPrivilege` (0x40000002) — el usuario no tiene permiso.
- `badAuthorization` (0x40000003) — autenticación falló (usuario/clave/digest).
- `invalidOperation` (0x40000006) — comando inválido.
- `notActivated` (0x40000007) — equipo sin activar.
- `deviceBusy` (0x20000004) — ocupado -> reintentar.
- `badParameters` (0x60000001) · `badXmlContent` (0x60000003) · `badJsonContent` (0x60000017) — cuerpo mal formado.
- `riskPassword` (0x10000002) — clave débil (statusCode 1=OK; es advertencia).

> Tabla COMPLETA (2270 códigos): `isapi/.../ErrorCode.xlsx`.
