#!/usr/bin/env bash
# =====================================================================
# EventOS — Provisión del contenedor LXC en el HOST Proxmox (pve03)
# ---------------------------------------------------------------------
# ESTE SCRIPT SE CORRE EN EL NODO PROXMOX (pve03), NO dentro del CT.
# Crea un contenedor Debian 12 listo para correr deploy/install.sh.
#
#   # En pve03, como root:
#   bash provision-lxc.sh
#
# Flujo:
#   1) Pregunta parámetros (con defaults sensatos).
#   2) Descarga la plantilla Debian 12 si falta (pveam).
#   3) Crea el CT (pct create) y lo arranca (pct start).
#   4) Espera red, instala git/curl dentro, y (opcional) clona el repo
#      y corre deploy/install.sh automáticamente.
# =====================================================================
set -euo pipefail

c_b="\033[1m"; c_g="\033[32m"; c_y="\033[33m"; c_r="\033[31m"; c_0="\033[0m"
say(){ echo -e "${c_b}==>${c_0} $*"; }
ok(){  echo -e "${c_g}OK${c_0} $*"; }
warn(){ echo -e "${c_y}!!${c_0} $*"; }
die(){ echo -e "${c_r}ERROR:${c_0} $*" >&2; exit 1; }
ask(){ local p="$1" d="${2:-}" v; read -rp "$(echo -e "$p${d:+ [$d]}: ")" v; echo "${v:-$d}"; }
asksec(){ local p="$1" v; read -rsp "$(echo -e "$p: ")" v; echo >&2; echo "$v"; }
yesno(){ local p="$1" d="${2:-s}" v; read -rp "$(echo -e "$p [s/n] ($d): ")" v; v="${v:-$d}"; [[ "$v" =~ ^[sSyY] ]]; }

# Debe correr en un nodo Proxmox (tiene el binario pct).
command -v pct >/dev/null || die "No encuentro 'pct'. Este script corre en el HOST Proxmox (pve03)."
[ "$(id -u)" -eq 0 ] || die "Ejecuta como root en el host Proxmox."

echo -e "${c_b}===== EventOS — provisión LXC (Proxmox) =====${c_0}"

# ---------------------------------------------------------------- 1) Parámetros del CT
CTID=$(ask "ID del contenedor (CTID)" "203")
pct status "$CTID" >/dev/null 2>&1 && die "El CTID $CTID ya existe. Elegí otro o borralo con: pct destroy $CTID"

HOSTNAME=$(ask "Hostname del contenedor" "eventos")
CORES=$(ask "Núcleos (cores)" "2")
MEMORY=$(ask "Memoria RAM en MB" "2048")
DISK=$(ask "Disco rootfs en GB" "8")
ROOTFS_STORE=$(ask "Storage para el rootfs" "local-lvm")
TPL_STORE=$(ask "Storage donde viven las plantillas (template)" "local")
BRIDGE=$(ask "Bridge de red" "vmbr0")

# ---------------------------------------------------------------- 2) Red (DHCP o estática)
# La red del cluster es 192.168.99.x. La app hermana (Preventis) es .7 (CT 107).
if yesno "¿Usar DHCP para la red? (n = IP estática 192.168.99.x)" "n"; then
  NET_IP="dhcp"; GATEWAY=""; NAMESERVER=$(ask "Nameserver (DNS)" "192.168.99.1")
else
  NET_IP=$(ask "IP/CIDR estática" "192.168.99.13/24")
  GATEWAY=$(ask "Gateway" "192.168.99.1")
  NAMESERVER=$(ask "Nameserver (DNS)" "192.168.99.1")
fi

# ---------------------------------------------------------------- 3) Credenciales de acceso
# Inyectamos password root y/o una clave SSH pública para administrar el CT.
ROOT_PW=""; SSH_PUBKEY_FILE=""
if yesno "¿Definir contraseña de root para el CT?" "s"; then
  ROOT_PW=$(asksec "Contraseña root del contenedor")
  [ -n "$ROOT_PW" ] || die "Contraseña vacía."
fi
if yesno "¿Inyectar una clave SSH pública (~/.ssh/authorized_keys del root del CT)?" "n"; then
  SSH_PUBKEY_FILE=$(ask "Ruta al archivo .pub" "$HOME/.ssh/id_rsa.pub")
  [ -f "$SSH_PUBKEY_FILE" ] || die "No existe el archivo de clave: $SSH_PUBKEY_FILE"
fi
[ -n "$ROOT_PW" ] || [ -n "$SSH_PUBKEY_FILE" ] || warn "Sin password ni clave SSH: no podrás entrar al CT hasta configurarlo por consola."

