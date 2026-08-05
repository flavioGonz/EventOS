# GIT — dónde vive el código y cómo se publica

*Actualizado: 5-ago-2026.*

## Las tres copias

EventOS existe en tres lugares que **no se sincronizan solos**. Confundirlos es la causa histórica número uno de "hice el cambio y no pasó nada".

| # | Copia | Dónde | Quién escribe ahí |
|---|---|---|---|
| **A** | Escritorio | `Desktop\CLAUDE PROYECTOS\EventOS` (Windows) | Las herramientas de IA |
| **B** | Producción | `/opt/eventos` en el LXC de EventOS | Despliegues; también se commitea desde acá |
| **C** | GitHub | `https://github.com/flavioGonz/EventOS` | Empuja **B**, con deploy key; y **A**, por HTTPS desde Windows |

> **`main` (C) es la verdad del código.** Si `main` y el escritorio difieren, asumí que `main` está adelante hasta probar lo contrario.

---

## Estado de las ramas

| Rama | Qué es | Estado |
|---|---|---|
| `main` | La verdad. v1.2.0 + kit ISAPI | Al día. Incluye el merge del PR #1 (`isapi-kit`) |
| `escritorio-2026-08` | Snapshot de la carpeta de escritorio | **Historia sin ancestro común con `main`. NO mergear.** Sólo sirve de respaldo |
| `docs-memoria-ia` | Documentación interna | **Contiene secretos operativos. No mergear a `main`; borrar cuando se rote** |
| `isapi-kit` | Kit ISAPI + registro de puntos | Ya mergeada a `main`. Se puede borrar |

`escritorio-2026-08` se creó con un `git init` nuevo, así que **no comparte ningún commit con `main`**. Cualquier `merge` o `rebase` entre las dos es un conflicto total de 151 archivos. Por eso existe el patrón del worktree que está más abajo.

---

## ⚠️ Antes de subir nada: el escritorio NO es un superset de `main`

Medido el 5-ago-2026 comparando la carpeta contra `origin/main`:

- **El escritorio está adelante en `server/`**: todo el trabajo de alarmas y puertas (`events/access.js`, `events/accessEvents.js`, `ingest/doors.js`, `ingest/panels.js`, `tests/`).
- **El escritorio está atrasado en `web/`**: 151 archivos difieren, con **−4903 líneas**. `AlarmCenter.jsx` no existe en el escritorio (−508 líneas). Un push masivo desde la carpeta **borraría el Centro de Alarmas de `main`**.
- También están más nuevos en `main`: `README.md` (secciones de v1.2.0) y `web/src/components/NvrPlayback.jsx` (seek + playhead).

**Regla:** nunca subir la carpeta entera. Archivo por archivo, y para cada uno comprobar qué lado es más nuevo:

```bash
git show origin/main:<archivo> > /tmp/m
diff /tmp/m <archivo> | grep '^<'   # lo que se perdería de main. Si sale algo, PARAR.
```

Si el archivo cambió de forma (código movido a otro módulo), verificar que la funcionalidad siga existiendo en el destino antes de dar por buena la desaparición de las líneas.

---

## Cómo subir a `main` desde Windows

Worktree limpio en `%TEMP%` — **fuera** de la carpeta del proyecto. No toca el árbol de trabajo ni la rama del escritorio, y evita el merge imposible entre historias sin ancestro común.

```powershell
cd "$env:TEMP"
git clone --depth 50 https://github.com/flavioGonz/EventOS.git eos-push
cd eos-push
# copiar encima SOLO los archivos verificados, después:
git add -A
git commit -F mensaje.txt
git push origin main
```

Hay una versión automatizada en `isapi/tools/push-main.ps1`.

> **HTTPS, no SSH.** La máquina de Windows no tiene clave SSH para GitHub (`Permission denied (publickey)`). Con HTTPS, Git Credential Manager abre el navegador la primera vez y deja la credencial guardada. Si pide contraseña por consola, va un **Personal Access Token**, no la contraseña de la cuenta.

### Desde el servidor (B)

El servidor tiene deploy key ed25519 propia en `/opt/eventos/.git_deploy_key`:

```bash
cd /opt/eventos
export GIT_SSH_COMMAND="ssh -i /opt/eventos/.git_deploy_key -o IdentitiesOnly=yes"
git add -A && git commit -m "..." && git push
```

---

## ⚠️ Lo que una IA en la nube NO puede hacer

Verificado el 5-ago-2026 desde el sandbox de Cowork:

- **Leer el repo: sí.** `git clone` / `git ls-remote` funcionan.
- **Pushear: no.** El proxy de egress corta por repositorio: `access denied by the git proxy: ... is not in this session's authorized repository set`.
- **Un token propio no ayuda:** el proxy descarta la credencial que uno ponga y sustituye la suya (un token falso devuelve 200).
- **Una clave SSH tampoco:** no hay cliente `ssh` en el contenedor, no hay ruta al puerto 22, y el entorno reescribe `git@github.com:` a HTTPS.
- **La otra mano** (`device_bash`, que corre en la máquina de Nico) **no tiene salida a internet.**

**Las dos formas de que la IA pushee sola:**

1. **Correr la tarea "on your computer"** (app de escritorio → selector "Run this task", o Settings → Cowork). Ahí el shell es la máquina de Nico y usa Git Credential Manager: la IA commitea y pushea directo.
2. **Adjuntar el repo a la sesión** como fuente autorizada, si el entorno lo permite — es lo que pide el propio mensaje del proxy.

Como puente, `deploy/autopush/SUBIR.cmd` empuja lo que la IA haya dejado encolado en `_push/queue/` (bundles de git). Se corre a mano, cuando uno quiere; no hay tarea programada.

---

## ⚠️ `git` no funciona directo sobre la carpeta montada de Cowork

`git init` sobre el mount deja `.git/config` lleno de NULs y no puede hacer unlink de los `.lock` (git usa write-temp + rename + unlink; el mount no lo soporta).

- **No correr desde el mount ningún git que escriba el index** — deja `index.lock` huérfano.
- Para leer estado sin dejar locks: `git --no-optional-locks status`.
- Patrón que funciona: git dir fuera del mount, work-tree adentro (`GIT_DIR=/tmp/gt/.git GIT_WORK_TREE=<mount>`), y copiar `.git` de vuelta al final verificando con md5.
- En el mount **no se puede `rm`**: lo que sobra va con `mv` a `_to_delete/` (gitignorado por `/_*`).

---

## Lo que NUNCA se commitea

- `server/data/` — configuración con **credenciales de los NVR**, eventos, evidencia, log de operadores
- `.git_deploy_key*` — la clave privada de despliegue
- `docs/memory/` — notas internas con credenciales de infraestructura
- `.env`, `node_modules/`, `dist/`, `*.bak*`, `*.tgz`, `/_*`

El historial original tenía un commit con secretos; se descartó con un commit orphan limpio antes del primer push. Mantengámoslo así.

> **Visibilidad del repo.** Este repositorio figuró como **público**. Mientras lo sea, no subir documentación de infraestructura (IPs internas, topología, procedimientos de acceso) ni nada bajo `docs/memory/`. Si estuvo público con esos archivos en alguna rama, **rotar las credenciales**: borrar el archivo no alcanza, GitHub pudo servirlo a cachés y forks.
