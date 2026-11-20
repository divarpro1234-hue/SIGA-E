$ErrorActionPreference = 'Stop'

$orchestrator = Join-Path $PSScriptRoot '..\..\..\scripts\run-m4-local-solo-lab.ps1'
$run = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $orchestrator `
  -VerifyPhysicalPhaseOnly 2>&1

if ($LASTEXITCODE -ne 0) {
  throw "La fase física aislada falló: $($run -join "`n")"
}

$output = $run -join "`n"
if ($output -notmatch 'M4_PHASE_PASS=READ_ONLY_POSTGRES_LAB_VERIFICATION') {
  throw 'La fase física no registró PASS.'
}
if ($output -notmatch 'M4_RUN_REPORT=') {
  throw 'La fase física no generó informe consolidado.'
}
if ($output -match 'M4_PHASE_DIAGNOSTIC=') {
  throw 'La fase física registró un diagnóstico de error inesperado.'
}

Write-Output 'M4_READ_ONLY_PHASE_TEST_PASS'
