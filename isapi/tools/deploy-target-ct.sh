#!/bin/bash
set -euo pipefail
STAMP="${1:-manual}"
cd /opt/eventos

echo "== backup"
for f in server/src/events/normalize.js server/src/ingest/alertStream.js; do
  cp "$f" "$f.bak-$STAMP"; echo "   $f.bak-$STAMP"
done

echo "== copiando"
cp /tmp/_dep_t_normalize.js   server/src/events/normalize.js
cp /tmp/_dep_t_alertStream.js server/src/ingest/alertStream.js
chmod a+rX server/src/events/normalize.js server/src/ingest/alertStream.js

echo "== node --check ANTES de tocar el servicio"
node --check server/src/events/normalize.js
node --check server/src/ingest/alertStream.js

echo "== prueba de humo: objetivo + punto estricto"
node --input-type=module -e '
const { normalizeTarget } = await import("/opt/eventos/server/src/events/normalize.js");
const t = [
  [{ detectionTarget: "human", targetType: "2" }, "human"],
  [{ targetType: "2" }, null],
  [{ detectionTarget: "vehicle" }, "vehicle"],
];
let bad = 0;
for (const [i, e] of t) { const g = normalizeTarget(i); if (g !== e) { bad++; console.log("   FALLO", JSON.stringify(i), "->", g); } }
if (bad) { console.log("   " + bad + " fallos"); process.exit(1); }
console.log("   objetivo OK");
'

echo "== reiniciando eventos-api"
systemctl restart eventos-api
sleep 5

echo "== verificacion"
systemctl is-active eventos-api
journalctl -u eventos-api --since "1 min ago" --no-pager | tail -15
echo
echo "ROLLBACK:"
echo "  pct exec 101 -- bash -lc 'cd /opt/eventos && for f in server/src/events/normalize.js server/src/ingest/alertStream.js; do cp \$f.bak-$STAMP \$f; done && systemctl restart eventos-api'"
