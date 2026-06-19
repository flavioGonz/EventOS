# Analíticas Smart, DeepinView (humano/vehículo, rostro) y ANPR

## Smart (cruce de línea, intrusión, zonas)
Geometría y reglas por canal en `/ISAPI/Smart/<Tipo>/<ch>`:
- `/ISAPI/Smart/LineDetection/<ch>` — cruce de línea (`LineItemList`: 2 puntos + dirección).
- `/ISAPI/Smart/FieldDetection/<ch>` — intrusión (polígono `RegionCoordinatesList`).
- `/ISAPI/Smart/regionEntrance/<ch>` · `/ISAPI/Smart/regionExiting/<ch>` — entrada/salida de zona.
- `/ISAPI/Smart/loitering/<ch>`, `/ISAPI/Smart/AudioDetection`, etc.
- `GET /ISAPI/Smart/capabilities` → qué analíticas soporta.
- **Coordenadas normalizadas 0–1000**, origen abajo-izquierda → para dibujar
  sobre el video hay que **invertir Y** (`y' = 1000 - y`). (Así lo hace EventOS.)

## DeepinView — clasificación de objetivo (humano / vehículo / rostro)
- Las cámaras DeepinView/AcuSense clasifican el objetivo y lo adjuntan al evento:
  `targetType` / `detectionTarget` (`human`, `vehicle`, …) y eventos dedicados
  como `humanRecognition`, `facedetection`. Sirve para **filtrar falsas alarmas**
  (solo persona/vehículo).
- `/ISAPI/Intelligent/...` — config de analítica inteligente; `/ISAPI/Intelligent/FDLib`
  = biblioteca de rostros (face library), `pictureUpload` para cargar rostros.
- `/ISAPI/Intelligent/AIOpenPlatform` y `/ISAPI/Custom/OpenPlatform` — modelos de IA cargables.
- **Lección EventOS:** muchos eventos llegan SIN `target` (la cámara no clasificó);
  el filtro por objetivo solo aplica cuando la cámara/firmware AcuSense lo provee.
  Para más cobertura → habilitar la clasificación humano/vehículo en cada cámara.

## ANPR / Tráfico (cámaras ITC)
- `GET /ISAPI/ITC/capabilities`, `/ISAPI/ITC/TriggerMode/capabilities` — capacidades de la cámara de tráfico.
- `/ISAPI/Traffic/channels/<ch>/...` — config (cameraInfo, vehicleWeight, etc.).
- El evento ANPR trae la **matrícula** (plate), país/región, color, tipo de
  vehículo, y normalmente una imagen del vehículo + recorte de la patente.
- Mapeo: ANPR/LPR → objetivo `vehicle` en EventOS.
- Detalle completo de campos en el PDF *ISAPI Vehicle Access Control — ANPR*.

## Enums reales (del Field Dictionary oficial)
- **`detectionTarget`** (clasificación IA): `human` · `vehicle` · `human_vehicle`. **Este es el campo para filtrar persona/vehículo** (no el `targetType` numérico, que es tipo de escena/analítica).
- **ANPR / vehículo:**
  - `vehicleType`: SUVMPV, bus, largeBus, mediumBus, lightTruck, mediumHeavyTruck, containerTruck, concreteMixer, crane, coupe, hatchback…
  - `vehicleColor`: black, blue, brown, cyan, deepBlue, deepGray, gray, green, orange, pink, purple, red…
  - `plateType`: civil, police (arm), embassy, consulate, coach, emergency, civilAviation, farmVehicle…
  - `directionIndex`: forward, back, eastWest, westEast, northSouth, southNorth (+ diagonales)…
  - `vehicleEntryExitingStatus`: `vehicleEnter` · `vehicleExit`.
> Diccionario COMPLETO (1955 entradas): `isapi/.../Field Dictionary.xlsx`.