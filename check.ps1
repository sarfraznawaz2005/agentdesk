#Requires -Version 5.1
<#
  Fast project health check: typecheck + tests + lint, run in PARALLEL.

  Output contract:
    - Everything passes  -> ONE green line.
    - Something fails     -> a short OK/FAIL line per check, then the
                             project-only output of each failed check
                             (node_modules excluded) so you can paste it to an AI.

  Run it via check.bat, or directly:  pwsh -File check.ps1
  Use -Clean (check.bat -Clean) to wipe the caches first for a full, trust-nothing run.
#>

param([switch]$Clean)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# Incremental caches live under node_modules/.cache (already git-ignored). They make
# repeat runs much faster: tsc re-checks only changed files + dependents, eslint
# re-lints only changed files. Both invalidate correctly on real changes.
$cacheRel = 'node_modules/.cache/agentdesk-check'
$cacheAbs = Join-Path $root $cacheRel
# -Clean wipes the caches so every file is re-checked from scratch.
if ($Clean -and (Test-Path -LiteralPath $cacheAbs)) {
  Remove-Item -LiteralPath $cacheAbs -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $cacheAbs | Out-Null

# name -> shell command. Each runs from the project root in its own job.
# tsc/eslint flags are forwarded through the package.json scripts.
$checks = @(
  @{ Name = 'Typecheck'; Cmd = "bun run typecheck -- --incremental --tsBuildInfoFile $cacheRel/tsc.tsbuildinfo" },
  @{ Name = 'Tests';     Cmd = 'bun test' },
  @{ Name = 'Lint';      Cmd = "bun run lint -- --cache --cache-strategy content --cache-location $cacheRel/eslintcache" }
)

# Launch all checks at once (background jobs run concurrently).
$jobs = foreach ($c in $checks) {
  Start-Job -Name $c.Name -ScriptBlock {
    param($root, $cmd)
    Set-Location -LiteralPath $root
    # cmd /c merges stderr into stdout (2>&1) so we capture everything the tool prints.
    $out = cmd /c "$cmd 2>&1"
    [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
  } -ArgumentList $root, $c.Cmd
}

$null = Wait-Job -Job $jobs

$results = foreach ($j in $jobs) {
  $r     = Receive-Job -Job $j
  $name  = $j.Name
  # Drop any line that refers to node_modules — we only care about our own source.
  $proj  = ($r.Output -split "`r?`n") | Where-Object { $_ -notmatch 'node_modules' }

  switch ($name) {
    # tsc exits non-zero even for ignored lib errors; key off real project "error TS" lines.
    'Typecheck' { $failed = @($proj | Where-Object { $_ -match 'error TS' }).Count -gt 0 }
    # eslint lints src/ only and bun test runs project tests, so the exit code is authoritative.
    default     { $failed = $r.ExitCode -ne 0 }
  }

  [PSCustomObject]@{
    Name   = $name
    Failed = [bool]$failed
    Output = (($proj -join "`n").Trim())
  }
}

Remove-Job -Job $jobs -Force

$sw.Stop()
$secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)

$order = @{ 'Typecheck' = 0; 'Tests' = 1; 'Lint' = 2 }
$bad   = @($results | Where-Object { $_.Failed })

if ($bad.Count -eq 0) {
  Write-Host ("OK  All checks passed - typecheck, tests, lint ({0}s)" -f $secs) -ForegroundColor Green
  exit 0
}

# Per-check status (compact), then the error output for the failed ones.
foreach ($res in ($results | Sort-Object { $order[$_.Name] })) {
  if ($res.Failed) { Write-Host ("FAIL  {0}" -f $res.Name) -ForegroundColor Red }
  else             { Write-Host ("OK    {0}" -f $res.Name) -ForegroundColor Green }
}

foreach ($res in ($bad | Sort-Object { $order[$_.Name] })) {
  Write-Host ""
  Write-Host ("===== {0} =====" -f $res.Name) -ForegroundColor Yellow
  if ([string]::IsNullOrWhiteSpace($res.Output)) {
    Write-Host "(no project output captured - check the tool's exit status)"
  } else {
    Write-Host $res.Output
  }
}

exit 1
