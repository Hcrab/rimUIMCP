param([switch]$BridgeOnly)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$env:DOTNET_CLI_HOME=Join-Path $projectRoot 'work\dotnet-home'
$env:NUGET_PACKAGES=Join-Path $projectRoot 'work\nuget-packages'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
. (Join-Path $PSScriptRoot 'dotnet.ps1')
Push-Location (Join-Path $projectRoot 'bridge\rimUIMCP')
try {
    & $dotnet build RimUIMCP.sln -p:RIMWORLD_MOD_DIR= -p:RIMWORLD_MOD_TARGET_DIR= -p:RimWorldModDeployDir= -v:minimal
    if($LASTEXITCODE -ne 0){throw 'Bridge build failed.'}
} finally {Pop-Location}
if(-not $BridgeOnly -and (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json'))) {
    Push-Location $projectRoot
    try { & node node_modules/typescript/bin/tsc --noEmit; if($LASTEXITCODE -ne 0){throw 'Client build failed.'} } finally {Pop-Location}
}
