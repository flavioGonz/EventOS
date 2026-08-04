#!/bin/bash
set -euo pipefail
STAMP="${1:-manual}"
for f in _dep_points.js _dep_normalize.js _dep_alertStream.js _dep_zones_raw.json _dep_build_points.py _dep_points_ct.sh; do
  pct push 101 "/tmp/$f" "/tmp/$f"
done
pct exec 101 -- bash /tmp/_dep_points_ct.sh "$STAMP"
