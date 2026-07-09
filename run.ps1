# Enable WebView2 remote debugging so edge://inspect can attach DevTools to the live app
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"

# Detect if the user wants the freelance feature enabled before the build wipes the bin dir.
# Checks both the bin output dir and the project root so either placement works.
$binDir = Join-Path $PSScriptRoot "build\dev-win-x64\AgentDesk-dev\bin"
$freelanceEnabled = (Test-Path (Join-Path $binDir "freelance")) -or (Test-Path (Join-Path $PSScriptRoot "freelance"))
$claudeEnabled = (Test-Path (Join-Path $binDir "claude")) -or (Test-Path (Join-Path $PSScriptRoot "claude"))
$autoearnEnabled = (Test-Path (Join-Path $binDir "autoearn")) -or (Test-Path (Join-Path $PSScriptRoot "autoearn"))

# Start Vite dev server in a hidden window so it doesn't share the console
$vite = Start-Process -FilePath "cmd" -ArgumentList "/c bun run hmr" -PassThru -WindowStyle Hidden

# Poll until Vite is ready (up to 30 seconds)
Write-Host "Waiting for Vite dev server on http://localhost:5173..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        Invoke-WebRequest -Uri "http://localhost:5173" -Method HEAD -TimeoutSec 1 -ErrorAction Stop | Out-Null
        $ready = $true
        Write-Host "Vite ready. Starting Electrobun..."
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

if (-not $ready) {
    Write-Host "Vite did not start in time. Launching anyway..."
}

# If the freelance or claude flags were present, spawn a background watcher that recreates
# them in the bin dir after every Electrobun build (initial or hot-rebuild) which wipes that folder.
$watcher = $null
if ($freelanceEnabled -or $claudeEnabled -or $autoearnEnabled) {
    if ($freelanceEnabled) { Write-Host "Freelance feature flag detected - preserving it across rebuilds." }
    if ($claudeEnabled)    { Write-Host "Claude subscription flag detected - preserving it across rebuilds." }
    if ($autoearnEnabled)  { Write-Host "Auto-Earn feature flag detected - preserving it across rebuilds." }
    $watcher = Start-Job -ScriptBlock {
        param($dir, $freelance, $claude, $autoearn)
        while ($true) {
            if (Test-Path $dir) {
                if ($freelance -and -not (Test-Path (Join-Path $dir "freelance"))) {
                    New-Item -ItemType File -Path (Join-Path $dir "freelance") -Force | Out-Null
                }
                if ($claude -and -not (Test-Path (Join-Path $dir "claude"))) {
                    New-Item -ItemType File -Path (Join-Path $dir "claude") -Force | Out-Null
                }
                if ($autoearn -and -not (Test-Path (Join-Path $dir "autoearn"))) {
                    New-Item -ItemType File -Path (Join-Path $dir "autoearn") -Force | Out-Null
                }
            }
            Start-Sleep -Milliseconds 500
        }
    } -ArgumentList $binDir, $freelanceEnabled, $claudeEnabled, $autoearnEnabled
}

# Start Electrobun (blocks until app closes or Ctrl+C).
# Note: --watch was tried but fails on Windows with EACCES when rebuilding -
# the killed app's bun.exe / native DLLs stay locked briefly after exit, and
# Electrobun's rmSync(buildFolder) races with that. Vite HMR still works for
# src/mainview/* via the dev server above. Bun-side edits require manual restart.
cmd /c "bunx electrobun dev"

# Kill flag watcher job
if ($watcher) {
    Stop-Job $watcher
    Remove-Job $watcher
}

# Kill Vite and all its child processes (bun) when app exits
taskkill /F /T /PID $vite.Id 2>$null | Out-Null
