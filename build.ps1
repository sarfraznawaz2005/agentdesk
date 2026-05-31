$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "=== AgentDesk Build (stable) ==="
Write-Host ""

$buildEnv = "stable"

Write-Host ""
Write-Host "Step 1: Building frontend (Vite)..."
Write-Host ""

& bun run vite build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Vite build failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Step 2: Building app (Electrobun --env=$buildEnv)..."
Write-Host ""

& bunx electrobun build "--env=$buildEnv"

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Build complete!"
    if ($buildEnv -eq "stable") {
        Write-Host "Output: $ScriptDir\build\stable-win-x64\"
        Write-Host ""
        Write-Host "Note: To distribute without SmartScreen warnings, sign the executable"
        Write-Host "with an EV code signing certificate using signtool.exe."
    } else {
        Write-Host "Output: $ScriptDir\build\dev-win-x64\"
    }
} else {
    Write-Host "Build failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
