#!/usr/bin/env bash
# =====================================================================
# EventOS — Instalador interactivo (Debian / Ubuntu)
# Centro de monitoreo / ARC. Despliega: API (Node/Express + Socket.io)
# + frontend (React/Vite) detrás de nginx, con Redis local y systemd
# endurecido. El usuario de servicio escucha solo en 127.0.0.1.
#
#   sudo bash deploy/install.sh
#   # o, en un server limpio:
#   git clone https://github.com/flavioGonz/eventos /opt/eventos && \
#     sudo bash /opt/eventos/deploy/install.sh
#   # también funciona si el código YA está presente en $APP_DIR
#   # (con server/ y web/): salta el clone y usa lo que haya.
# =====================================================================
set -euo pipefail

REPO_DEFAULT="https://github.com/flavioGonz/eventos.git"
APP_DIR_DEFAULT="/opt/eventos"
SVC_USER="eventos"
ENV_DIR="/etc/eventos"
ENV_FILE="$ENV_DIR/eventos.env"
PORT=4010

c_b="\033[1m"; c_g="\033[32m"; c_y="\033[33m"; c_r="\033[31m"; c_0="\033[0m"
say(){ echo -e "${c_b}==>${c_0} $*"; }
ok(){  echo -e "${c_g}OK${c_0} $*"; }
warn(){ echo -e "${c_y}!!${c_0} $*"; }
die(){ echo -e "${c_r}ERROR:${c_0} $*" >&2; exit 1; }
# En modo no interactivo (EVENTOS_NONINTERACTIVE=1 o sin TTY) se toman los valores por
# defecto / de entorno sin leer de stdin — para despliegues desatendidos (CI, pct exec, ssh).
NONINT="${EVENTOS_NONINTERACTIVE:-0}"; [ -t 0 ] || NONINT=1
ask(){ local p="$1" d="${2:-}" v; if [ "$NONINT" = 1 ]; then echo "$d"; return 0; fi; read -rp "$(echo -e "$p${d:+ [$d]}: ")" v || true; echo "${v:-$d}"; }
asksec(){ local p="$1" v; if [ "$NONINT" = 1 ]; then echo ""; return 0; fi; read -rsp "$(echo -e "$p: ")" v || true; echo >&2; echo "$v"; }
yesno(){ local p="$1" d="${2:-s}" v; if [ "$NONINT" = 1 ]; then v="$d"; else read -rp "$(echo -e "$p [s/n] ($d): ")" v || true; v="${v:-$d}"; fi; [[ "$v" =~ ^[sSyY] ]]; }
gen(){ openssl rand -hex "${1:-32}"; }

[ "$(id -u)" -eq 0 ] || die "Ejecuta como root (sudo bash deploy/install.sh)."
command -v apt-get >/dev/null || die "Este instalador es para Debian/Ubuntu (apt)."

echo -e "${c_b}===== EventOS — instalador =====${c_0}"

# ---------------------------------------------------------------- 1) Datos
APP_DIR=$(ask "Directorio de instalación" "${APP_DIR:-$APP_DIR_DEFAULT}")
DOMAIN=$(ask "Dominio / server_name de nginx" "${DOMAIN:-eventos.local}")

# Si el código ya está presente (server/ y web/), no clonamos: usamos lo que hay.
HAVE_CODE=false
if [ -d "$APP_DIR/server" ] && [ -d "$APP_DIR/web" ]; then
  HAVE_CODE=true
  ok "Código ya presente en $APP_DIR (server/ y web/): se omitirá el clone."
fi

REPO=""; BRANCH="main"; GIT_TOKEN=""
USE_GIT=false
if ! $HAVE_CODE; then
  USE_GIT=true
elif [ -d "$APP_DIR/.git" ]; then
  # Hay código y además es un repo git: permitir actualizar por git en update.sh
  USE_GIT=true
fi
if $USE_GIT; then
  REPO=$(ask "Repositorio Git" "$REPO_DEFAULT")
  BRANCH=$(ask "Rama" "main")
  GIT_TOKEN=$(ask "Token de acceso Git (vacío si el repo es público)" "")
fi

# ---------------------------------------------------------------- 2) CORS
say "CORS (origen permitido para el frontend)"
if yesno "¿Restringir CORS al dominio (http://$DOMAIN)? (n = permitir todo *)" "n"; then
  CORS_ORIGIN="http://$DOMAIN"
else
  CORS_ORIGIN="*"
fi

# ---------------------------------------------------------------- 3) TLS / firewall
DO_TLS=false; TLS_EMAIL=""
if yesno "¿Configurar HTTPS con Let's Encrypt (certbot) ahora?" "n"; then
  DO_TLS=true; TLS_EMAIL=$(ask "Email para Let's Encrypt" "")
fi
DO_UFW=false
if yesno "¿Configurar firewall ufw (22/80/443; cerrar el resto)?" "n"; then DO_UFW=true; fi

