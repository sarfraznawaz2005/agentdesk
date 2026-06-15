@echo off
REM Run the parallel project health check (typecheck + tests + lint).
REM Prefers PowerShell 7 (pwsh); falls back to Windows PowerShell 5.1.
setlocal
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0check.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check.ps1" %*
)
exit /b %errorlevel%
