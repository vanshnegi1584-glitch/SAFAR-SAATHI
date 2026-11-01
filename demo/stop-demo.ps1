<#
Stops everything demo\start-demo.ps1 started: each of its windows with everything running in it.
Run:  powershell -ExecutionPolicy Bypass -File D:\SAFAR-SAATHI\demo\stop-demo.ps1
#>
$Running = Join-Path $PSScriptRoot '.running.json'

# The windows start-demo.ps1 opened: from its record, plus any PowerShell window whose (encoded) command sets a
# "SafarSaathi - ..." title, so a lost or stale record never leaves parts running.
$parts = @()
if (Test-Path $Running) {
  $parts = @((Get-Content $Running -Raw | ConvertFrom-Json) | ForEach-Object { $_ })   # unroll: PS 5.1 returns one array object
}
foreach ($p in Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'") {
  if ($p.CommandLine -notmatch '-EncodedCommand\s+(\S+)') { continue }
  try { $cmd = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])) } catch { continue }
  if ($cmd -match "WindowTitle = 'SafarSaathi - ([^']+)'" -and -not ($parts | Where-Object { $_.pid -eq $p.ProcessId })) {
    $parts += [pscustomobject]@{ title = $Matches[1]; pid = $p.ProcessId }
  }
}
if ($parts.Count -eq 0) { Write-Host 'Nothing to stop: no demo windows are running.'; Remove-Item $Running -ErrorAction SilentlyContinue; return }

# Last started first, so the camera stops before the services it posts to.
[array]::Reverse($parts)
$left = @()
foreach ($p in $parts) {
  if (-not (Get-Process -Id $p.pid -ErrorAction SilentlyContinue)) { Write-Host "  already closed: $($p.title)"; continue }
  taskkill.exe /PID $p.pid /T /F *> $null   # the window and everything started in it
  Start-Sleep -Milliseconds 300
  if (Get-Process -Id $p.pid -ErrorAction SilentlyContinue) { $left += $p; Write-Host "  could NOT stop: $($p.title) (pid $($p.pid))" }
  else { Write-Host "  stopped: $($p.title)" }
}
if ($left.Count) { Write-Host 'Some parts are still running; close their windows by hand.'; exit 1 }
Remove-Item $Running -ErrorAction SilentlyContinue
Write-Host 'Demo stopped.'
