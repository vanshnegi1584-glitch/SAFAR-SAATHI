<#
SafarSaathi demo: starts every part on this laptop, in order, each in its own window, and opens the website.

  Camera (AI people counter, bus 18)  -> vision bridge :8010 -> GPS tracking server :4000 (TransitLink, :3000)
                                      -> SafarSaathi backend :8000 -> SafarSaathi website :5173 (live, real time)
  Simulated test buses (6 + bus 18's GPS) -> GPS tracking server -> GPS feed -> SafarSaathi backend

The camera window shows what the AI sees (boxes, P-IDs); the count reaches the website about every second.
If the camera window is closed by mistake it restarts by itself; stop everything with demo\stop-demo.ps1.

Run from anywhere:   powershell -ExecutionPolicy Bypass -File D:\SAFAR-SAATHI\demo\start-demo.ps1
Options:  -NoSimulator   only bus 18 (camera + its GPS from the driver app), no simulated buses
          -NoTransitLink skip the TransitLink dispatcher website (:3000)

Needs (already set up on this laptop): vision\.venv, Siddhant\backend\.venv + .env, Siddhant\frontend\web\node_modules
+ .env.local, GPS\node_modules + apps\tracking-server\.env. Local development only: uses the GPS server's dev tokens.
#>
param([switch]$NoSimulator, [switch]$NoTransitLink)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Dev = 'dev:00000000-0000-4000-8000-00000000a001'   # dev:local admin token (in-memory dev server only)
$Running = Join-Path $PSScriptRoot '.running.json'
$started = @()

function Start-Part($title, $dir, $command) {
  # -EncodedCommand: no quoting problems with JSON settings or paths.
  $script = "`$Host.UI.RawUI.WindowTitle = 'SafarSaathi - $title'`n$command"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $p = Start-Process powershell.exe -WorkingDirectory $dir -PassThru `
    -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc
  $script:started += [pscustomobject]@{ title = $title; pid = $p.Id }
  $script:started | ConvertTo-Json | Set-Content -Encoding utf8 $Running
  Write-Host "  started: $title"
}

function Test-Port($port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { return $c.ConnectAsync('127.0.0.1', $port).Wait(400) -and $c.Connected } catch { return $false } finally { $c.Dispose() }
}

function Wait-Port($port, $what, $seconds = 150) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $port) { Write-Host "  ready:   $what (port $port)"; return }
    Start-Sleep -Milliseconds 700
  }
  throw "$what did not start on port $port within $seconds s. Look at its window for the error, then run demo\stop-demo.ps1."
}

$ports = @(8010, 4000, 8000, 5173) + $(if ($NoTransitLink) { @() } else { @(3000) })
$busy = $ports | Where-Object { Test-Port $_ }
if ($busy) { throw "Port(s) $($busy -join ', ') already in use: the demo (or part of it) is already running. Run demo\stop-demo.ps1 first." }

Write-Host "Starting the SafarSaathi demo..."

# 1. Vision bridge for bus 18 (fuses the camera count with door-counter data; the GPS server reads it).
Start-Part 'vision bridge (bus 18)' (Join-Path $Root 'vision') `
  "`$env:VISION_BUS_ID = '18'; .\.venv\Scripts\python.exe -m uvicorn service:app --host 127.0.0.1 --port 8010"
Wait-Port 8010 'vision bridge'

# 2. GPS tracking server (in-memory), told where each bus's people counter is.
$seat = @{ 'bus-uk07pa1696' = 'http://127.0.0.1:8010' }
if (-not $NoSimulator) {
  $seat['bus-uk07pa3542'] = 'http://127.0.0.1:8021'; $seat['bus-uk07pa5017'] = 'http://127.0.0.1:8022'
  $seat['bus-uk07pa2623'] = 'http://127.0.0.1:8023'; $seat['bus-uk07pa4160'] = 'http://127.0.0.1:8024'
  $seat['bus-uk07pa1944'] = 'http://127.0.0.1:8025'; $seat['bus-ua07q4731'] = 'http://127.0.0.1:8026'
}
$seatJson = ($seat | ConvertTo-Json -Compress)
Start-Part 'GPS tracking server' (Join-Path $Root 'GPS') `
  "`$env:SEAT_SOURCES = '$seatJson'; npm run dev:local -w @transitlink/tracking-server"
Wait-Port 4000 'GPS tracking server'

# Its database lives in memory: put the approved stops and route paths back.
Push-Location (Join-Path $Root 'GPS')
try {
  $env:TRACKING_ADMIN_TOKEN = $Dev
  npm run -s stops -w @transitlink/tracking-server -- import ../../data/stop-locations.json
  if ($LASTEXITCODE -ne 0) { throw 'Restoring stops and routes failed (see above).' }
} finally { Remove-Item Env:TRACKING_ADMIN_TOKEN -ErrorAction SilentlyContinue; Pop-Location }

# 3. SafarSaathi backend (Siddhant) against the team database.
Start-Part 'SafarSaathi backend' (Join-Path $Root 'Siddhant\backend') `
  '.\.venv\Scripts\uvicorn.exe main:app --host 127.0.0.1 --port 8000'
Wait-Port 8000 'SafarSaathi backend'

# 4. Simulated buses on the 7 test routes (bus 18 included: its GPS; its people count comes from the camera).
if (-not $NoSimulator) {
  Start-Part 'simulated buses' $Root 'node demo\sim_fleet.mjs'
}

# 5. Bus positions (and simulated counts) from the GPS server into the SafarSaathi backend.
Start-Part 'GPS feed to SafarSaathi' (Join-Path $Root 'Siddhant') `
  ".\backend\.venv\Scripts\python.exe -u tools\gps_feed.py --tracking http://localhost:4000 --tracking-token $Dev --backend http://127.0.0.1:8000 --counts-from ir"

# 6. Websites.
Start-Part 'SafarSaathi website' (Join-Path $Root 'Siddhant\frontend\web') 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort'
if (-not $NoTransitLink) {
  Start-Part 'TransitLink dispatcher website' (Join-Path $Root 'GPS') 'npm run dev:web'
}

# 7. The AI camera: detection window on, count to both the bridge and the backend every second.
#    Restarts on its own if its window is closed or the camera hiccups; close this PowerShell window to stop it.
Start-Part 'AI camera counter (bus 18)' (Join-Path $Root 'vision') @'
while ($true) {
  .\.venv\Scripts\python.exe count.py --bus 18 --show --responsive --interval 1 --fusion-url http://127.0.0.1:8010 --backend http://127.0.0.1:8000
  Write-Host 'Camera counter stopped. Restarting in 3 s (close this window, or run demo\stop-demo.ps1, to stop it).'
  Start-Sleep -Seconds 3
}
'@

Wait-Port 5173 'SafarSaathi website'
Start-Process 'http://localhost:5173/live'
if (-not $NoTransitLink) {
  Wait-Port 3000 'TransitLink dispatcher website' 240
  Start-Process 'http://localhost:3000/tracking'
}

Write-Host ""
Write-Host "Demo running. Website: http://localhost:5173/live (public) - log in for the passenger / staff / office pages."
Write-Host "The camera window shows the AI detections; the bus 18 count updates on the website about every second."
Write-Host "Stop everything: powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\stop-demo.ps1`""
