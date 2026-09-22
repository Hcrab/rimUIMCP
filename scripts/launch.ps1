param(
    [ValidateSet('start','stop','status','attach')][string]$Action='status',
    [switch]$Fixture,
    [switch]$UseBaseline,
    [switch]$Visible,
    [switch]$Fullscreen,
    [ValidateRange(0,16)][int]$Monitor=0,
    [ValidateRange(800,7680)][int]$WindowWidth=1600,
    [ValidateRange(600,4320)][int]$WindowHeight=900
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$gameRoot=if($env:RIMWORLD_ROOT){$env:RIMWORLD_ROOT}else{Join-Path ${env:ProgramFiles(x86)} 'Steam\steamapps\common\RimWorld'}
$profile=Join-Path $projectRoot 'work\game-profile'
$logPath=Join-Path $projectRoot 'work\Player.log'
$processFile=Join-Path $projectRoot 'work\game-process.json'
$gameExe=Join-Path $gameRoot 'RimWorldWin64.exe'
$existing=@(Get-Process -Name RimWorldWin64 -ErrorAction SilentlyContinue)
if($Action -eq 'status') {
    [ordered]@{running=($existing.Count -gt 0);processes=@($existing | Select-Object Id,Path);log=$logPath;profile=$profile} | ConvertTo-Json -Depth 4
    exit
}
if($Action -eq 'stop') {
    if(Test-Path -LiteralPath $processFile) {
        $record=Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json
        $process=Get-Process -Id $record.pid -ErrorAction SilentlyContinue
        if($process -and $process.Path -eq $gameExe -and [Math]::Abs(($process.StartTime.ToUniversalTime()-([datetime]$record.startedAt).ToUniversalTime()).TotalMilliseconds) -lt 10) {
            $null=$process.CloseMainWindow()
            if(-not $process.WaitForExit(10000)){ throw 'Game is awaiting an in-game confirmation. Resolve via bridge/UI before deploying.' }
        }
    }
    exit
}
if($Action -eq 'attach') {
    $record=Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json
    $process=Get-Process -Id $record.pid -ErrorAction Stop
    if($process.Path -ne $gameExe -or [Math]::Abs(($process.StartTime.ToUniversalTime()-([datetime]$record.startedAt).ToUniversalTime()).TotalMilliseconds) -ge 10) { throw 'Recorded experiment process identity does not match.' }
    if($record.fixture -or $record.baseline) { throw 'Attach supports the normal SDK experiment only.' }
} else {
if($existing.Count){throw 'A RimWorld process is already running. Reuse it or close this experiment before deployment.'}
if(-not (Test-Path -LiteralPath $gameExe)){throw 'Set RIMWORLD_ROOT to your RimWorld installation directory (containing RimWorldWin64.exe).'}
$source=Join-Path $projectRoot $(if($UseBaseline){'reference\RimBridgeServer'}else{'bridge\rimUIMCP'})
$modRoot=Join-Path $gameRoot $(if($UseBaseline){'Mods\RimBridgeServer'}else{'Mods\rimUIMCP'})
$assemblyFile=if($UseBaseline){'RimBridgeServer.dll'}else{'RimUIMCP.dll'}
$packageId=if($UseBaseline){'brrainz.rimbridgeserver'}else{'jerrylunar.rimuimcp'}
if(-not (Test-Path -LiteralPath (Join-Path $source ('1.6\Assemblies\'+$assemblyFile)))){throw 'Build the selected bridge first.'}
New-Item -ItemType Directory -Path $modRoot,(Join-Path $profile 'Config') -Force | Out-Null
foreach($name in @('1.6','About')) {Copy-Item -LiteralPath (Join-Path $source $name) -Destination $modRoot -Recurse -Force}
foreach($name in @('LoadFolders.xml','LICENSE','LICENSE-rimUIMCP','THIRD_PARTY_NOTICES.md')) {
    $item=Join-Path $source $name
    if(Test-Path -LiteralPath $item){Copy-Item -LiteralPath $item -Destination $modRoot -Force}
}
$config=Join-Path $profile 'Config\ModsConfig.xml'
if(-not (Test-Path -LiteralPath $config)) {
    @"
<?xml version="1.0" encoding="utf-8"?>
<ModsConfigData>
  <version>1.6.4871 rev590</version>
  <activeMods><li>brrainz.harmony</li><li>ludeon.rimworld</li><li>$packageId</li></activeMods>
  <knownExpansions><li>ludeon.rimworld</li></knownExpansions>
</ModsConfigData>
"@ | Set-Content -LiteralPath $config -Encoding utf8
}
$env:RIMUIMCP_FIXTURE= $(if($Fixture){'1'}else{'0'})
$env:RIMUIMCP_ROOT=$projectRoot
if(Test-Path -LiteralPath $logPath) {
    $archive=Join-Path $projectRoot ('work\Player-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.log')
    Move-Item -LiteralPath $logPath -Destination $archive
}
$argList=@(('-savedatafolder='+$profile),'-logFile',$logPath,'-screen-fullscreen',$(if($Fullscreen){'1'}else{'0'}),'-screen-width',[string]$WindowWidth,'-screen-height',[string]$WindowHeight)
if($Monitor -gt 0){$argList+=@('-monitor',[string]$Monitor)}
$windowStyle=if($Visible){'Normal'}else{'Hidden'}
$process=Start-Process -FilePath $gameExe -WorkingDirectory $gameRoot -ArgumentList $argList -WindowStyle $windowStyle -PassThru
[ordered]@{pid=$process.Id;startedAt=$process.StartTime.ToUniversalTime().ToString('o');fixture=[bool]$Fixture;profile=$profile;baseline=[bool]$UseBaseline} | ConvertTo-Json | Set-Content -LiteralPath $processFile -Encoding utf8
}
$deadline=(Get-Date).AddSeconds(90)
while((Get-Date) -lt $deadline) {
    if($process.HasExited){throw 'Game exited during startup; inspect work/Player.log'}
    if(Test-Path -LiteralPath $logPath) {
        $log=[string](Get-Content -LiteralPath $logPath -Raw)
        $port=[regex]::Match($log,'GABP server running standalone on port (\d+)')
        $token=[regex]::Match($log,'Bridge token: (\S+)')
        if($port.Success -and $token.Success) {
            [ordered]@{host='127.0.0.1';port=[int]$port.Groups[1].Value;token=$token.Groups[1].Value;gamePid=$process.Id} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $projectRoot 'work\connection.json') -Encoding utf8
            if(-not $UseBaseline) {
                $hostRunning=$false
                try { $hostRunning=(Invoke-RestMethod -Uri 'http://127.0.0.1:18741/health' -TimeoutSec 2).pid -gt 0 } catch { }
                if(-not $hostRunning) {
                    if(-not $env:RIMUIMCP_PYTHON) {
                        $python=Get-Command python -ErrorAction SilentlyContinue
                        if($python){$env:RIMUIMCP_PYTHON=$python.Source}
                    }
                    $nodeExe=(Get-Command node).Source
                    $hostProcess=Start-Process -FilePath $nodeExe -ArgumentList @('packages/runtime/src/host.ts') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectRoot 'work\runtime-stdout.log') -RedirectStandardError (Join-Path $projectRoot 'work\runtime-stderr.log')
                    Write-Output ('Runtime PID '+$hostProcess.Id)
                }
            }
            [ordered]@{pid=$process.Id;bridgeReady=$true;port=[int]$port.Groups[1].Value;profile=$profile;fixture=[bool]$Fixture} | ConvertTo-Json
            exit
        }
    }
    Start-Sleep -Milliseconds 500
}
throw 'Bridge startup was not observed within 90 seconds; inspect the game log without restarting a live process.'
