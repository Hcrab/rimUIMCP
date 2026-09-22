param(
    [ValidateSet('unit','live','all')][string]$Suite='unit',
    [ValidateSet('all','basic','reliability','edges','input','agent')][string]$Case='all',
    [switch]$Live
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'dotnet.ps1')
if($Live){$Suite='all'}
Push-Location $projectRoot
try {
    & node node_modules/typescript/bin/tsc --noEmit
    if($LASTEXITCODE -ne 0){throw 'Type check failed.'}
    if($Suite -in @('unit','all')) {
        $nodeTests = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests') -Filter '*.test.ts' -File | Sort-Object Name | ForEach-Object FullName)
        & node --test @nodeTests
        if($LASTEXITCODE -ne 0){throw 'Node verification failed (including recording and helper regressions).'}
        $env:DOTNET_CLI_HOME=Join-Path $projectRoot 'work\dotnet-home'
        $env:NUGET_PACKAGES=Join-Path $projectRoot 'work\nuget-packages'
        & $dotnet test tests/dotnet/rimUIMCP.ReferenceTests.csproj -v:minimal
        if($LASTEXITCODE -ne 0){throw 'Object reference lifecycle regressions failed.'}
        & $dotnet test bridge/rimUIMCP/RimUIMCP.sln --no-build
        if($LASTEXITCODE -ne 0){throw '.NET verification failed; build first and inspect test output.'}
    }
    if($Suite -in @('live','all')) {
        $status=& node apps/cli/src/main.ts session.status | ConvertFrom-Json
        if(-not $status.success){throw 'Connect a live game before live acceptance.'}
        if($Case -ne 'basic' -and -not $status.data.fixtureMode){throw 'This suite uses isolated fixtures. Restart with -Fixture, or choose -Case basic for the current colony.'}
        if($Case -eq 'all') {
            & node apps/cli/src/main.ts runtime.load '{"name":"rimUIMCP-Economy-Verified","timeoutMs":120000}' | Out-Null
            if($LASTEXITCODE -ne 0){throw 'The documented Economy-Verified fixture is missing.'}
        }
        $tests=[ordered]@{basic='tests/live-acceptance.ts';reliability='tests/live-reliability.ts';edges='tests/live-ui-edges.ts';input='tests/live-input.ts';agent='tests/live-agent.ts'}
        foreach($entry in $tests.GetEnumerator()) {
            if($Case -ne 'all' -and $Case -ne $entry.Key){continue}
            if($entry.Key -eq 'edges'){ & node $entry.Value --load } else { & node $entry.Value }
            if($LASTEXITCODE -ne 0){throw ('Live '+$entry.Key+' acceptance failed; inspect its runs directory.')}
        }
    }
} finally {Pop-Location}
