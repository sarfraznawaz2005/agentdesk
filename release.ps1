$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# ─── Configuration ─────────────────────────────────────────────────────────────
$MODELS_URL = "https://models.inference.ai.azure.com/chat/completions"
$AI_MODEL   = "gpt-4o-mini"

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

# ── Generate release notes via GitHub Models API ─────────────────────────────
Write-Host ""
Write-Host "Generating release notes..." -ForegroundColor Cyan

$notesPath  = Join-Path $ScriptDir "release-notes.json"
$skipNotes  = $false
$aiEntry    = $null

# Collect commits since the last tag (or all commits if no tag exists)
$lastTag = git describe --tags --abbrev=0 2>$null
$commitRange = if ($lastTag) { "$lastTag..HEAD" } else { "HEAD" }
$commits = @(git log $commitRange --pretty=format:"%s" 2>$null | Where-Object { $_ -ne "" })

if ($commits.Count -eq 0) {
    Write-Host "  No commits found since last tag — skipping AI notes." -ForegroundColor Yellow
    $skipNotes = $true
}

if (-not $skipNotes) {
    # Load GITHUB_TOKEN
    $token = $env:GITHUB_TOKEN
    if (-not $token) { $token = [Environment]::GetEnvironmentVariable("GITHUB_TOKEN", "User") }

    if (-not $token) {
        Write-Host "  GITHUB_TOKEN not set — skipping AI notes. Edit release-notes.json manually." -ForegroundColor Yellow
        $skipNotes = $true
    }
}

if (-not $skipNotes) {
    $rangeLabel = if ($lastTag) { "since $lastTag" } else { "all commits" }
    Write-Host "  $($commits.Count) commit(s) $rangeLabel → asking AI..." -ForegroundColor DarkGray

    $commitList = $commits -join "`n"

    $systemPrompt = @"
You are writing release notes for AgentDesk, an AI-powered desktop development platform used by software developers.

Given a list of git commit messages, produce a concise release notes entry for end users.

INCLUDE (user-facing):
- feat: / feature: — new features or capabilities
- fix: / bugfix: — bug fixes that affect users
- perf: — performance improvements users notice
- ui: / ux: — interface and experience improvements

DISCARD (dev-internal, never mention to users):
- chore:, ci:, build:, test:, refactor:, style:, revert: commits
- Dependency/package version bumps
- Dev scripts, tooling, CI configuration
- Release commits ("chore: release vX.Y.Z")
- Internal refactors with no user-visible effect

RULES:
1. Group related commits into a single bullet — do not repeat nearly-identical items
2. Write from the USER's perspective: what they can DO or what WORKS BETTER now
3. Use plain English. No commit hashes, PR numbers, file names, or technical jargon
4. Maximum 8 bullet points
5. Write a short title (3–7 words) capturing the overall theme of the release
6. If there are NO user-facing changes at all, return {"title":null,"changes":[]}

Return ONLY valid JSON — no markdown, no explanation:
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

    $attempt  = 0
    $backoff  = @(5, 15, 30)
    $maxTries = 3

    while ($attempt -lt $maxTries) {
        try {
            $resp    = Invoke-RestMethod -Uri $MODELS_URL -Method POST -Headers $headers -Body $body -TimeoutSec 30
            $content = $resp.choices[0].message.content.Trim()
            $parsed  = $content | ConvertFrom-Json

            if ($null -eq $parsed.title -or $parsed.changes.Count -eq 0) {
                Write-Host "  AI found no user-facing changes in these commits." -ForegroundColor Yellow
                $skipNotes = $true
            } else {
                $aiEntry = $parsed
            }
            break
        } catch {
            $attempt++
            $status = $_.Exception.Response.StatusCode.value__
            if ($status -eq 401 -or $status -eq 403) {
                Write-Host "  API auth error ($status) — check GITHUB_TOKEN. Skipping AI notes." -ForegroundColor Red
                $skipNotes = $true
                break
            }
            if ($attempt -lt $maxTries) {
                $wait = $backoff[$attempt - 1]
                if ($status -eq 429) { $wait *= 2 }
                Write-Host "  API error (attempt $attempt) — retrying in ${wait}s..." -ForegroundColor Yellow
                Start-Sleep -Seconds $wait
            } else {
                Write-Host "  AI notes failed after $maxTries attempts. Skipping. Edit release-notes.json manually." -ForegroundColor Yellow
                $skipNotes = $true
            }
        }
    }
}

