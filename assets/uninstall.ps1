# AgentDesk Uninstaller
# Bundled at: Resources/app/uninstall.ps1
# Called by the Windows "Add or Remove Programs" UninstallString.
# PowerShell loads the full script before executing, so deleting this file's
# parent directory mid-run is safe.

$identifier  = "com.sarfrazai.agentdesk"
$channel     = "stable"
$channelRoot = Join-Path $env:LOCALAPPDATA "$identifier\$channel"
$regPath     = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$identifier"

# Kill any running app process
Get-Process -Name "launcher" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Remove only the stable channel — leaves dev and any other channels intact
if (Test-Path $channelRoot) {
    Remove-Item -Path $channelRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# Remove the "Add or Remove Programs" registry entry
if (Test-Path $regPath) {
    Remove-Item -Path $regPath -Recurse -Force -ErrorAction SilentlyContinue
}
