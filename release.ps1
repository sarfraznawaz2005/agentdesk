$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "=== AgentDesk Release ===" -ForegroundColor Cyan
Write-Host ""

# ── Read current version from package.json ──────────────────────────────────
$pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
$currentVersion = $pkg.version

Write-Host "Current version: " -NoNewline
Write-Host "v$currentVersion" -ForegroundColor Yellow
Write-Host ""

# ── Ask for new version ──────────────────────────────────────────────────────
$newVersion = Read-Host "Enter new version (e.g. 1.0.1)"

if ([string]::IsNullOrWhiteSpace($newVersion)) {
    Write-Host "Aborted — no version entered." -ForegroundColor Red
    exit 1
}

# Strip leading 'v' if user typed it
$newVersion = $newVersion.TrimStart('v')

# Basic semver format check
if ($newVersion -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "Invalid version format '$newVersion'. Use MAJOR.MINOR.PATCH (e.g. 1.0.1)." -ForegroundColor Red
    exit 1
}

if ($newVersion -eq $currentVersion) {
    Write-Host "Version is already $currentVersion — nothing to do." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Releasing: " -NoNewline
Write-Host "v$currentVersion" -ForegroundColor Yellow -NoNewline
Write-Host " → " -NoNewline
Write-Host "v$newVersion" -ForegroundColor Green
Write-Host ""
$confirm = Read-Host "Confirm? (y/N)"
if ($confirm -notmatch '^[Yy]$') {
    Write-Host "Aborted." -ForegroundColor Red
    exit 1
}

Write-Host ""

# ── Check for uncommitted changes ────────────────────────────────────────────
$gitStatus = git status --porcelain
if ($gitStatus) {
    Write-Host "Warning: you have uncommitted changes:" -ForegroundColor Yellow
    Write-Host $gitStatus
    Write-Host ""
    $proceed = Read-Host "Commit all changes as part of this release? (y/N)"
    if ($proceed -notmatch '^[Yy]$') {
        Write-Host "Aborted. Commit or stash your changes first." -ForegroundColor Red
        exit 1
    }
}

# ── Update version in package.json ──────────────────────────────────────────
# Match the existing version by semver pattern (not $currentVersion) so the
# replace works even if the file had drifted out of sync, and fail loudly if
# nothing matched instead of silently leaving a stale version behind.
Write-Host "Updating package.json..." -ForegroundColor Cyan
$pkgRaw = Get-Content "package.json" -Raw
$pkgNew = $pkgRaw -replace '("version":\s*")\d+\.\d+\.\d+', ('${1}' + $newVersion)
if ($pkgNew -eq $pkgRaw) {
    Write-Host "Failed to update version in package.json — no `"version`" field matched." -ForegroundColor Red
    exit 1
}
Set-Content "package.json" $pkgNew -NoNewline
Write-Host "  package.json updated to v$newVersion" -ForegroundColor Green

# ── Update version in electrobun.config.ts ───────────────────────────────────
Write-Host "Updating electrobun.config.ts..." -ForegroundColor Cyan
$cfgRaw = Get-Content "electrobun.config.ts" -Raw
$cfgNew = $cfgRaw -replace '(version:\s*")\d+\.\d+\.\d+', ('${1}' + $newVersion)
if ($cfgNew -eq $cfgRaw) {
    Write-Host "Failed to update version in electrobun.config.ts — no version field matched." -ForegroundColor Red
    exit 1
}
Set-Content "electrobun.config.ts" $cfgNew -NoNewline
Write-Host "  electrobun.config.ts updated to v$newVersion" -ForegroundColor Green

# ── Git commit ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Committing..." -ForegroundColor Cyan
git add package.json electrobun.config.ts
if ($gitStatus) {
    git add -A
}
git commit -m "chore: release v$newVersion"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Git commit failed." -ForegroundColor Red
    exit 1
}

# ── Git tag ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Creating tag v$newVersion..." -ForegroundColor Cyan
git tag "v$newVersion"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Git tag failed." -ForegroundColor Red
    exit 1
}

# ── Push commit + tag ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Pushing to origin..." -ForegroundColor Cyan
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "Git push (main) failed." -ForegroundColor Red
    exit 1
}
git push origin "v$newVersion"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Git push (tag) failed." -ForegroundColor Red
    exit 1
}

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Released v$newVersion!" -ForegroundColor Green
Write-Host ""
Write-Host "GitHub Actions build:  https://github.com/sarfraznawaz2005/agentdesk/actions" -ForegroundColor Cyan
Write-Host "Release page:          https://github.com/sarfraznawaz2005/agentdesk/releases/tag/v$newVersion" -ForegroundColor Cyan
Write-Host ""
