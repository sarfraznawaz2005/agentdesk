$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "=== AgentDesk Build (stable, local, no installer) ===" -ForegroundColor Cyan
Write-Host ""

$buildEnv = "stable"

# A normal `electrobun build` (non-dev channel) downloads the CURRENTLY
# PUBLISHED release tarball from electrobun.config.ts's release.baseUrl (real
# GitHub Releases) to compute a binary diff for the auto-updater's
# incremental patches — that's correct for a real release (release.yml), but
# pointless and slow here: this is a local build of whatever's on disk right
# now, nothing has been published yet, and it has no network dependency on
# GitHub either way. electrobun.config.ts reads this to set
# release.generatePatch = false for just this run.
$env:AGENTDESK_SKIP_PATCH = "1"

Write-Host "Step 1: Building frontend (Vite)..." -ForegroundColor Cyan
Write-Host ""
& bun run vite build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Vite build failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Step 2: Building app (Electrobun --env=$buildEnv)..." -ForegroundColor Cyan
Write-Host ""
& bunx electrobun build "--env=$buildEnv"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}

# electrobun build always additionally wraps the build in an NSIS installer
# (AgentDesk-Setup.exe/.zip) on Windows — there's no config flag to skip
# that step. Since this script's whole point is a fast, runnable local
# build (not something to hand to another user to install), extract the
# actual runnable app directly from the raw runtime tarball electrobun
# already produced in artifacts/ instead of using the installer output, then
# discard the installer-specific artifacts so there's only one obvious
# thing to run.
Write-Host ""
Write-Host "Step 3: Extracting runnable app (skipping installer)..." -ForegroundColor Cyan
Write-Host ""

$artifactsDir = Join-Path $ScriptDir "artifacts"
$runtimeTarZst = Join-Path $artifactsDir "$buildEnv-win-x64-AgentDesk.tar.zst"
if (-not (Test-Path $runtimeTarZst)) {
    Write-Host "Expected runtime tarball not found: $runtimeTarZst" -ForegroundColor Red
    exit 1
}

$outputDir = Join-Path $ScriptDir "build\$buildEnv-win-x64"
Remove-Item -Recurse -Force $outputDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$zigZstd = Join-Path $ScriptDir "node_modules\electrobun\dist-win-x64\zig-zstd.exe"
$tempTar = Join-Path $outputDir "app.tar"
& $zigZstd decompress -i $runtimeTarZst -o $tempTar
if ($LASTEXITCODE -ne 0) {
    Write-Host "zstd decompress failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
C:\Windows\System32\tar.exe -xf $tempTar -C $outputDir
if ($LASTEXITCODE -ne 0) {
    Write-Host "tar extract failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
Remove-Item -Force $tempTar

# Discard the installer-specific artifacts (Setup.exe/.zip/.tar.zst/metadata,
# the patch file if one was somehow still produced) — none of them are the
# runnable app, and leaving them around invites confusion about which file
# to actually launch. The runtime tarball, update.json, and the extracted
# app folder are all that's left.
Remove-Item -Force (Join-Path $artifactsDir "$buildEnv-win-x64-AgentDesk-Setup.zip") -ErrorAction SilentlyContinue
Get-ChildItem $artifactsDir -Filter "$buildEnv-win-x64-*.patch" -ErrorAction SilentlyContinue | Remove-Item -Force

$launcherPath = Join-Path $outputDir "AgentDesk\bin\launcher.exe"

Write-Host ""
Write-Host "Build complete!" -ForegroundColor Green
Write-Host "Runnable app: $outputDir\AgentDesk\"
Write-Host "Launch with:  $launcherPath"
Write-Host ""
Write-Host "Note: To distribute an installer without SmartScreen warnings, sign the" -ForegroundColor DarkGray
Write-Host "executable with an EV code signing certificate using signtool.exe — the" -ForegroundColor DarkGray
Write-Host "real installer is what release.ps1 + GitHub Actions produce, not this script." -ForegroundColor DarkGray
