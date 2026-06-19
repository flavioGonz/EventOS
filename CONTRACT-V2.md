# EventOS — Contrato v2 (Admin + Balanceo + Diseño)

Extiende `CONTRACT.md` (v1). Añade: módulo de **administración** persistente, motor de
**balanceo/dispatch**, y el **sistema de diseño** (Apple / liquid-glass, dark+light).
Esta es la fuente de verdad de la fase 2.

---

## 1. Almacén de configuración (persistente)

Documento JSON único en disco: **`server/data/eventos.config.json`** (creado/seed en el
primer arranque). Acceso por un módulo `server/src/config/store.js` (load/save atómico,
watch en memoria, getters/setters por colección). Debe sobrevivir reinicios.

> systemd: `install.sh` debe añadir `ReadWritePaths=$APP_DIR/server/data` al unit y crear
> el dir con dueño `eventos`. (ProtectSystem=strict bloquea escrituras fuera de ahí.)

Colecciones:

```jsonc
{
  "sites":      [ { "id":"site_x","name":"Planta Central","address":"","notes":"" } ],
  "devices":    [ { "id":"dev_x","name":"Cámara Acceso Norte","type":"hikvision",
                    "vendor":"Hikvision","ip":"192.168.99.50","channel":1,
                    "siteId":"site_x","enabled":true,"defaultPriority":null,"tags":[] } ],
  "operators":  [ { "id":"op_x","name":"Ana","skills":["video","access"],"active":true } ],
  "procedures": [ { "id":"proc_intrusion","name":"Intrusión","slaSeconds":60,
                    "steps":["…","…"] } ],
  "rules":      [ { "id":"r_x","name":"Intrusiones críticas","enabled":true,"order":10,
                    "match":{ "type":["intrusion","alarm","door_forced"],
                              "category":[], "deviceId":[], "siteId":[] },
                    "actions":{ "setPriority":1, "procedureId":"proc_intrusion",
                                "dispatchMode":"simultaneous", "skills":["intrusion"],
                                "operatorIds":[] } } ],
  "dispatch":   { "mode":"simultaneous",            // simultaneous | sequential | rules
                  "sequentialStrategy":"least_loaded", // round_robin | least_loaded
                  "ackTimeoutSeconds":30,
                  "reassignOnTimeout":true,
                  "maxConcurrentPerOperator":5,
                  "skillRouting":true }              // filtrar candidatos por skill
}
```

En el primer arranque, **seed** desde los defaults v1 (`rules/defaults.js`,
`simulator` device names, catálogo). Las reglas/procedimientos del store **sustituyen** a
los seeds en memoria: `rules/engine.js` lee del store.

---

## 2. API de administración (`/api/admin`)

Auth: header **`X-Admin-Token`** = `ADMIN_TOKEN` (env). Si `ADMIN_TOKEN` no está definido,
las rutas admin quedan abiertas (modo dev). El instalador genera `ADMIN_TOKEN`.
`401` si hay token configurado y no coincide.

| Método | Ruta | Acción |
|--------|------|--------|
| GET | `/api/admin/config` | documento completo |
| GET/POST | `/api/admin/devices` | listar / crear |
| PUT/DELETE | `/api/admin/devices/:id` | editar / borrar |
| … | `/api/admin/sites`, `/operators`, `/rules`, `/procedures` | igual patrón CRUD |
| GET/PUT | `/api/admin/dispatch` | leer / actualizar política de balanceo |
| GET | `/api/admin/reception` | token de ingesta + URLs webhook por endpoint/dispositivo |
| POST | `/api/admin/ping` | valida `X-Admin-Token` (para el login del panel) |

Toda mutación: valida, persiste en el store, y **aplica en vivo** (el motor de dispatch y
el de reglas leen siempre del store). Devuelve el objeto creado/actualizado.

`GET /api/health` debe añadir `dispatch:{mode}` y `devices`/`rules` counts.

---

## 3. Motor de balanceo / dispatch (`server/src/dispatch/engine.js`)

Al recibir un evento (tras normalizar + aplicar reglas del store):

1. **Modo efectivo**: si `dispatch.mode==="rules"`, usar `actions.dispatchMode` de la regla
   que casó (fallback `simultaneous`); si no, usar `dispatch.mode` global.
2. **Candidatos**: operarios **online** (del runtime, no del roster admin) filtrados por
   `actions.operatorIds` si la regla los fija; si no y `skillRouting`, por skill que matchee
   `category`/`type`/skills de la regla; descartar los que llegan a `maxConcurrentPerOperator`.
