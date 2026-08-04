#!/bin/bash
set -euo pipefail
STAMP="${1:-manual}"
cd /opt/eventos
mkdir -p server/data

echo "== backup"
for f in server/src/events/zones.js server/src/ingest/alertStream.js server/data/zones.json; do
  if [ -f "$f" ]; then cp "$f" "$f.bak-$STAMP"; echo "   $f -> $f.bak-$STAMP"; fi
done

echo "== copiando archivos nuevos"
cp /tmp/_dep_zones.js       server/src/events/zones.js
cp /tmp/_dep_alertStream.js server/src/ingest/alertStream.js
cp /tmp/_dep_zones.json     server/data/zones.json

echo "== permisos (el servicio corre como usuario eventos)"
chmod -R a+rX server/src server/data
chown -R eventos:eventos server/data 2>/dev/null || true

echo "== node --check ANTES de tocar el servicio"
node --check server/src/events/zones.js
node --check server/src/ingest/alertStream.js
node -e 'const d=JSON.parse(require("fs").readFileSync("server/data/zones.json","utf8"));console.log("   zones.json OK:",Object.keys(d.zones).length,"zonas")'

echo "== reiniciando eventos-api"
systemctl restart eventos-api
sleep 5

echo "== verificacion"
systemctl is-active eventos-api
journalctl -u eventos-api --since "1 min ago" --no-pager | tail -18
echo
echo "ROLLBACK: pct exec 101 -- bash -lc 'cd /opt/eventos && cp server/src/ingest/alertStream.js.bak-$STAMP server/src/ingest/alertStream.js && systemctl restart eventos-api'"
