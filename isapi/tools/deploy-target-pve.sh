#!/bin/bash
set -euo pipefail
STAMP="${1:-manual}"
for f in _dep_t_normalize.js _dep_t_alertStream.js _dep_t_ct.sh; do
  pct push 101 "/tmp/$f" "/tmp/$f"
done
pct exec 101 -- bash /tmp/_dep_t_ct.sh "$STAMP"
