# Eventos de control de acceso y linkage (AX / puertas / zonas)

Para paneles AX, controladores de puerta y zonas, Hik clasifica los eventos en
**5 tipos mayores**, cada uno con tipos menores (código hex):
- **0x1 Alarm Events** — Alarm Input/Output, Motion start/stop, Tampering, VCA,
  Network alarm, y zonas: cortocircuito (0x400), desconectada (0x401),
  excepción (0x402), restaurada (0x403)…
- **0x2 Exception Events** — fallas del sistema.
- **0x3 Operation Events** — armado/desarmado, accesos.
- **0x4 Additional Information** · **0x5 Other Events**.

## Linkage types (acción enlazada al evento)
Notificar al **centro de vigilancia** (`center` — necesario para que EMPUJE por
alertStream, ver `events.md`), activar **salida/relé** (abrir puerta, ver
`io-access.md`), grabar, beep, email, etc.

> Taxonomía COMPLETA (mayor/menor + hex + linkage): `isapi/.../Access Control Event Types and Event Linkage Types.pdf`.
> Países/regiones (ANPR): `Country and Region Code.pdf` / `Region Code.pdf`.
