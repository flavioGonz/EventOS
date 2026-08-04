#!/bin/bash
set -euo pipefail
STAMP="${1:-manual}"
echo "== push al CT 101"
for f in _dep_zones.js _dep_alertStream.js _dep_zones.json _dep_ct.sh; do
  pct push 101 "/tmp/$f" "/tmp/$f"
done
pct exec 101 -- chmod +x /tmp/_dep_ct.sh
pct exec 101 -- bash /tmp/_dep_ct.sh "$STAMP"