if ($aiEntry) {
    # Show the draft
    Write-Host ""
    Write-Host "  Draft release notes for v$newVersion" -ForegroundColor Green
    Write-Host "  Title  : $($aiEntry.title)" -ForegroundColor White
    foreach ($c in $aiEntry.changes) {
        Write-Host "    • $c" -ForegroundColor DarkGray
    }
    Write-Host ""

    # Offer inline edit or accept
    $editChoice = Read-Host "  Open release-notes.json to review/edit before committing? (y/N)"

    # Build the new entry
    $newEntry = [PSCustomObject]@{
        version = $newVersion
        title   = $aiEntry.title
        changes = $aiEntry.changes
    }

    # Load existing notes, remove any stale entry for this version, prepend new one
    $existing = if (Test-Path $notesPath) {
        @(Get-Content $notesPath -Raw | ConvertFrom-Json | Where-Object { $_.version -ne $newVersion })
    } else { @() }

    $updated = @($newEntry) + $existing
    # ConvertTo-Json -Depth 5 produces pretty JSON; ensure UTF-8 without BOM
    $json = $updated | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($notesPath, $json, [System.Text.UTF8Encoding]::new($false))

    if ($editChoice -match '^[Yy]$') {
        $editor = if (Get-Command code -ErrorAction SilentlyContinue) { "code" }
                  elseif (Get-Command notepad++ -ErrorAction SilentlyContinue) { "notepad++" }
                  else { "notepad" }
        & $editor $notesPath
        Write-Host "  Edit and save, then press Enter to continue..." -ForegroundColor Yellow
        $null = Read-Host
    }

    Write-Host "  release-notes.json updated." -ForegroundColor Green
}

Write-Host ""

# ── Update version in package.json ──────────────────────────────────────────
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
git add package.json electrobun.config.ts release-notes.json
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

# ── Deploy web app to Cloudflare Pages ───────────────────────────────────────
# The DESKTOP app builds on GitHub Actions (triggered by the tag push above).
# The WEB app (Remote Access, https://agentdeskweb.pages.dev) is a SEPARATE
# Cloudflare Pages deploy and must be published from here so the hosted web
# version tracks this release. Non-fatal: the git release already succeeded, so
# a web build/deploy hiccup only warns (re-run the two bun commands manually).
Write-Host ""
$deployWeb = Read-Host "Build & deploy the web app to Cloudflare Pages? (Y/n)"
if ($deployWeb -notmatch '^[Nn]$') {
    Write-Host "Building web app (bun run build:web)..." -ForegroundColor Cyan
    bun run build:web
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Web build FAILED — skipping deploy. Run 'bun run build:web; bun run deploy:web' manually." -ForegroundColor Yellow
    } else {
        Write-Host "Deploying web app (bun run deploy:web)..." -ForegroundColor Cyan
        bun run deploy:web
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Web deploy FAILED (wrangler auth?). Run 'bun run deploy:web' manually." -ForegroundColor Yellow
        } else {
            Write-Host "  Web app live: https://agentdeskweb.pages.dev" -ForegroundColor Green
        }
    }
} else {
    Write-Host "  Skipped web deploy. Run 'bun run build:web; bun run deploy:web' later if the frontend changed." -ForegroundColor DarkGray
}

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Released v$newVersion!" -ForegroundColor Green
Write-Host ""
Write-Host "GitHub Actions build:  https://github.com/sarfraznawaz2005/agentdesk/actions" -ForegroundColor Cyan
Write-Host "Release page:          https://github.com/sarfraznawaz2005/agentdesk/releases/tag/v$newVersion" -ForegroundColor Cyan
Write-Host "Web app:               https://agentdeskweb.pages.dev" -ForegroundColor Cyan
Write-Host ""
