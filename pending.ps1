$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# --- Configuration -------------------------------------------------------------
$MODELS_URL = "https://models.inference.ai.azure.com/chat/completions"
$AI_MODEL   = "gpt-4o-mini"

Write-Host ""
Write-Host "=== Pending Release Notes ===" -ForegroundColor Cyan
Write-Host ""

# -- Current version ----------------------------------------------------------
$pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
$currentVersion = $pkg.version

Write-Host "Current version: " -NoNewline
Write-Host "v$currentVersion" -ForegroundColor Yellow
Write-Host ""

# -- Collect commits since last tag -------------------------------------------
$lastTag = git describe --tags --abbrev=0 2>$null
$commitRange = if ($lastTag) { "$lastTag..HEAD" } else { "HEAD" }
$commits = @(git log $commitRange --pretty=format:"%s" 2>$null | Where-Object { $_ -ne "" })

if ($commits.Count -eq 0) {
    Write-Host "  No commits since last tag ($lastTag) - nothing pending." -ForegroundColor Yellow
    Write-Host ""
    exit 0
}

$rangeLabel = if ($lastTag) { "since $lastTag" } else { "all commits" }
Write-Host "  $($commits.Count) commit(s) $rangeLabel" -ForegroundColor DarkGray
Write-Host ""

# -- Load GITHUB_TOKEN ---------------------------------------------------------
$token = $env:GITHUB_TOKEN
if (-not $token) { $token = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "User") }

if (-not $token) {
    Write-Host "  GITHUB_TOKEN not set - cannot generate AI notes." -ForegroundColor Yellow
    Write-Host "  Raw commits:" -ForegroundColor DarkGray
    foreach ($c in $commits) { Write-Host "    * $c" -ForegroundColor DarkGray }
    Write-Host ""
    exit 0
}

# -- Ask AI for draft notes ----------------------------------------------------
Write-Host "  Asking AI for draft notes..." -ForegroundColor DarkGray

$commitList = $commits -join "`n"

$systemPrompt = @"
You are writing release notes for AgentDesk, an AI-powered desktop development platform used by software developers.

Given a list of git commit messages, produce a concise release notes entry for end users.

INCLUDE (user-facing):
- feat: / feature: - new features or capabilities
- fix: / bugfix: - bug fixes that affect users
- perf: - performance improvements users notice
- ui: / ux: - interface and experience improvements

DISCARD (dev-internal, never mention to users):
- chore:, ci:, build:, test:, refactor:, style:, revert: commits
- Dependency/package version bumps
- Dev scripts, tooling, CI configuration
- Release commits ("chore: release vX.Y.Z")
- Internal refactors with no user-visible effect

RULES:
1. Group related commits into a single bullet - do not repeat nearly-identical items
2. Write from the USER's perspective: what they can DO or what WORKS BETTER now
3. Use plain English. No commit hashes, PR numbers, file names, or technical jargon
4. Maximum 8 bullet points
5. Write a short title (3-7 words) capturing the overall theme of the release
6. If there are NO user-facing changes at all, return {"title":null,"changes":[]}

Return ONLY valid JSON - no markdown, no explanation:
{"title":"...","changes":["...","..."]}
"@

$body = @{
    model           = $AI_MODEL
    messages        = @(
        @{ role = "system"; content = $systemPrompt }
        @{ role = "user";   content = "Commits:`n$commitList" }
    )
    response_format = @{ type = "json_object" }
    temperature     = 0.3
    max_tokens      = 700
} | ConvertTo-Json -Depth 5 -Compress

$headers = @{
    Authorization  = "Bearer $token"
    "Content-Type" = "application/json"
}

$attempt = 0
$backoff  = @(5, 15, 30)
$maxTries = 3

while ($attempt -lt $maxTries) {
    try {
        $resp    = Invoke-RestMethod -Uri $MODELS_URL -Method POST -Headers $headers -Body $body -TimeoutSec 30
        $content = $resp.choices[0].message.content.Trim()
        $parsed  = $content | ConvertFrom-Json

        if ($null -eq $parsed.title -or $parsed.changes.Count -eq 0) {
            Write-Host "  No user-facing changes found in pending commits." -ForegroundColor Yellow
        } else {
            Write-Host "  Draft release notes (next version)" -ForegroundColor Green
            Write-Host "  Title  : $($parsed.title)" -ForegroundColor White
            foreach ($c in $parsed.changes) {
                Write-Host "    * $c" -ForegroundColor DarkGray
            }
        }
        break
    } catch {
        $attempt++
        $status = $_.Exception.Response.StatusCode.value__
        if ($status -eq 401 -or $status -eq 403) {
            Write-Host "  API auth error ($status) - check GITHUB_TOKEN." -ForegroundColor Red
            break
        }
        if ($attempt -lt $maxTries) {
            $wait = $backoff[$attempt - 1]
            if ($status -eq 429) { $wait *= 2 }
            Write-Host "  API error (attempt $attempt) - retrying in ${wait}s..." -ForegroundColor Yellow
            Start-Sleep -Seconds $wait
        } else {
            Write-Host "  AI notes failed after $maxTries attempts." -ForegroundColor Yellow
        }
    }
}

Write-Host ""
