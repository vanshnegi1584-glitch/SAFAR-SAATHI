# Shared by start-demo.ps1 and start-test.ps1 (dot-sourced): start a titled window, wait for a port.
# Each window's title starts with "SafarSaathi - " so stop-demo.ps1 can always find it.

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
