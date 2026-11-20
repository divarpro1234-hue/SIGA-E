$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\m4-postgres-process-validation.ps1')

function Assert-ThrowsCode {
  param([scriptblock] $Action, [string] $Code)
  try {
    & $Action
  }
  catch {
    if ($_.Exception.Message -like "*$Code*") { return }
    throw
  }
  throw "Expected $Code"
}

$labPath = 'D:\Desarrollo\SIGAE-M4-POSTGRES-LAB\pgdata'
$simulatePhysicalPath = {
  param($Path)
  $normalized = (Get-M4WindowsAbsolutePath -Path $Path).ToLowerInvariant()
  if ($normalized -eq 'd:\desarrollo\sigae-m4-postgres-lab\pgdata') {
    return '\\?\Volume{lab}\sigae-m4-postgres-lab\pgdata'
  }
  return "\\?\Volume{lab}$normalized"
}

foreach ($actualPath in @(
  'D:/Desarrollo/SIGAE-M4-POSTGRES-LAB/pgdata',
  'd:\desarrollo\sigae-m4-postgres-lab\pgdata',
  'D:\Desarrollo\SIGAE-M4-POSTGRES-LAB\.\pgdata'
)) {
  if (-not (Test-M4WindowsPathsEquivalent `
    -ExpectedPath $labPath `
    -ActualPath $actualPath `
    -PhysicalPathResolver $simulatePhysicalPath)) {
    throw "Expected Windows-equivalent path: $actualPath"
  }
}

foreach ($differentPath in @(
  'D:\Desarrollo\SIGAE-M4-POSTGRES-LAB\other',
  'D:\Desarrollo\SIGAE-M4-POSTGRES-LAB',
  'D:\Desarrollo\SIGAE-M4-POSTGRES-LAB\pgdata-child',
  'D:\Desarrollo\SIGAE-M4-POSTGRES-LAB\pgdata-extra'
)) {
  if (Test-M4WindowsPathsEquivalent `
    -ExpectedPath $labPath `
    -ActualPath $differentPath `
    -PhysicalPathResolver $simulatePhysicalPath) {
    throw "Unexpected Windows path match: $differentPath"
  }
}

Assert-ThrowsCode {
  Get-M4WindowsAbsolutePath -Path 'relative\pgdata'
} 'M4_PG_DIRECTORY_PATH_MUST_BE_ABSOLUTE'

$slashArguments = @(Get-M4PostgresDataDirectoryArguments `
  -CommandLine '"D:/Programas/PostgreSQL/17/bin/postgres.exe" -D "D:/Desarrollo/SIGAE-M4-POSTGRES-LAB/pgdata" -c port=65535')
Assert-M4DataDirectoryArguments `
  -Arguments $slashArguments `
  -ExpectedPath $labPath `
  -PhysicalPathResolver $simulatePhysicalPath

$backslashArguments = @(Get-M4PostgresDataDirectoryArguments `
  -CommandLine '"D:\Programas\PostgreSQL\17\bin\postgres.exe" -D "D:\Desarrollo\SIGAE-M4-POSTGRES-LAB\pgdata"')
if ($backslashArguments.Count -ne 1 -or
    -not (Test-M4WindowsPathsEquivalent `
      -ExpectedPath $labPath `
      -ActualPath $backslashArguments[0] `
      -PhysicalPathResolver $simulatePhysicalPath)) {
  throw 'Backslash PGDATA argument rejected'
}

$duplicateArguments = @(Get-M4PostgresDataDirectoryArguments `
  -CommandLine 'postgres.exe -D "D:/Desarrollo/SIGAE-M4-POSTGRES-LAB/pgdata" -D "D:\Desarrollo\SIGAE-M4-POSTGRES-LAB\pgdata"')
Assert-ThrowsCode {
  Assert-M4DataDirectoryArguments -Arguments $duplicateArguments -ExpectedPath $labPath
} 'M4_PG_DATA_DIRECTORY_ARGUMENT_COUNT_REJECTED'

$missingArguments = @(Get-M4PostgresDataDirectoryArguments `
  -CommandLine 'postgres.exe -c port=65535')
Assert-ThrowsCode {
  Assert-M4DataDirectoryArguments -Arguments $missingArguments -ExpectedPath $labPath
} 'M4_PG_DATA_DIRECTORY_ARGUMENT_COUNT_REJECTED'

$process = [PSCustomObject]@{
  ProcessId = 21664
  ExecutablePath = 'D:\Programas\PostgreSQL\17\bin\postgres.exe'
  CommandLine = '"D:/Programas/PostgreSQL/17/bin/postgres.exe" -D "D:/Desarrollo/SIGAE-M4-POSTGRES-LAB/pgdata"'
}
$listener = [PSCustomObject]@{
  LocalAddress = '127.0.0.1'
  LocalPort = 65535
  OwningProcess = 21664
}
$boundProcess = Assert-M4ListenerBinding `
  -Listeners @($listener) `
  -Processes @($process) `
  -ExpectedPort 65535 `
  -ExpectedAddress '127.0.0.1' `
  -ExpectedDataDirectory $labPath `
  -ExpectedExecutableSuffix '\17\bin\postgres.exe' `
  -PhysicalPathResolver $simulatePhysicalPath
if ([int]$boundProcess.ProcessId -ne 21664) {
  throw 'Expected listener process was not returned'
}

Assert-ThrowsCode {
  Assert-M4ListenerBinding `
    -Listeners @([PSCustomObject]@{ LocalAddress = '127.0.0.1'; LocalPort = 5432; OwningProcess = 21664 }) `
    -Processes @($process) `
    -ExpectedPort 65535 `
    -ExpectedAddress '127.0.0.1' `
    -ExpectedDataDirectory $labPath `
    -ExpectedExecutableSuffix '\17\bin\postgres.exe' `
    -PhysicalPathResolver $simulatePhysicalPath
} 'M4_PG_LISTENER_NOT_UNIQUE_LOOPBACK'