# ---------------------------------------------------------------- 4) Secretos
# Se preservan los tokens existentes entre redeploys (no rotar en cada actualización).
INGEST_TOKEN="ingest_$(gen 24)"
ADMIN_TOKEN="admin_$(gen 24)"
if [ -f "$ENV_FILE" ]; then
  EX_I=$(grep -E '^INGEST_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true); [ -n "${EX_I:-}" ] && INGEST_TOKEN="$EX_I"
  EX_A=$(grep -E '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true); [ -n "${EX_A:-}" ] && ADMIN_TOKEN="$EX_A"
  ok "Tokens existentes preservados desde $ENV_FILE"
fi

# ================================================================ Instalación
say "Instalando paquetes base..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates gnupg nginx openssl redis-server

# Redis: habilitar y arrancar
systemctl enable --now redis-server 2>/dev/null || systemctl enable --now redis 2>/dev/null || true
if systemctl is-active --quiet redis-server || systemctl is-active --quiet redis; then
  ok "Redis activo (redis://127.0.0.1:6379)"
else
  warn "Redis no quedó activo; el server usará fallback en memoria. Revisa: systemctl status redis-server"
fi

# Node 20 LTS (si falta o es < 18)
NODE_OK=false
if command -v node >/dev/null 2>&1; then
  [ "$(node -v | sed 's/v//; s/\..*//')" -ge 18 ] && NODE_OK=true
fi
if ! $NODE_OK; then
  say "Instalando Node.js 20 LTS (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
ok "Node $(node -v), npm $(npm -v)"

$DO_TLS && apt-get install -y certbot python3-certbot-nginx

# Usuario de servicio (sin login)
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
ok "Usuario de servicio: $SVC_USER"

# -------------------------------------------- Clonar / actualizar repo
if $USE_GIT && [ -n "$REPO" ]; then
  CLONE_URL="$REPO"
  if [ -n "$GIT_TOKEN" ]; then
    CLONE_URL="$(echo "$REPO" | sed -E "s#https://#https://oauth2:${GIT_TOKEN}@#")"
  fi
  if [ -d "$APP_DIR/.git" ]; then
    say "Actualizando repo existente en $APP_DIR"
    git -C "$APP_DIR" remote set-url origin "$CLONE_URL"
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  elif ! $HAVE_CODE; then
    say "Clonando $REPO en $APP_DIR"
    mkdir -p "$APP_DIR"
    git clone --depth 1 -b "$BRANCH" "$CLONE_URL" "$APP_DIR"
  fi
  # Proteger el token (queda en .git/config): .git solo accesible por root
  chmod -R go-rwx "$APP_DIR/.git" 2>/dev/null || true
fi

[ -d "$APP_DIR/server" ] || die "No encuentro $APP_DIR/server. ¿Repo correcto / código presente?"
[ -d "$APP_DIR/web" ]    || die "No encuentro $APP_DIR/web."

# -------------------------------------------- Archivo de entorno (secretos)
mkdir -p "$ENV_DIR"; chmod 750 "$ENV_DIR"
cat > "$ENV_FILE" <<EOF
HOST=127.0.0.1
PORT=$PORT
NODE_ENV=production
REDIS_URL=redis://127.0.0.1:6379
INGEST_TOKEN=$INGEST_TOKEN
ADMIN_TOKEN=$ADMIN_TOKEN
CORS_ORIGIN=$CORS_ORIGIN
EOF
chmod 600 "$ENV_FILE"
ok "Entorno en $ENV_FILE (chmod 600)"

# -------------------------------------------- Build
say "Instalando dependencias del backend..."
( cd "$APP_DIR/server" && { npm ci --omit=dev || npm install --omit=dev; } )
say "Compilando frontend..."
( cd "$APP_DIR/web" && { npm ci || npm install; } && npm run build )

# Permisos: código legible por el servicio
chmod -R a+rX "$APP_DIR/server" "$APP_DIR/web/dist"

# Dir de datos del almacén de configuración persistente (CONTRACT-V2 §1):
# debe ser escribible por el servicio. ProtectSystem=strict + ReadWritePaths lo permiten.
mkdir -p "$APP_DIR/server/data"
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR/server/data"
chmod 750 "$APP_DIR/server/data"
ok "Dir de datos: $APP_DIR/server/data (dueño $SVC_USER)"

# -------------------------------------------- systemd (endurecido)
cat > /etc/systemd/system/eventos-api.service <<EOF
[Unit]
Description=EventOS API (Express + Socket.io)
After=network.target redis-server.service
Wants=redis-server.service

[Service]
WorkingDirectory=$APP_DIR/server
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
User=$SVC_USER
Group=$SVC_USER
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP_DIR/server/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable eventos-api
systemctl restart eventos-api   # restart (no solo start) para recargar código en redeploys
say "Esperando a que la API levante..."
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  ok "API arriba (health 200)"
else
  warn "La API no respondió health; revisa: journalctl -u eventos-api -n 50"
fi

# -------------------------------------------- nginx
cat > /etc/nginx/sites-available/eventos <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    root $APP_DIR/web/dist;
    index index.html;
    client_max_body_size 30M;
    server_tokens off;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location = /index.html { add_header Cache-Control "no-cache, no-store, must-revalidate"; }

    # API HTTP (Express)
    location /api/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Socket.io (WebSocket upgrade + read timeout largo)
    location /socket.io/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }

    # SPA: todo lo demás cae en index.html
    location / { try_files \$uri \$uri/ /index.html; }
}
EOF
ln -sf /etc/nginx/sites-available/eventos /etc/nginx/sites-enabled/eventos
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ok "nginx configurado para $DOMAIN"

