$projectRoot = Split-Path -Parent $PSScriptRoot
$dotnet = $env:DOTNET_EXE
if (-not $dotnet) {
    $installed = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($installed) { $dotnet = $installed.Source }
    elseif (Test-Path -LiteralPath (Join-Path $projectRoot 'work/dotnet/dotnet.exe')) {
        $dotnet = Join-Path $projectRoot 'work/dotnet/dotnet.exe'
    }
}
if (-not $dotnet -or -not (Test-Path -LiteralPath $dotnet)) {
    throw 'Install the .NET 10 SDK and put dotnet on PATH, or set DOTNET_EXE to its executable.'
}
