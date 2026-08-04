# Sube el kit ISAPI + el README a una rama nueva sacada de origin/main, sin tocar
# ni la rama de escritorio ni el arbol de trabajo actual.
#
#   powershell -ExecutionPolicy Bypass -File isapi\tools\push-main.ps1
#
# POR QUE ASI Y NO UN MERGE:
#   `escritorio-2026-08` y `main` NO tienen ancestro comun (historias no
#   relacionadas) y el arbol de escritorio esta 56 commits ATRAS de main.
#   Mergear o pushear escritorio a main revertiria v1.2.0, supervisor, videowall
#   y el fix de la PWA. Por eso esto crea un worktree LIMPIO desde origin/main y
#   copia encima SOLO lo nuevo.
#
# POR QUE EL WORKTREE VA EN %TEMP% Y NO EN LA CARPETA DEL PROYECTO:
#   la carpeta del proyecto esta montada por Cowork y el montaje PROHIBE borrar
#   archivos; git necesita borrar para armar un checkout. En %TEMP% es disco
#   normal de Windows y funciona.
#
# No pide ni guarda credenciales: usa el credential helper de Windows que ya
# tenes configurado para github.com.
$ErrorActionPreference = "Stop"
$REPO   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$BRANCH = "isapi-kit"
$WT     = Join-Path $env:TEMP ("eventos-main-" + (Get-Date -Format "yyyyMMdd-HHmmss"))

Write-Host "== 1/6  trayendo origin/main" -ForegroundColor Cyan
git -C $REPO fetch origin main

Write-Host "== 2/6  worktree limpio desde origin/main en $WT" -ForegroundColor Cyan
git -C $REPO worktree add -b $BRANCH $WT origin/main

Write-Host "== 3/6  copiando el kit ISAPI" -ForegroundColor Cyan
robocopy "$REPO\isapi\openapi" "$WT\isapi\openapi" /E /NFL /NDL /NJH /NJS /NP /XF catalog.sqlite | Out-Null
robocopy "$REPO\isapi\tools"   "$WT\isapi\tools"   /E /NFL /NDL /NJH /NJS /NP /XF _readme-para-main.md commit-msg.txt readme-main.md readme-escritorio-orig.md | Out-Null
if (Test-Path "$REPO\skills\hikvision") {
  robocopy "$REPO\skills\hikvision" "$WT\skills\hikvision" /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

Write-Host "== 4/6  README + .gitignore + los 3 archivos de codigo" -ForegroundColor Cyan
Copy-Item "$PSScriptRoot\_readme-para-main.md" "$WT\README.md" -Force
# .gitignore: se AGREGAN lineas al de main, no se reemplaza (main tiene reglas propias)
$gi = Get-Content "$WT\.gitignore" -Raw
foreach ($rule in @("isapi/reports/", "isapi/openapi/catalog.sqlite")) {
  if ($gi -notmatch [regex]::Escape($rule)) { $gi += "`n$rule" }
}
Set-Content "$WT\.gitignore" ($gi.TrimEnd() + "`n") -NoNewline:$false -Encoding utf8
Copy-Item "$REPO\server\src\events\points.js"      "$WT\server\src\events\points.js" -Force
Copy-Item "$REPO\server\src\events\normalize.js"   "$WT\server\src\events\normalize.js" -Force
Copy-Item "$REPO\server\src\ingest\alertStream.js" "$WT\server\src\ingest\alertStream.js" -Force

Write-Host "== 5/6  commit" -ForegroundColor Cyan
git -C $WT add -A
git -C $WT status --short
git -C $WT commit -F "$PSScriptRoot\commit-main.txt"

Write-Host "== 6/6  push" -ForegroundColor Cyan
git -C $WT push -u origin $BRANCH

Write-Host ""
Write-Host "Listo. Abri el Pull Request aca:" -ForegroundColor Green
Write-Host "  https://github.com/flavioGonz/EventOS/compare/main...$BRANCH?expand=1"
Write-Host ""
Write-Host "El worktree quedo en $WT (por si queres revisar el diff)."
Write-Host "Para borrarlo cuando termines:  git -C `"$REPO`" worktree remove --force `"$WT`""
