# clean-restart.ps1 — reinicia o bot do ZERO, com UMA instancia so.
#
# Resolve o problema de varios processos do bot (zumbis de configs antigas)
# rodando ao mesmo tempo na mesma conta demo, corrompendo o aprendizado.
#
#   powershell -ExecutionPolicy Bypass -File tools\clean-restart.ps1
#
# O que faz:
#   1. para o pm2 e mata TODO node.exe/python.exe orfao
#   2. arquiva data/learn-state.json e data/trades.jsonl (aprendizado recomeca limpo)
#   3. sobe UMA instancia via pm2 (ecosystem.config.cjs)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== 1. parando processos =="
try { & pm2 delete all 2>$null } catch {}
try { & pm2 kill 2>$null } catch {}
Start-Sleep 1

# mata node/python que ainda estejam rodando o bot (nao mexe no dashboard nem no VS)
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'src[/\\]index\.ts|ProcessContainerFork|ml[/\\]predictor\.py' } |
  ForEach-Object {
    Write-Host ("  kill {0}  {1}" -f $_.ProcessId, ($_.CommandLine -replace '\s+',' ').Substring(0, [Math]::Min(60, $_.CommandLine.Length)))
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep 2

Write-Host "== 2. arquivando aprendizado contaminado =="
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
foreach ($f in "data\learn-state.json", "data\trades.jsonl") {
  if (Test-Path $f) {
    $dst = "$f.pre-clean-$stamp"
    Move-Item $f $dst
    Write-Host "  $f -> $dst"
  }
}

Write-Host "== 3. subindo 1 instancia via pm2 =="
& pm2 start ecosystem.config.cjs
& pm2 save --force
Start-Sleep 2
& pm2 list

Write-Host ""
Write-Host "OK. Confira no monitor (tecla [r]) que so aparecem os 5 bots xau-*."
Write-Host "Se quiser o ML de volta depois: ml.enabled=true no config.json + [k] no monitor."
