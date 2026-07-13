# Enable WebView2 remote debugging so edge://inspect can attach DevTools to the live app.
# --use-fake-ui-for-media-stream: WebView2 does not persist the mic "Allow" decision across
# app restarts, and Electrobun exposes no config hook for WebView2's SavesInProfile permission
# option (see demo/voice-input's README for the investigation). This flag auto-accepts
# getUserMedia/SpeechRecognition mic requests silently for dev runs launched via this script.
# NOTE: this must be set here (before the app process is spawned) — setting it from inside
# src/bun/index.ts does NOT work, because that code runs in a Bun Worker thread whose
# process.env is isolated from the real OS environment block WebView2Loader.dll reads.
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222 --use-fake-ui-for-media-stream"

# Detect if the user wants the freelance feature enabled before the build wipes the bin dir.
# Checks both the bin output dir and the project root so either placement works.
$binDir = Join-Path $PSScriptRoot "build\dev-win-x64\AgentDesk-dev\bin"
$freelanceEnabled = (Test-Path (Join-Path $binDir "freelance")) -or (Test-Path (Join-Path $PSScriptRoot "freelance"))
$claudeEnabled = (Test-Path (Join-Path $binDir "claude")) -or (Test-Path (Join-Path $PSScriptRoot "claude"))

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
if ($freelanceEnabled -or $claudeEnabled) {
    if ($freelanceEnabled) { Write-Host "Freelance feature flag detected - preserving it across rebuilds." }
    if ($claudeEnabled)    { Write-Host "Claude subscription flag detected - preserving it across rebuilds." }
    $watcher = Start-Job -ScriptBlock {
        param($dir, $freelance, $claude)
        while ($true) {
            if (Test-Path $dir) {
                if ($freelance -and -not (Test-Path (Join-Path $dir "freelance"))) {
                    New-Item -ItemType File -Path (Join-Path $dir "freelance") -Force | Out-Null
                }
                if ($claude -and -not (Test-Path (Join-Path $dir "claude"))) {
                    New-Item -ItemType File -Path (Join-Path $dir "claude") -Force | Out-Null
                }
            }
            Start-Sleep -Milliseconds 500
        }
    } -ArgumentList $binDir, $freelanceEnabled, $claudeEnabled
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
