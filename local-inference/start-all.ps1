# start-all.ps1 — spawn the local-inference Python servers in background
#
# Each server logs stdout+stderr to <script-dir>\logs\<name>_stdout.log.
# Use Stop-Process or Get-Job/Stop-Job to terminate.
#
# Usage:  pwsh <repo>\local-inference\start-all.ps1
# Then:   pwsh <repo>\local-inference\healthcheck.ps1   (waits for all to be ready)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logsDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

function Start-Server {
    param(
        [string]$Name,
        [string]$VenvPython,
        [string]$Script,
        [int]$Port
    )

    if (-not (Test-Path $VenvPython)) {
        Write-Warning "[$Name] python not found at $VenvPython — skipping"
        return
    }
    if (-not (Test-Path $Script)) {
        Write-Warning "[$Name] script not found at $Script — skipping (server may not be implemented yet)"
        return
    }

    $log = Join-Path $logsDir "${Name}_stdout.log"
    Write-Host "[$Name] starting on port $Port -> $log"
    $proc = Start-Process -FilePath $VenvPython `
        -ArgumentList $Script `
        -WorkingDirectory $root `
        -RedirectStandardOutput $log `
        -RedirectStandardError "$log.err" `
        -PassThru `
        -WindowStyle Hidden
    Write-Host "[$Name] pid=$($proc.Id)"
    return $proc
}

$voxcpm = Start-Server -Name 'voxcpm2' -VenvPython 'D:\VoxCPM\.venv\Scripts\python.exe' -Script "$root\voxcpm2_server.py" -Port 7861
$zimage = Start-Server -Name 'zimage'  -VenvPython 'D:\Z-Image\.venv\Scripts\python.exe' -Script "$root\zimage_server.py"  -Port 7862
$ltx2   = Start-Server -Name 'ltx2'    -VenvPython 'D:\LTX-2\.venv\Scripts\python.exe'   -Script "$root\ltx2_server.py"    -Port 7863

Write-Host ""
Write-Host "Servers spawned. Wait for /healthz to return 200 with healthcheck.ps1."
Write-Host "Tail logs: Get-Content -Wait $logsDir\<name>_stdout.log"
