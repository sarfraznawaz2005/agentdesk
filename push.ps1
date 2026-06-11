# push.ps1
# Smart git commit & push using GitHub Models API for AI commit message generation.
# - Retries the API up to 3 times with exponential backoff (5s, 15s, 30s)
# - If all retries fail, aborts WITHOUT committing so you can re-run later
# - Validates the commit message matches conventional commit format before using it
# - Handles 401 (bad token), 429 (rate limit), and general network failures separately

# ─── Configuration ────────────────────────────────────────────────────────────
$MODELS_URL     = "https://models.inference.ai.azure.com/chat/completions"
$AI_MODEL       = "gpt-4o-mini"
$MAX_RETRIES    = 3
$BACKOFF_SEC    = @(5, 15, 30)      # wait seconds before retry 1, 2, 3
$MAX_DIFF_CHARS = 8000              # truncate large diffs to stay within token budget
$COMMIT_PATTERN = '^(feat|fix|docs|chore|refactor|test|perf|ci|build|style|revert)(\(.+\))?: .{3,97}$'

# ─── Output helpers ───────────────────────────────────────────────────────────
function Write-Section { param([string]$m); Write-Host; Write-Host "`e[30;46m $m `e[0m"; Write-Host }
function Write-Ok      { param([string]$m); Write-Host; Write-Host "`e[30;42m $m `e[0m"; Write-Host }
function Write-Warn    { param([string]$m); Write-Host; Write-Host "`e[30;43m $m `e[0m"; Write-Host }
function Write-Fail    { param([string]$m); Write-Host; Write-Host "`e[37;41m $m `e[0m"; Write-Host }

# ─── Repository sanity checks ─────────────────────────────────────────────────
Write-Section "Checking Repository..."
git rev-parse --git-dir 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "Not inside a git repository."; exit 1 }

$conflicts = git status --porcelain | Select-String "^UU"
if ($conflicts) { Write-Fail "Merge conflicts detected — resolve them first."; exit 1 }

git status -sb

# ─── GITHUB_TOKEN check ───────────────────────────────────────────────────────
if (-not $env:GITHUB_TOKEN) {
    Write-Fail "GITHUB_TOKEN is not set."
    Write-Host "  Set it in your session:  `$env:GITHUB_TOKEN = 'ghp_...'"
    Write-Host "  Or permanently via:       [Environment]::SetEnvironmentVariable('GITHUB_TOKEN','ghp_...','User')"
    Write-Host "  Get a token at:           https://github.com/settings/tokens (no special scopes needed for Models API)"
    exit 1
}

# ─── Branch & upstream ────────────────────────────────────────────────────────
$branch = git rev-parse --abbrev-ref HEAD
if ([string]::IsNullOrWhiteSpace($branch)) { Write-Fail "Cannot determine current branch."; exit 1 }

git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>&1 | Out-Null
$hasUpstream = $LASTEXITCODE -eq 0

if ($hasUpstream) {
    Write-Section "Pulling Remote Changes..."
    git pull
    if ($LASTEXITCODE -ne 0) { Write-Fail "git pull failed."; exit 1 }
}

# ─── Stage all changes ────────────────────────────────────────────────────────
git add . 2>$null | Out-Null

