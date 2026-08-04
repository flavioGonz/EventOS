# Despliega la deteccion de objetivo (detectionTarget) + resolucion ESTRICTA de punto.
#   powershell -ExecutionPolicy Bypass -File isapi\tools\deploy-target.ps1
#
# Cambia SOLO: server/src/events/normalize.js  y  server/src/ingest/alertStream.js
# Backup + node --check + prueba de humo ANTES de reiniciar. Rollback impreso al final.
$ErrorActionPreference = "Stop"
$PVE   = "root@172.26.20.93"
$ROOT  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host "== 1/3  copiando a pve03" -ForegroundColor Cyan
scp "$ROOT\server\src\events\normalize.js"    "${PVE}:/tmp/_dep_t_normalize.js"
scp "$ROOT\server\src\ingest\alertStream.js"  "${PVE}:/tmp/_dep_t_alertStream.js"
scp "$PSScriptRoot\deploy-target-ct.sh"       "${PVE}:/tmp/_dep_t_ct.sh"
scp "$PSScriptRoot\deploy-target-pve.sh"      "${PVE}:/tmp/_dep_t_pve.sh"

Write-Host "== 2/3  ejecutando en pve03 -> CT 101" -ForegroundColor Cyan
ssh -n $PVE "bash /tmp/_dep_t_pve.sh $STAMP"

Write-Host "== 3/3  fin" -ForegroundColor Green
