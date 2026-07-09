#!/usr/bin/env pwsh
#
# AgentDesk one-line Windows installer.
#
# Downloads the latest AgentDesk Setup build via PowerShell's own HTTP client (Invoke-WebRequest)
# instead of a browser Save-As. Windows only tags a downloaded file with Mark-of-the-Web /
# Zone.Identifier when a zone-aware client (browser, Outlook, etc.) fetches it - Invoke-WebRequest
# does not - so the extracted installer never triggers the SmartScreen "unrecognized publisher"
# prompt that a browser-downloaded copy of our currently-unsigned installer would show. See
# project-wiki/reference/tech-stack-build-release.md ("No code signing" gotcha) for why AgentDesk
# isn't Authenticode-signed yet. Users who instead click the Setup zip directly on the GitHub
# Releases page in a browser will still see SmartScreen - this script is an additional install
# path, not a replacement for signing.
#
# Usage (run in PowerShell):
#   irm https://raw.githubusercontent.com/sarfraznawaz2005/agentdesk/main/install.ps1 | iex
#
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# $PSVersionTable.Platform only exists on PowerShell Core (pwsh); it's absent (falsy) on Windows
# PowerShell 5.1, so this only trips on an actual non-Windows pwsh session (mac/Linux have no
# SmartScreen, so this script's whole reason to exist doesn't apply there).
if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne 'Win32NT') {
    throw "This installer is Windows-only. macOS/Linux users: download the release directly from https://github.com/sarfraznawaz2005/agentdesk/releases/latest"
}

$releaseUrl = 'https://github.com/sarfraznawaz2005/agentdesk/releases/latest/download/AgentDesk-win-x64-Setup.zip'
$tempDir = Join-Path $env:TEMP "AgentDeskInstall-$(Get-Random)"
$zipPath = Join-Path $tempDir 'AgentDesk-Setup.zip'

New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
    Write-Host "==> Downloading AgentDesk installer..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $releaseUrl -OutFile $zipPath -UseBasicParsing
    if (-not (Test-Path $zipPath)) { throw "Download failed: $releaseUrl" }

    Write-Host "==> Extracting..." -ForegroundColor Cyan
    Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force

    $setupExe = Join-Path $tempDir 'AgentDesk-Setup.exe'
    if (-not (Test-Path $setupExe)) {
        throw "AgentDesk-Setup.exe not found after extracting $zipPath"
    }

    Write-Host "==> Launching installer..." -ForegroundColor Cyan
    Start-Process -FilePath $setupExe -Wait
}
finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}

Write-Host "Done." -ForegroundColor Green
