$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\scripts\m2-http-migrator-diagnostics.ps1")

$secretText = "password=offline-secret; databaseUrl=postgresql://user:offline-secret@127.0.0.1/db"
$fakeStderr = [System.Management.Automation.ErrorRecord]::new(
    [Exception]::new("$secretText P1001 P3018 P9999"),
    "OfflinePrismaFailure",
    [System.Management.Automation.ErrorCategory]::NotSpecified,
    $null
)
$diagnostic = @(Write-M2HttpSafeFailureDiagnostic -Phase "PRISMA_MIGRATE_DEPLOY" -Output @($secretText, $fakeStderr))
$expected = @(
    "M2_HTTP_PHASE_FAILED=PRISMA_MIGRATE_DEPLOY",
    "M2_HTTP_PRISMA_ERROR_CODE=P1001",
    "M2_HTTP_PRISMA_ERROR_CODE=P3018"
)

if (Compare-Object $expected $diagnostic) {
    throw "Allowlisted diagnostic output did not match"
}
if (($diagnostic -join "`n").Contains("offline-secret") -or
    ($diagnostic -join "`n").Contains("postgresql://") -or
    ($diagnostic -join "`n").Contains("P9999")) {
    throw "Sensitive or non-allowlisted text escaped"
}

$unknownOnly = @(Get-M2HttpAllowedPrismaErrorCodes -Output @("$secretText P9999"))
if ($unknownOnly.Count -ne 0) {
    throw "Unknown Prisma error code was accepted"
}

"M2 HTTP migrator diagnostics tests passed"