# ---------------------------------------------------------------- 4) Plantilla Debian 12
say "Buscando plantilla Debian 12..."
# ¿Hay ya una plantilla debian-12-standard descargada en el storage de templates?
TEMPLATE="$(pveam list "$TPL_STORE" 2>/dev/null | awk '/debian-12-standard/ {print $1}' | sort | tail -n1 || true)"
if [ -z "$TEMPLATE" ]; then
  say "No hay plantilla local; consultando disponibles (pveam available)..."
  pveam update >/dev/null 2>&1 || true
  AVAIL="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort | tail -n1 || true)"
  [ -n "$AVAIL" ] || die "No encuentro debian-12-standard en pveam available. Revisá el repositorio de plantillas."
  say "Descargando $AVAIL en $TPL_STORE..."
  pveam download "$TPL_STORE" "$AVAIL"
  TEMPLATE="$TPL_STORE:vztmpl/$AVAIL"
else
  # pveam list ya devuelve el volid completo (storage:vztmpl/archivo)
  TEMPLATE="$TEMPLATE"
fi
ok "Plantilla: $TEMPLATE"

# ---------------------------------------------------------------- 5) Crear el contenedor
# Unprivileged + nesting=1 (necesario para algunas instalaciones de Node/npm
# y para que ciertos servicios corran bien dentro del CT no privilegiado).
say "Creando CT $CTID ($HOSTNAME)..."
NET0="name=eth0,bridge=$BRIDGE"
if [ "$NET_IP" = "dhcp" ]; then
  NET0="$NET0,ip=dhcp"
else
  NET0="$NET0,ip=$NET_IP,gw=$GATEWAY"
fi

CREATE_ARGS=(
  "$CTID" "$TEMPLATE"
  --hostname "$HOSTNAME"
  --cores "$CORES"
  --memory "$MEMORY"
  --swap "$MEMORY"
  --rootfs "$ROOTFS_STORE:$DISK"
  --net0 "$NET0"
  --nameserver "$NAMESERVER"
  --unprivileged 1
  --features nesting=1
  --onboot 1
)
[ -n "$ROOT_PW" ] && CREATE_ARGS+=( --password "$ROOT_PW" )
[ -n "$SSH_PUBKEY_FILE" ] && CREATE_ARGS+=( --ssh-public-keys "$SSH_PUBKEY_FILE" )

pct create "${CREATE_ARGS[@]}"
ok "CT $CTID creado."

say "Arrancando CT $CTID..."
pct start "$CTID"

# ---------------------------------------------------------------- 6) Esperar red
say "Esperando a que el contenedor tenga red..."
for i in $(seq 1 30); do
  if pct exec "$CTID" -- sh -c 'getent hosts deb.debian.org >/dev/null 2>&1 || ping -c1 -W1 1.1.1.1 >/dev/null 2>&1'; then
    break
  fi
  sleep 2
done
ok "Red lista (o tiempo de espera agotado; continuamos)."

# ---------------------------------------------------------------- 7) Preparar el CT
say "Instalando git y curl dentro del CT..."
pct exec "$CTID" -- bash -lc 'export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y git curl ca-certificates'
ok "Herramientas base instaladas."

# ---------------------------------------------------------------- 8) (Opcional) instalar EventOS automáticamente
APP_DIR="/opt/eventos"
if yesno "¿Clonar el repo y correr deploy/install.sh dentro del CT ahora?" "n"; then
  REPO=$(ask "Repositorio Git de EventOS" "https://github.com/flavioGonz/eventos.git")
  BRANCH=$(ask "Rama" "main")
  say "Clonando $REPO en $APP_DIR (dentro del CT)..."
  pct exec "$CTID" -- bash -lc "git clone --depth 1 -b '$BRANCH' '$REPO' '$APP_DIR'"
  say "Ejecutando install.sh dentro del CT (interactivo)..."
  warn "El instalador te hará preguntas; respondé en esta misma consola."
  pct exec "$CTID" -- bash -lc "bash '$APP_DIR/deploy/install.sh'"
  ok "Instalación dentro del CT finalizada."
else
  echo
  echo -e "${c_g}========================================================${c_0}"
  echo -e "${c_b} CT $CTID ($HOSTNAME) listo${c_0}"
  echo -e "${c_g}========================================================${c_0}"
  echo " IP:        ${NET_IP}"
  echo
  echo " Próximos pasos — entrá al contenedor e instalá EventOS:"
  echo "   pct enter $CTID"
  echo "   git clone <REPO_EVENTOS> $APP_DIR     # o copiá el código a $APP_DIR"
  echo "   bash $APP_DIR/deploy/install.sh"
  echo -e "${c_g}========================================================${c_0}"
fi
