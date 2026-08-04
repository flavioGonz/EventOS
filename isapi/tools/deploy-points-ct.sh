#!/bin/bash
set -euo pipefail
STAMP="${1:-manual}"
cd /opt/eventos
mkdir -p server/data

echo "== backup"
for f in server/src/events/normalize.js server/src/ingest/alertStream.js \
         server/src/events/points.js server/data/points.json; do
  if [ -f "$f" ]; then cp "$f" "$f.bak-$STAMP"; echo "   $f"; fi
done

echo "== copiando"
cp /tmp/_dep_points.js     server/src/events/points.js
cp /tmp/_dep_normalize.js  server/src/events/normalize.js
cp /tmp/_dep_alertStream.js server/src/ingest/alertStream.js
cp /tmp/_dep_zones_raw.json server/data/zones-raw.json
cp /tmp/_dep_build_points.py server/data/build_points.py

echo "== generando points.json (indexado por deviceId de EventOS)"
python3 server/data/build_points.py \
  --zones  server/data/zones-raw.json \
  --config server/data/eventos.config.json \
  --out    server/data/points.json

echo "== permisos"
chmod -R a+rX server/src server/data
chown -R eventos:eventos server/data 2>/dev/null || true

echo "== node --check ANTES de tocar el servicio"
node --check server/src/events/points.js
node --check server/src/events/normalize.js
node --check server/src/ingest/alertStream.js
node --input-type=module -e '
const { pointsInfo } = await import("/opt/eventos/server/src/events/points.js");
console.log("   registro:", JSON.stringify(pointsInfo()));
'

echo "== reiniciando eventos-api"
systemctl restart eventos-api
sleep 5

echo "== verificacion"
systemctl is-active eventos-api
journalctl -u eventos-api --since "1 min ago" --no-pager | tail -12
echo
echo "ROLLBACK:"
echo "  pct exec 101 -- bash -lc 'cd /opt/eventos && for f in server/src/events/normalize.js server/src/ingest/alertStream.js; do cp \$f.bak-$STAMP \$f; done && systemctl restart eventos-api'"
