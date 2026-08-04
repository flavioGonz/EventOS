# Verifica el despliegue de zonas en el CT 101 (sólo lectura, no toca nada).
#   powershell -ExecutionPolicy Bypass -File isapi\tools\verify-zonas.ps1
$ErrorActionPreference = "Stop"
$PVE = "root@172.26.20.93"
scp "$PSScriptRoot\verify-ct.sh" "${PVE}:/tmp/_ver_ct.sh"
ssh -n $PVE "pct push 101 /tmp/_ver_ct.sh /tmp/_ver_ct.sh; pct exec 101 -- bash /tmp/_ver_ct.sh"
