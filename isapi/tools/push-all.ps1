# TODO EN UNO: despliega al CT 101 y publica en GitHub.
#   powershell -ExecutionPolicy Bypass -File isapi\tools\push-all.ps1
#
#   1. despliega points.js / normalize.js / alertStream.js a /opt/eventos
#      (backup + node --check + restart)
#   2. actualiza .gitignore (datos de cliente y el sqlite regenerable, fuera del repo)
#   3. commit + push a github.com/flavioGonz/EventOS por el remoto HTTPS
#
# NOTA: este archivo se mantiene en ASCII puro a proposito. PowerShell 5.1 lee los
# .ps1 como ANSI y rompe los acentos, lo que produce errores de parseo raros. El
# mensaje de commit (con acentos) vive aparte en commit-msg.txt y lo lee git -F.
$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ROOT

Write-Host ""
Write-Host "=== PASO 1/3 - desplegando al contenedor ===" -ForegroundColor Cyan
& powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\deploy-points.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "El despliegue fallo. No sigo con el push."
}

Write-Host ""
Write-Host "=== PASO 2/3 - .gitignore ===" -ForegroundColor Cyan
$gi = Get-Content .gitignore -Raw
$nuevas = New-Object System.Collections.ArrayList
if ($gi -notmatch "isapi/reports/") {
    [void]$nuevas.Add("")
    [void]$nuevas.Add("# Datos de campo: nombres de camara, IPs y topologia de cliente")
    [void]$nuevas.Add("isapi/reports/")
}
if ($gi -notmatch "catalog.sqlite") {
    [void]$nuevas.Add("")
    [void]$nuevas.Add("# Regenerable: cd isapi/tools ; make catalog")
    [void]$nuevas.Add("isapi/openapi/catalog.sqlite")
}
if ($nuevas.Count -gt 0) {
    Add-Content .gitignore ($nuevas -join "`r`n")
    Write-Host ("   agregadas " + $nuevas.Count + " lineas a .gitignore")
} else {
    Write-Host "   ya estaba al dia"
}

Write-Host ""
Write-Host "=== PASO 3/3 - commit + push ===" -ForegroundColor Cyan
git rm -r --cached isapi/reports --ignore-unmatch -q
git rm --cached isapi/openapi/catalog.sqlite --ignore-unmatch -q
git add -A
$staged = @(git diff --cached --name-only)
if ($staged.Count -eq 0) {
    Write-Host "   nada que commitear"
    exit 0
}
Write-Host ("   archivos en el commit: " + $staged.Count)
git commit -q -F "$PSScriptRoot\commit-msg.txt"
if ($LASTEXITCODE -ne 0) { throw "git commit fallo" }
git push
if ($LASTEXITCODE -ne 0) { throw "git push fallo (revisa credenciales de GitHub)" }
Write-Host ""
Write-Host "   Listo: https://github.com/flavioGonz/EventOS" -ForegroundColor Green
