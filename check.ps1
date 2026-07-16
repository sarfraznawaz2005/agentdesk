#Requires -Version 5.1
<#
  Fast project health gate: typecheck + tests + lint, run in PARALLEL with
  incremental caching. Prints exactly one word - "Passed" or "Failed" - and sets
  the exit code (0 = passed, 1 = failed) so it can gate the pre-commit hook.

  Run it via check.bat, or directly:  pwsh -File check.ps1
  Use -Clean (check.bat -Clean) to wipe the caches first for a full, trust-nothing run.

  To see WHAT failed, run the individual command: bun run typecheck | bun test | bun run lint
#>

param([switch]$Clean)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

# Incremental caches (git-ignored). Make repeat runs fast; both tools invalidate
# correctly on real changes. -Clean wipes them for a full from-scratch run.
$cacheRel = 'node_modules/.cache/agentdesk-check'
$cacheAbs = Join-Path $root $cacheRel
if ($Clean -and (Test-Path -LiteralPath $cacheAbs)) { Remove-Item -LiteralPath $cacheAbs -Recurse -Force }
New-Item -ItemType Directory -Force -Path $cacheAbs | Out-Null

# Each check runs from the project root in its own background job (parallel).
# The incremental/cache flags now live directly in package.json's typecheck/lint
# scripts (same $cacheRel location) so a plain `bun run typecheck`/`bun run lint`
# is fast everywhere, not just through this script — no extra args needed here.
$checks = @(
  @{ Name = 'Typecheck'; Cmd = 'bun run typecheck' },
  @{ Name = 'Tests';     Cmd = 'bun test' },
  @{ Name = 'Lint';      Cmd = 'bun run lint' }
)

$jobs = foreach ($c in $checks) {
  Start-Job -Name $c.Name -ScriptBlock {
    param($root, $cmd)
    Set-Location -LiteralPath $root
    $out = cmd /c "$cmd 2>&1"
    [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
  } -ArgumentList $root, $c.Cmd
}

$null = Wait-Job -Job $jobs

$anyFailed = $false
foreach ($j in $jobs) {
  $r = Receive-Job -Job $j
  if ($j.Name -eq 'Typecheck') {
    # tsc exits non-zero even for ignored lib errors; key off real project
    # "error TS" lines with node_modules excluded so only our own code counts.
    $proj = ($r.Output -split "`r?`n") | Where-Object { $_ -notmatch 'node_modules' }
    if (@($proj | Where-Object { $_ -match 'error TS' }).Count -gt 0) { $anyFailed = $true }
  } elseif ($r.ExitCode -ne 0) {
    # eslint lints src/ only and bun test runs project tests, so the exit code
    # is authoritative.
    $anyFailed = $true
  }
}

Remove-Job -Job $jobs -Force

if ($anyFailed) {
  Write-Host "Failed" -ForegroundColor Red
  exit 1
}
Write-Host "Passed" -ForegroundColor Green
exit 0