3. Según el modo:
   - **simultaneous** → broadcast `event:new` a todos los candidatos (o a toda la consola si
     no hay filtro). `assignedTo=null` hasta que alguien haga `event:claim` (primero en tomar).
   - **sequential** → elegir UN candidato (`round_robin` o `least_loaded`), `assignedTo=op`,
     `status="assigned"`, emitir `event:new` **dirigido** a ese operario + `event:update` al
     resto. Armar timer `ackTimeoutSeconds`: si no hay `event:ack`/`claim`/`progress` a tiempo
     y `reassignOnTimeout`, reasignar al siguiente candidato (log `action:"reassign"`),
     y si se agotan, caer a broadcast.
   - Sin candidatos online → quedar `new` sin asignar y broadcast (fallback).
4. Cancelar timers al recibir ack/claim/resolve/escalate.

Requiere que el socket layer mantenga `operatorId → socketId(s)` para emisión dirigida
(`nsp.to(socketId).emit(...)`). Añadir helpers en `dispatch/store.js` para online ops + load.
El simulador y la ingesta pasan por el mismo motor.

Eventos socket nuevos (servidor→cliente): `event:assigned {event, operatorId}` (opcional,
para resaltar "es tuyo"). Mantener compatibilidad con los nombres de v1 (§4 de CONTRACT.md).

---

## 4. Sistema de diseño (`web/src/ui/`) — Apple / Liquid Glass

Estética: **profesional, sobria, Apple**. Superficies de **vidrio translúcido** (glassmorphism
con un toque "liquid glass": brillo especular sutil, bordes finos con gradiente, sombras
suaves, radios grandes). **Dark y light conmutables** (persistido + respeta `prefers-color-scheme`).
Animaciones **ultra-rápidas y profesionales**: 120–180 ms, easing tipo spring; transform/opacity
(GPU), nunca layout. Nada estridente.

### Tokens (CSS custom properties, en `web/src/ui/theme.css`)
Definir en `:root` (light) y `[data-theme="dark"]`:
- Color: `--bg`, `--bg-elev`, `--text`, `--text-dim`, `--text-faint`, `--accent`
  (azul Apple `#0A84FF` dark / `#0071E3` light), `--accent-weak`, `--ok`, `--warn`, `--crit`,
  `--border`, `--separator`.
- **Prioridad** (coherente con el póster *Umbral Cinético*): `--p1`#FF453A · `--p2`#FF9F0A ·
  `--p3`#FFD60A · `--p4`#30D6C8 · `--p5`#8E97A3 (ajustar por tema).
- Glass: `--glass-bg` (rgba translúcido por tema), `--glass-border`, `--glass-blur` (p.ej.
  `saturate(180%) blur(20px)`), `--glass-shadow`, `--glass-highlight` (gradiente de brillo).
- Radios: `--r-sm` 10, `--r` 14, `--r-lg` 20, `--r-xl` 28.
- Motion: `--dur-1` 120ms, `--dur-2` 160ms, `--ease-spring` `cubic-bezier(.22,1,.36,1)`,
  `--ease-out` `cubic-bezier(.2,.8,.2,1)`.
- Tipografía: Inter variable (`@fontsource-variable/inter`) + stack
  `system-ui,-apple-system,"Segoe UI",sans-serif`. Tabular-nums para datos.

### Clase glass
`.glass` = `background:var(--glass-bg); backdrop-filter:var(--glass-blur);
border:1px solid var(--glass-border); border-radius:var(--r-lg);
box-shadow:var(--glass-shadow);` + pseudo `::before` con `--glass-highlight` (sheen superior).
Con `-webkit-backdrop-filter` para Safari. Fallback sólido si no hay backdrop-filter.

### Primitivas compartidas (`web/src/ui/primitives.jsx`) — usadas por admin Y consola
`ThemeProvider`/`useTheme` (en `ui/ThemeProvider.jsx`), `Glass`, `Panel`, `Button`
(variants: primary/secondary/ghost/danger; sizes sm/md), `IconButton`, `Switch` (toggle iOS),
`Segmented` (segmented control), `Field`+`TextInput`/`Select`/`Textarea`, `Modal` (con scrim
blur + spring in), `Badge`, `Tag`, `Tooltip` (simple), `Spinner`, `EmptyState`.
Iconos en `web/src/ui/icons.jsx` (SVG inline, stroke fino 1.5, estilo Apple).

### Shell de la app (`App.jsx`, lo escribe el orquestador)
`react-router-dom` v6. Topbar glass con: marca EventOS, **navegación** Consola ⟷
Administración, conmutador de tema (sol/luna con transición rápida), estado de operario.
Rutas: `/` consola del operario (v1 restyleada), `/admin/*` panel admin. nginx ya hace
fallback SPA a `index.html`.

> Reglas de propiedad de archivos (para no pisarse):
> - **ui/**, **App.jsx**, **main.jsx**, **package.json**, **theme.css** → orquestador.
> - **admin/** (páginas nuevas) + `lib/adminApi.js` → agente Admin-UI.
> - **components/** (consola existente) + sus estilos → agente Restyle-consola.
> - **server/** → agente Backend-admin.
