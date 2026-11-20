$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot "..\scripts\anchor-operator-migrations-diagnostics.ps1")

function Assert-Equal {
    param([object]$Expected, [object]$Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw $Message
    }
}

$success = @()
foreach ($phase in @("PREFLIGHT", "PRISMA_MIGRATE", "POSTFLIGHT")) {
    $global:LASTEXITCODE = 0
    $result = Invoke-AnchorOperatorMigrationProcess -Command {
        Write-Output "offline-success"
    }
    Assert-Equal $true $result.Succeeded "Expected simulated process success at $phase"
    Assert-Equal $null $result.FailureCode "Unexpected failure code at $phase"
    $success += $phase
}
Assert-Equal 3 $success.Count "Expected all migration stages to complete"

$global:LASTEXITCODE = 1
$preflight = Invoke-AnchorOperatorMigrationProcess -Command {
    Write-Output "ANCHOR_OPERATOR_DATABASE_NOT_EMPTY"
}
Assert-Equal $false $preflight.Succeeded "Expected preflight failure"
$preflightDiagnostic = @(Get-AnchorOperatorMigrationFailureDiagnostic `
    -Phase "PREFLIGHT" -FailureCode $preflight.FailureCode)
Assert-Equal "ANCHOR_OPERATOR_PHASE_FAILED=PREFLIGHT" $preflightDiagnostic[0] "Preflight phase missing"
Assert-Equal "ANCHOR_OPERATOR_ERROR_CODE=ANCHOR_OPERATOR_DATABASE_NOT_EMPTY" `
    $preflightDiagnostic[1] "Preflight code missing"
Assert-Equal "M2_HTTP_MIGRATION_SET_REJECTED" `
    (Get-AnchorOperatorSafeErrorCode -Output @("offline-secret M2_HTTP_MIGRATION_SET_REJECTED")) `
    "Expected allowlisted migration-set validation code"
$global:LASTEXITCODE = 1
$authenticationFailure = Invoke-AnchorOperatorMigrationProcess -Command {
    Write-Output "ANCHOR_OPERATOR_DATABASE_AUTHENTICATION_FAILED"
}
Assert-Equal "ANCHOR_OPERATOR_DATABASE_AUTHENTICATION_FAILED" `
    $authenticationFailure.FailureCode "Expected sanitized PostgreSQL authentication code"

$global:LASTEXITCODE = 1
$secret = "offline-secret postgresql://offline-secret.invalid/db"
$prisma = Invoke-AnchorOperatorMigrationProcess -Command {
    Write-Output "$secret P1000 P9999"
}
Assert-Equal "P1000" $prisma.FailureCode "Expected allowlisted Prisma code"
$prismaDiagnostic = @(Get-AnchorOperatorMigrationFailureDiagnostic `
    -Phase "PRISMA_MIGRATE" -FailureCode $prisma.FailureCode)
Assert-Equal "ANCHOR_OPERATOR_PHASE_FAILED=PRISMA_MIGRATE" `
    $prismaDiagnostic[0] "Prisma migration phase missing"
if (($prismaDiagnostic -join "`n").Contains("offline-secret") -or
    ($prismaDiagnostic -join "`n").Contains("postgresql://") -or
    ($prismaDiagnostic -join "`n").Contains("P9999")) {
    throw "Sensitive or non-allowlisted process output escaped"
}

$global:LASTEXITCODE = 0
$nativeFailure = Invoke-AnchorOperatorMigrationProcess -Command {
    & node -e "process.stderr.write('offline-secret P1001'); process.exit(1)"
}
Assert-Equal $false $nativeFailure.Succeeded "Expected native process failure"
Assert-Equal "P1001" $nativeFailure.FailureCode "Native stderr was not safely classified"

$externalException = Invoke-AnchorOperatorMigrationProcess -Command {
    throw "offline-secret external process exception"
}
Assert-Equal "EXTERNAL_PROCESS_EXCEPTION" $externalException.FailureCode `
    "Expected sanitized external process exception"
$exceptionDiagnostic = @(Get-AnchorOperatorMigrationFailureDiagnostic `
    -Phase "POSTFLIGHT" -FailureCode $externalException.FailureCode)
Assert-Equal "ANCHOR_OPERATOR_PHASE_FAILED=POSTFLIGHT" `
    $exceptionDiagnostic[0] "External process phase missing"
if (($exceptionDiagnostic -join "`n").Contains("offline-secret")) {
    throw "External exception text escaped"
}

$preparationDiagnostic = @(Get-AnchorOperatorMigrationFailureDiagnostic `
    -Phase "PREPARATION" -FailureCode "PREPARATION_FAILED")
Assert-Equal "ANCHOR_OPERATOR_PHASE_FAILED=PREPARATION" `
    $preparationDiagnostic[0] "Preparation phase missing"

"Anchor operator migration diagnostics tests passed"