# -------------------------------------------- TLS (opcional)
if $DO_TLS; then
  say "Solicitando certificado Let's Encrypt para $DOMAIN..."
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "${TLS_EMAIL:-admin@$DOMAIN}" --redirect; then
    ok "HTTPS activo (certbot renovará automáticamente)."
  else
    warn "certbot falló (¿el dominio apunta a este server y el puerto 80 es accesible?). Podés reintentar luego: certbot --nginx -d $DOMAIN"
  fi
fi

# -------------------------------------------- Firewall (opcional)
if $DO_UFW; then
  apt-get install -y ufw
  ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp
  ufw --force enable
  ok "ufw activo (22/80/443). La API ($PORT) y Redis (6379) escuchan solo en localhost."
fi

# ================================================================ Resumen
SCHEME="http"; $DO_TLS && SCHEME="https"
REDIS_STATE="memoria (fallback)"
( systemctl is-active --quiet redis-server || systemctl is-active --quiet redis ) && REDIS_STATE="conectado (redis://127.0.0.1:6379)"
echo
echo -e "${c_g}========================================================${c_0}"
echo -e "${c_b} EventOS instalado${c_0}"
echo -e "${c_g}========================================================${c_0}"
echo " URL:            $SCHEME://$DOMAIN"
echo " App:            $APP_DIR    (servicio: eventos-api, usuario: $SVC_USER)"
echo " Entorno:        $ENV_FILE  (chmod 600)"
echo " Redis:          $REDIS_STATE"
echo -e " ${c_y}INGEST_TOKEN (para configurar dispositivos):${c_0} $INGEST_TOKEN"
echo -e " ${c_y}ADMIN_TOKEN  (header X-Admin-Token del panel /admin):${c_0} $ADMIN_TOKEN"
echo
echo -e " ${c_b}Ejemplos de ingesta (webhooks)${c_0} — header X-Ingest-Token o ?token="
echo "  # Hikvision"
echo "  curl -X POST $SCHEME://$DOMAIN/api/ingest/hikvision -H 'X-Ingest-Token: $INGEST_TOKEN' \\"
echo "       -H 'Content-Type: application/json' -d '{\"eventType\":\"linedetection\",\"channelID\":1,\"ipAddress\":\"192.168.99.50\"}'"
echo "  # Akuvox (portero)"
echo "  curl -X POST $SCHEME://$DOMAIN/api/ingest/akuvox -H 'X-Ingest-Token: $INGEST_TOKEN' \\"
echo "       -H 'Content-Type: application/json' -d '{\"event\":\"doorbell\",\"device\":\"R29\",\"door\":\"Entrada\"}'"
echo "  # Central de alarma"
echo "  curl -X POST $SCHEME://$DOMAIN/api/ingest/alarm -H 'X-Ingest-Token: $INGEST_TOKEN' \\"
echo "       -H 'Content-Type: application/json' -d '{\"zone\":3,\"type\":\"alarm\",\"site\":\"Planta Central\"}'"
echo "  # NVR genérico"
echo "  curl -X POST $SCHEME://$DOMAIN/api/ingest/nvr -H 'X-Ingest-Token: $INGEST_TOKEN' \\"
echo "       -H 'Content-Type: application/json' -d '{\"channel\":2,\"type\":\"motion\"}'"
echo "  # Genérico (casi-canónico)"
echo "  curl -X POST '$SCHEME://$DOMAIN/api/ingest/generic?token=$INGEST_TOKEN' \\"
echo "       -H 'Content-Type: application/json' -d '{\"type\":\"intrusion\",\"title\":\"Prueba\"}'"
echo
echo -e " ${c_b}Simulador (demo / carga)${c_0}"
echo "  curl -X POST $SCHEME://$DOMAIN/api/sim/burst -H 'Content-Type: application/json' -d '{\"count\":5}'"
echo
echo " Actualizar a futuro:   sudo bash $APP_DIR/deploy/update.sh"
echo " Logs:                  journalctl -u eventos-api -f"
echo -e "${c_g}========================================================${c_0}"