Assert-ThrowsCode {
  Assert-M4ListenerBinding `
    -Listeners @([PSCustomObject]@{ LocalAddress = '127.0.0.1'; LocalPort = 65535; OwningProcess = 21665 }) `
    -Processes @($process) `
    -ExpectedPort 65535 `
    -ExpectedAddress '127.0.0.1' `
    -ExpectedDataDirectory $labPath `
    -ExpectedExecutableSuffix '\17\bin\postgres.exe' `
    -PhysicalPathResolver $simulatePhysicalPath
} 'M4_PG_LISTENER_PROCESS_NOT_POSTGRES_17'

Assert-ThrowsCode {
  Assert-M4SystemIdentifier `
    -Output 'Database system identifier: 12345' `
    -ExitCode 0 `
    -ExpectedIdentifier '7707660153733072384'
} 'M4_PG_CONTROLDATA_SYSTEM_IDENTIFIER_MISMATCH'

Assert-ThrowsCode {
  Assert-M4OriginalServiceIndependence `
    -ServiceState 'Running' `
    -ServiceProcessId 5084 `
    -M4ProcessId 21664 `
    -DataDirectoryArguments @('D:\Programas\PostgreSQL\17\other') `
    -ExpectedOriginalDataDirectory 'D:\Programas\PostgreSQL\17\data' `
    -ListenerProcessIds @(5084) `
    -PhysicalPathResolver $simulatePhysicalPath
} 'M4_PG_DATA_DIRECTORY_MISMATCH'

Assert-ThrowsCode {
  Assert-M4OriginalServiceIndependence `
    -ServiceState 'Stopped' `
    -ServiceProcessId 5084 `
    -M4ProcessId 21664 `
    -DataDirectoryArguments @('D:\Programas\PostgreSQL\17\data') `
    -ExpectedOriginalDataDirectory 'D:\Programas\PostgreSQL\17\data' `
    -ListenerProcessIds @(5084) `
    -PhysicalPathResolver $simulatePhysicalPath
} 'M4_PG_ORIGINAL_SERVICE_NOT_INDEPENDENT'

Assert-ThrowsCode {
  Assert-M4OriginalServiceIndependence `
    -ServiceState 'Running' `
    -ServiceProcessId 5084 `
    -M4ProcessId 21664 `
    -DataDirectoryArguments @('D:\Programas\PostgreSQL\17\data') `
    -ExpectedOriginalDataDirectory 'D:\Programas\PostgreSQL\17\data' `
    -ListenerProcessIds @(21664) `
    -PhysicalPathResolver $simulatePhysicalPath
} 'M4_PG_ORIGINAL_LISTENER_NOT_INDEPENDENT'

'M4 PostgreSQL process validation tests passed'