$stagedFiles = git diff --cached --name-only
if (-not $stagedFiles) {
    Write-Warn "Nothing staged — skipping commit."
}
else {

    # ─── Build prompt ─────────────────────────────────────────────────────────
    Write-Section "Generating Commit Message via GitHub Models ($AI_MODEL)..."

    $stats = git diff --cached --stat | Out-String
    $diff  = git diff --cached       | Out-String
    if ($diff.Length -gt $MAX_DIFF_CHARS) {
        $diff = $diff.Substring(0, $MAX_DIFF_CHARS) + "`n... (diff truncated at $MAX_DIFF_CHARS chars)"
    }

    $promptText = @"
Analyze the staged git changes below and write a single conventional commit message.

Staged file stats:
$stats

Diff:
$diff

Rules:
- Format: type: description
- type must be one of: feat, fix, docs, chore, refactor, test, perf, ci, build, style, revert
- description: lowercase, present tense, no period at end, max 80 characters
- Return ONLY the single commit message line — no explanation, no quotes, no XML tags, no preamble.
"@

    $requestBody = @{
        model       = $AI_MODEL
        messages    = @(@{ role = "user"; content = $promptText })
        max_tokens  = 80
        temperature = 0
    } | ConvertTo-Json -Depth 5

    # ─── API call with retry & backoff ────────────────────────────────────────
    $commitMsg = $null
    $attempt   = 0

    while ($attempt -le $MAX_RETRIES -and -not $commitMsg) {

        if ($attempt -gt 0) {
            $wait = $BACKOFF_SEC[$attempt - 1]
            Write-Warn "Attempt $attempt/$MAX_RETRIES failed — retrying in ${wait}s..."
            Start-Sleep -Seconds $wait
        }

        try {
            $response = Invoke-RestMethod `
                -Uri         $MODELS_URL `
                -Method      POST `
                -Headers     @{
                    "Authorization" = "Bearer $env:GITHUB_TOKEN"
                    "Content-Type"  = "application/json"
                } `
                -Body        $requestBody `
                -TimeoutSec  30 `
                -ErrorAction Stop

            $raw = $response.choices[0].message.content.Trim()

            # Direct match — ideal case
            if ($raw -match $COMMIT_PATTERN) {
                $commitMsg = $raw
                break
            }

            # Model sometimes wraps the message — scan all lines
            $found = ($raw -split "`n") |
                ForEach-Object { $_.Trim() } |
                Where-Object   { $_ -match $COMMIT_PATTERN } |
                Select-Object  -First 1

            if ($found) {
                $commitMsg = $found
                break
            }

            Write-Warn "AI returned unexpected format: '$($raw.Substring(0, [Math]::Min(80,$raw.Length)))' — retrying..."
        }
        catch {
            # Try to get HTTP status code (works for both PS5 WebException and PS7 HttpResponseException)
            $statusCode = $null
            try { $statusCode = $_.Exception.Response.StatusCode.value__ } catch {}

            switch ($statusCode) {
                401 {
                    Write-Fail "GITHUB_TOKEN is invalid or expired (401). Update it and re-run."
                    exit 1
                }
                403 {
                    Write-Fail "Access denied (403). Ensure your token has access to GitHub Models."
                    exit 1
                }
                429 {
                    # Rate limited — double the normal backoff
                    $wait = if ($attempt -lt $MAX_RETRIES) { $BACKOFF_SEC[$attempt] * 2 } else { 0 }
                    Write-Warn "Rate limited (429) — waiting ${wait}s before retry..."
                    if ($wait -gt 0) { Start-Sleep -Seconds $wait }
                }
                default {
                    $errMsg = $_.Exception.Message
                    Write-Warn "API error on attempt $($attempt + 1): $errMsg"
                }
            }
        }

        $attempt++
    }

    # ─── Abort if AI unavailable ──────────────────────────────────────────────
    if (-not $commitMsg) {
        Write-Fail "GitHub Models API unavailable after $MAX_RETRIES retries."
        Write-Host ""
        Write-Host "  Your files are staged (git add . already ran) — nothing is lost."
        Write-Host "  Re-run push.bat once the API is available and it will pick up from here."
        Write-Host ""
        exit 1
    }

    Write-Ok "Commit: $commitMsg"
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) { Write-Fail "git commit failed."; exit 1 }
}

# ─── Push ─────────────────────────────────────────────────────────────────────
$toPush = 0
if ($hasUpstream) {
    $toPush = [int](git rev-list --count "@{u}..HEAD" 2>$null)
} else {
    $toPush = [int](git rev-list --count HEAD 2>$null)
}

if ($toPush -eq 0) {
    Write-Warn "No commits to push."
}
else {
    Write-Section "Pushing $toPush commit(s) to origin/$branch..."
    if ($hasUpstream) {
        git push
    }
    else {
        git push -u origin $branch
    }
    if ($LASTEXITCODE -ne 0) { Write-Fail "git push failed."; exit 1 }
}

# ─── Final state ──────────────────────────────────────────────────────────────
$final = git status --porcelain
if ([string]::IsNullOrWhiteSpace($final)) {
    Write-Ok "CLEAN — All done!"
}
else {
    Write-Host ""
    Write-Host "  Note: some untracked/ignored files remain (not staged by this run)."
    Write-Ok "Done!"
}
