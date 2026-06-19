# Salidas/relés, paneles AX, control de accesos, EHome/ISUP

## Relés / salidas IO (abrir puertas) — "relé IP"
- **Disparar una salida** (cámara/NVR con salida de alarma):
  `PUT /ISAPI/System/IO/outputs/<n>/trigger`
  body XML: `<IOPortData><outputState>high</outputState></IOPortData>`
  (pulso → cierra/abre el relé un instante). `<n>` = nº de salida.
- Estado/listado: `GET /ISAPI/System/IO/outputs` · `/ISAPI/System/IO/outputs/<n>/status`.
- **EventOS** expone `POST /api/device/:id/relay {output,kind}` que arma este PUT
  por digest. `kind:'hik-io'` (default) usa la ruta de arriba.
- ⚠️ Abrir una puerta es **acción física**: en EventOS el botón "Abrir" pide
  **confirmación del operador** y nunca se dispara desde contenido externo.

## Paneles de alarma AX (AX Pro / AX Hybrid)
- Usan el ISAPI **SecurityCP**:
  - Salidas/relés: `PUT /ISAPI/SecurityCP/control/outputs/<id>?format=json`
    body `{"OutputsCtrl":{"switch":"open"}}`. (EventOS: `kind:'ax'`.)
  - Zonas/áreas: `/ISAPI/SecurityCP/status/...`, armado/desarmado:
    `/ISAPI/SecurityCP/control/...`.
- **Eventos del AX:** si expone `/ISAPI/Event/notification/alertStream` local,
  se recibe IGUAL que un NVR (reusar alertStream) — sin nube. Alternativa: que el
  panel haga PUSH a un webhook (subscribeEvent / "alarm host").
- Si el AX responde al ISAPI SecurityCP por LAN, casi seguro también da el
  alertStream local → esa es la vía recomendada (verificado conceptualmente en EventOS).

## EHome / ISUP (reporte a central tipo HikCentral)
- **EHome (ISUP)** es el protocolo **binario propietario** (TCP) con el que los
  equipos Hik se registran y reportan a una plataforma central (HikCentral).
  Mencionado en los docs ISAPI pero es OTRO protocolo (no HTTP/ISAPI).
- **EventOS NO implementa ISUP** (requeriría un servidor ISUP/SDK). Para integrar
  paneles que "solo hacen ISUP", la vía sin desarrollar ISUP es usar su **ISAPI
  local** (alertStream / SecurityCP) por LAN/VPN. Ver decisión en la doc del proyecto.
