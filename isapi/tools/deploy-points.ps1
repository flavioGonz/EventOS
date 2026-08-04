# Despliega el registro de PUNTOS vendor-neutral + el arreglo del cruce entre clientes.
#   powershell -ExecutionPolicy Bypass -File isapi\tools\deploy-points.ps1
#
# Cambia: events/points.js (nuevo), events/normalize.js, ingest/alertStream.js
# Genera: server/data/points.json  (indexado por deviceId, en el propio CT)
# Backup de todo lo que reemplaza + node --check ANTES de reiniciar.
$ErrorActionPreference = "Stop"
$PVE   = "root@172.26.20.93"
$ROOT  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host "== 1/3  copiando a pve03" -ForegroundColor Cyan
scp "$ROOT\server\src\events\points.js"       "${PVE}:/tmp/_dep_points.js"
scp "$ROOT\server\src\events\normalize.js"    "${PVE}:/tmp/_dep_normalize.js"
scp "$ROOT\server\src\ingest\alertStream.js"  "${PVE}:/tmp/_dep_alertStream.js"
scp "$ROOT\server\data\zones-raw.json"        "${PVE}:/tmp/_dep_zones_raw.json"
scp "$PSScriptRoot\build_points.py"           "${PVE}:/tmp/_dep_build_points.py"
scp "$PSScriptRoot\deploy-points-ct.sh"       "${PVE}:/tmp/_dep_points_ct.sh"
scp "$PSScriptRoot\deploy-points-pve.sh"      "${PVE}:/tmp/_dep_points_pve.sh"

Write-Host "== 2/3  ejecutando en pve03 -> CT 101" -ForegroundColor Cyan
ssh -n $PVE "bash /tmp/_dep_points_pve.sh $STAMP"

Write-Host "== 3/3  fin" -ForegroundColor Green
