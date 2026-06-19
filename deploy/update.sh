#!/usr/bin/env bash
# =====================================================================
# EventOS — actualización (git pull si aplica + build + restart)
#   sudo bash /opt/eventos/deploy/update.sh [APP_DIR] [BRANCH]
# Si $APP_DIR no es un repo Git, se omite el pull y solo se reinstala/
# recompila lo que ya esté presente (deploy manual).
# =====================================================================
set -euo pipefail

APP_DIR="${1:-/opt/eventos}"
BRANCH="${2:-main}"
SVC_USER="eventos"
PORT=4010

c_b="\033[1m"; c_g="\033[32m"; c_y="\033[33m"; c_0="\033[0m"
say(){ echo -e "${c_b}==>${c_0} $*"; }
warn(){ echo -e "${c_y}!!${c_0} $*"; }

[ "$(id -u)" -eq 0 ] || { echo "Ejecuta como root (sudo)."; exit 1; }
[ -d "$APP_DIR/server" ] && [ -d "$APP_DIR/web" ] || { echo "No encuentro server/ y web/ en $APP_DIR (¿corriste install.sh?)"; exit 1; }

if [ -d "$APP_DIR/.git" ]; then
  say "Actualizando código desde origin/$BRANCH..."
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  warn "$APP_DIR no es un repo Git: se omite el pull (deploy manual)."
fi

say "Backend: dependencias"
( cd "$APP_DIR/server" && { npm ci --omit=dev || npm install --omit=dev; } )

say "Frontend: build"
( cd "$APP_DIR/web" && { npm ci || npm install; } && npm run build )

say "Permisos"
chmod -R a+rX "$APP_DIR/server" "$APP_DIR/web/dist"

say "Reiniciando servicios"
systemctl restart eventos-api
nginx -t && systemctl reload nginx

sleep 2
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo -e "${c_g}Actualizado OK — API arriba (health 200).${c_0}"
else
  echo "API no respondió health; revisa: journalctl -u eventos-api -n 50"
  exit 1
fi
