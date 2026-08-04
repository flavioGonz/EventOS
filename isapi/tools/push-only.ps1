# Solo commit + push (el despliegue al CT ya se hizo, no lo repite: reiniciar
# eventos-api de nuevo desconectaria operarios sin necesidad).
#   powershell -ExecutionPolicy Bypass -File isapi\tools\push-only.ps1
#
# ASCII puro a proposito (PowerShell 5.1 lee los .ps1 como ANSI y rompe acentos).
# El mensaje de commit, con acentos, vive en commit-msg.txt y lo lee git -F.
$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ROOT

# --- lock huerfano -----------------------------------------------------------
# El puente de archivos de Cowork no permite unlink, asi que un git corrido desde
# ahi deja .git/index.lock y bloquea todo. Desde Windows si se puede borrar.
$lock = Join-Path $ROOT ".git\index.lock"
if (Test-Path $lock) {
    $git = Get-Process git -ErrorAction SilentlyContinue
    if ($git) {
        throw "Hay un proceso git corriendo (PID $($git.Id)). Cerralo y volve a intentar."
    }
    $edad = [int]((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes
    Write-Host ("   index.lock huerfano de " + $edad + " min: lo borro") -ForegroundColor Yellow
    Remove-Item $lock -Force
}

Write-Host ""
Write-Host "=== commit + push ===" -ForegroundColor Cyan
git add -A
if ($LASTEXITCODE -ne 0) { throw "git add fallo" }
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
