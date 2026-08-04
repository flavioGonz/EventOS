# Fuentes pendientes — qué falta y qué endpoints tapa

El catálogo actual sale de **5 manuales ISAPI** (DeepinView, Value Cameras,
DVR Pro AcuSense, DVR Value, ANPR). El portal de desarrolladores de Syscom
(`https://desarrolladores.syscom.mx/?search=ISAPI`) publica **6 proyectos más**
que todavía no están incorporados. Estado: acordado sumarlos, sin fecha.

## Huecos concretos detectados

Endpoints que EventOS usa o va a usar y que **no aparecen formalmente** en ninguno
de los 5 manuales que tenemos (o aparecen sólo mencionados en prosa):

| Falta | Dónde debería estar |
|---|---|
| `GET /ISAPI/System/deviceInfo` (¡el más básico!) | API - General (Videovigilancia) |
| `/ISAPI/Security/users` — gestión de usuarios | API - General |
| `/ISAPI/System/IO/outputs/<n>/trigger` — relés | API - General |
| `/ISAPI/Streaming/channels/<ch>01/picture` — snapshot | API - General |
| `/ISAPI/Event/notification/httpHosts` — alarm host / webhook | API - General o Análisis y Eventos |
| `/ISAPI/Event/notification/alertStream` (hoy sólo `tier: narrative`) | Análisis Inteligente y Eventos |
| `subscribeEvent` / `unSubscribeEvent` completos | Análisis Inteligente y Eventos |
| Puertas, tarjetas, personas, huellas, anti-passback | Control de acceso basado en personas |
| Panel AX vía IP Receiver Pro | Integrar paneles AXPRO |

## Los 6 proyectos, por prioridad

1. **API - General (Videovigilancia)** — el que más falta. Cámaras IP, DVR y NVR:
   deviceInfo, usuarios, IO/relés, streaming/snapshot, red. Tapa la mayoría de los
   huecos de arriba.
2. **API - Análisis Inteligente y Eventos** — configuración de eventos/alarmas
   inteligentes y **recepción de eventos** documentada formalmente. Core de EventOS.
3. **API - Control de acceso basado en personas** — horarios, personas/tarjetas/
   huellas, control de puertas/ascensores/zumbador, anti-passback.
4. **API - Cámaras de entrada y salida** — detección de vehículos, captura de
   patente y rostro, características del vehículo.
5. **Integrar biométricos faciales Hikvision** — incluye colección Postman.
6. **AXPro vía IP Receiver Pro V2.3.0.4** (video demostrativo) y
   **HikGateway** Windows/Linux (demo C# + colección Postman).

## Cómo sumarlos cuando estén

1. Descargar el proyecto de Syscom y descomprimir en `isapi/<nombre>/`.
2. Si trae PDF ISAPI con el formato estándar (secciones `Request URL` /
   `Query Parameter` / `Request Message` / `Response Message`), el pipeline lo
   procesa tal cual: agregarlo a `FAMILIES` en `build_openapi.py` y al `Makefile`.
3. Si trae **colección Postman** en vez de PDF, es una fuente distinta: los
   endpoints se pueden importar directo del JSON de Postman (ya vienen con
   método, URL y body) y marcarse con `tier: postman`.
4. Correr `make all` y regenerar `assets/endpoints.tsv` de esta skill.
5. Anotar acá qué se incorporó y qué huecos quedaron cerrados.
