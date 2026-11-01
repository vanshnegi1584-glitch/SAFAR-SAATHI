<#
SafarSaathi REAL TEST (4 seats per bus, one camera bus at a time, route 101):

  1. The driver logs in on the website and picks a bus  ->  the camera on this PC starts counting that bus.
  2. Students log in and choose their stop (route 101: Ghanta Ghar via ISBT)  ->  each is allocated a bus.
  3. People step in front of the camera: at 4/4 the bus turns FULL by itself, the test driver drives it
     GEU -> ISBT -> Saharanpur Chowk -> Darshan Lal Chowk -> Ghanta Ghar, and students allocated from then on
     get the next bus.

Starts, each in its own window: the SafarSaathi backend (TEST_BUS_CAPACITY=4, AUTO_FULL_FROM_COUNT=1, in memory only:
the team database keeps the real capacities), the website, the camera agent (opens the camera when the driver picks a
bus) and the test driver for route 101. Then opens the login page.

Run:   powershell -ExecutionPolicy Bypass -File D:\SAFAR-SAATHI\demo\start-test.ps1
Stop:  powershell -ExecutionPolicy Bypass -File D:\SAFAR-SAATHI\demo\stop-demo.ps1
Options: -Seats 4  -Route 101  -SpeedKmh 60 (test drive speed)
#>
param([int]$Seats = 4, [int]$Route = 101, [int]$SpeedKmh = 60)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Running = Join-Path $PSScriptRoot '.running.json'
$started = @()
. (Join-Path $PSScriptRoot 'lib.ps1')

$busy = @(8000, 5173, 8011) | Where-Object { Test-Port $_ }
if ($busy) { throw "Port(s) $($busy -join ', ') already in use: a demo or test is running. Run demo\stop-demo.ps1 first." }

Write-Host "Starting the SafarSaathi real test ($Seats seats per bus, route $Route)..."

# 1. Backend with the test settings (environment variables override backend/.env; nothing is written to bus data).
Start-Part "SafarSaathi backend (TEST: $Seats seats)" (Join-Path $Root 'Siddhant\backend') `
  "`$env:TEST_BUS_CAPACITY = '$Seats'; `$env:AUTO_FULL_FROM_COUNT = '1'; .\.venv\Scripts\uvicorn.exe main:app --host 127.0.0.1 --port 8000"
Wait-Port 8000 'SafarSaathi backend'

# 2. Website (its .env.local sets VITE_CAMERA_AGENT_URL, so the Staff page drives the camera on this PC).
Start-Part 'SafarSaathi website' (Join-Path $Root 'Siddhant\frontend\web') 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort'

# 3. Camera agent: starts the AI counter (detection window) for whichever bus the driver picks.
Start-Part 'camera agent' (Join-Path $Root 'vision') `
  ".\.venv\Scripts\python.exe camera_agent.py --backend http://127.0.0.1:8000 --capacity $Seats"
Wait-Port 8011 'camera agent'

# 4. Test driver: parks boarding buses at GEU; drives a bus to the end of the route once it is full.
Start-Part "test driver (route $Route)" (Join-Path $Root 'Siddhant') `
  ".\backend\.venv\Scripts\python.exe -u tools\test_drive.py --route $Route --speed-kmh $SpeedKmh"

Wait-Port 5173 'SafarSaathi website'
Start-Process 'http://localhost:5173/login'

Write-Host ""
Write-Host "Real test running. Steps:"
Write-Host "  1. Driver: log in (Staff), pick a route $Route bus (students go to the earliest one first), press Open boarding."
Write-Host "     The camera window opens for that bus."
Write-Host "  2. Students: log in, choose route $Route and their stop (Saharanpur Chowk / Darshan Lal Chowk / Ghanta Ghar)."
Write-Host "  3. $Seats people in front of the camera -> FULL -> the bus drives to the end of the route; new students get the next bus."
Write-Host "Stop everything: powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\stop-demo.ps1`""
