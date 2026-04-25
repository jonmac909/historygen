# healthcheck.ps1 — wait for all 3 local-inference servers to return 200 from /healthz
#
# Servers lazy-load their models on first request, so /healthz returns 200 immediately
# (idle/false). Use /healthz?ready=1 to block until model is loaded.
#
# Usage:           pwsh D:\local-inference\healthcheck.ps1
# Block-until-ready: pwsh D:\local-inference\healthcheck.ps1 -Ready
# Specific server: pwsh D:\local-inference\healthcheck.ps1 -Only voxcpm2

param(
    [switch]$Ready,
    [string]$Only = ''
)

$ErrorActionPreference = 'Stop'

$servers = @(
    @{ Name = 'voxcpm2'; Url = 'http://localhost:7861/healthz'; LoadTimeoutSec = 60 },
    @{ Name = 'zimage';  Url = 'http://localhost:7862/healthz'; LoadTimeoutSec = 180 },
    @{ Name = 'ltx2';    Url = 'http://localhost:7863/healthz'; LoadTimeoutSec = 600 }
)

if ($Only) {
    $servers = $servers | Where-Object { $_.Name -eq $Only }
    if ($servers.Count -eq 0) {
        Write-Error "Unknown server '$Only'. Valid: voxcpm2, zimage, ltx2."
        exit 2
    }
}

$failed = 0
foreach ($s in $servers) {
    $url = if ($Ready) { "$($s.Url)?ready=1" } else { $s.Url }
    $timeout = if ($Ready) { $s.LoadTimeoutSec } else { 5 }
    Write-Host -NoNewline "[$($s.Name)] $url ... "
    try {
        $r = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec $timeout
        $status = $r.status
        $loaded = $r.modelLoaded
        if ($r.status -eq 'ready' -or (-not $Ready -and $r.status -in @('idle','ready'))) {
            Write-Host "OK status=$status modelLoaded=$loaded"
        }
        else {
            Write-Host "DEGRADED status=$status modelLoaded=$loaded" -ForegroundColor Yellow
            $failed++
        }
    }
    catch {
        Write-Host "FAIL ($($_.Exception.Message))" -ForegroundColor Red
        $failed++
    }
}

if ($failed -eq 0) { exit 0 } else { exit 1 }
