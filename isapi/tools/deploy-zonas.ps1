# Despliega el punto 3 (zonas reales) a /opt/eventos del CT 101.
#   powershell -ExecutionPolicy Bypass -File isapi\tools\deploy-zonas.ps1
#
# Backup de lo que reemplaza + chmod a+rX + node --check ANTES de reiniciar.
# Si el check falla no reinicia nada. El restart desconecta operarios unos segundos.
$ErrorActionPreference = "Stop"
$PVE   = "root@172.26.20.93"
$ROOT  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # ...\EventOS
$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host "== 1/3  copiando archivos y scripts a pve03" -ForegroundColor Cyan
scp "$ROOT\server\src\events\zones.js"       "${PVE}:/tmp/_dep_zones.js"
scp "$ROOT\server\src\ingest\alertStream.js" "${PVE}:/tmp/_dep_alertStream.js"
scp "$ROOT\server\data\zones.json"           "${PVE}:/tmp/_dep_zones.json"
scp "$PSScriptRoot\deploy-ct.sh"             "${PVE}:/tmp/_dep_ct.sh"
scp "$PSScriptRoot\deploy-pve.sh"            "${PVE}:/tmp/_dep_pve.sh"

Write-Host "== 2/3  ejecutando en pve03 -> CT 101" -ForegroundColor Cyan
ssh -n $PVE "bash /tmp/_dep_pve.sh $STAMP"

Write-Host "== 3/3  fin" -ForegroundColor Green
