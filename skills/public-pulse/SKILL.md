---
name: public-pulse
description: Research what people are actually saying/doing about a topic across Reddit, Hacker News, Polymarket, GitHub, YouTube, arXiv, and public job boards — no API keys, no accounts, no signup. Use for "what does the community think", tech-adoption checks, hiring-signal reads, or a quick 30-day pulse on a topic, person, project, or company.
argument-hint: 'public-pulse <topic> [--days N]'
homepage: https://github.com/mvanhorn/last30days-skill
---

# Public Pulse

Research a topic across free, keyless public sources and synthesize what real people, developers, markets, and job postings say about it. No API keys, no accounts, no signup — every source below is a plain HTTP GET.

This is a lighter-weight, no-credential sibling of tools like `/last30days` — same idea (search people, not editors), scoped to only the sources that genuinely require zero credentials.

## How to call these sources

**Use your `http_request` tool for every source except YouTube.** It's available to you whether you're a read-only agent (e.g. `research-expert`) or a write agent — this skill was deliberately built so read-only agents can run it in full. Pass `url`, `method: "GET"`, and `headers` as shown per source below.

**YouTube is the one exception** — it goes through the `yt-dlp` CLI via `run_shell`, which read-only agents do not have. If you are a read-only agent, skip the YouTube source silently (don't apologize for it or explain the architecture — just proceed without it) and mention in your final synthesis that YouTube wasn't checked. If you are a write agent (or the PM), YouTube works normally per its section below.

## When to use

- "What is r/reactjs saying about X" / "what's the community sentiment on Y"
- Evaluating a library/tool/framework before adoption (Reddit + HN + GitHub signal)
- A quick pulse on a person, project, product, or company's last N days
- Hiring-signal reads (is a company's open-roles pattern telling you something)
- Prediction-market odds on an event (Polymarket)

Do NOT use this for anything requiring X/Twitter, TikTok, Instagram, LinkedIn, Bluesky, or paid search APIs — none of those are covered here (they all require an account, browser-cookie extraction, or a paid key). If the user needs those, say so plainly instead of improvising a substitute.

## Default window

Default to the **last 30 days** unless the user names a different window (e.g. "last week", "last 7 days"). Every source below supports date filtering — apply it before you read results, not after; don't let an old viral post sneak into a "last 30 days" answer just because it ranked high.

## Sources

### 1. Reddit — real scores, no key (fragile: read the caveat)

The modern `reddit.com/*.json` API is **fully blocked** for non-browser clients (returns HTTP 403 with an HTML anti-bot page, verified live). The only path that works is the **`old.reddit.com` HTML interface**, and it needs a **full browser-like header set, not just `User-Agent`**.

**This matters more than it sounds:** `http_request` sends requests via `fetch()`, and Reddit's anti-bot layer 403s a `fetch()` call that only sets `User-Agent` — even though the identical URL/UA succeeds from `curl`. It is not IP- or account-based; it's header-completeness. Always send the **full set below**, every request, every source in this section — omitting any of them risks a 403 that has nothing to do with rate limiting.

**Required headers for every Reddit `http_request` call:**
```json
{
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1"
}
```

**Search** (gives title, subreddit, score, comment count, timestamp, and post id in one request) — call `http_request` with:
- `url`: `https://old.reddit.com/search?q=YOUR+QUERY&sort=relevance&t=month`
- `headers`: the full set above
- `maxChars`: `40000` — **required, not optional.** `old.reddit.com` pages carry ~20-24K characters of head/sidebar boilerplate before the first real result; `http_request`'s default 15,000-char cap cuts off before any post ever appears, which reads as a false "pass" (200 OK, but you never actually saw a post). 40,000 comfortably covers the preamble plus several results.

`t=` is Reddit's own window param: `day`, `week`, `month`, `year`, `all` — pick the closest to the requested window, then still date-filter client-side since Reddit's own buckets are coarse.

Use `http_request`, not `web_fetch`, for Reddit specifically — `web_fetch` strips HTML to plain text, which discards the `href`/`data-fullname` attributes this recipe parses for permalinks and post IDs.

If you ever get a 403 with the full header set (not just a bare `User-Agent`), that's a genuine Reddit-side change, not a missing header — follow the "Known limitations" guidance below and drop Reddit for the run.

Parse from the returned HTML body (regex/string-matching is fine, this is intentionally simple markup, not JSON):
- Post id + permalink: `data-fullname="t3_<id>"` and the sibling `href="/r/<subreddit>/comments/<id>/<slug>/"`
- Title: the `<a ... class="search-title may-blank" ...>TITLE</a>` whose `href` contains `/comments/` (the same class name also appears on unrelated subreddit-recommendation cards in the sidebar — only trust it when the href has `/comments/` in it)
- Score: `class="search-score ...">N points`
- Comment count: `class="search-comments ...">N comments`
- Timestamp: `<time ... datetime="2026-06-15T13:10:30+00:00" ...>`

**Thread enrichment** (real per-comment scores + authors, for pulling top quotes) — same `http_request` pattern, `url`: `https://old.reddit.com/r/SUBREDDIT/comments/POST_ID/`, same full header set as above, same `maxChars: 40000`.

Parse: `class="score" title="N">N` (per-comment score), `class="author ...">USERNAME`, and comment body inside `<div class="md"><p>...`.

**Rate limits (tested live):** Reddit 429s aggressively on quick bursts. Space out Reddit calls — don't fire a search and several thread-enrichment calls back-to-back with nothing in between. A search + 2-3 thread enrichments for one topic is fine; don't fan out to 10+ threads in one run. On a 429, do other useful work (another source, reading a prior result) before retrying once; if it 429s again, drop Reddit for this run and say so rather than looping on retries.

### 2. Hacker News — official Algolia API, stable

`http_request`, `url`: `https://hn.algolia.com/api/v1/search_by_date?query=YOUR+QUERY&tags=story&numericFilters=created_at_i%3E<unix_timestamp_30_days_ago>` (no special headers needed).

- Use `search_by_date` for recency, or plain `search` for relevance-ranked (then filter/sort by `points` yourself).
- Must be `https://` — the bare `http://` host 301-redirects.
- JSON fields per hit: `title`, `url`, `points`, `num_comments`, `author`, `created_at`, `objectID` (use `https://news.ycombinator.com/item?id=<objectID>` for the discussion link).
- No rate limit issues observed.

### 3. Polymarket — official public API, stable

`http_request`, `url`: `https://gamma-api.polymarket.com/public-search?q=YOUR+QUERY&limit_per_type=10` (no special headers needed).

- Real keyword search (better than paginating `/markets` or `/events` and filtering client-side).
- Response has `events[]`, each with nested `markets[]` — read `question`/`title`, outcome prices (odds), `volume`/`liquidity`, `endDate`.
- No key, no rate-limit issues observed.

### 4. GitHub — official Search API, unauthenticated (topic mode only)

`http_request`, `headers`: `{"Accept": "application/vnd.github+json"}`
- Issues/PRs: `url`: `https://api.github.com/search/issues?q=%22YOUR+PHRASE%22&sort=reactions&order=desc&per_page=10`
- Repositories: `url`: `https://api.github.com/search/repositories?q=YOUR+QUERY&sort=updated&order=desc&per_page=10`

- **Topic search only** — this skill does not do person/org PR-velocity mode; if the user wants that, say it's out of scope for this skill.
- Quote multi-word phrases (`%22...%22`) or GitHub's search treats bare space-separated words as OR, not AND — confirmed live (an unquoted 2-word query returned 10M+ "hits").
- Add `created:>YYYY-MM-DD` to `q=` to enforce the date window server-side.
- **Unauthenticated rate limit is 10 requests/minute** (confirmed via `X-RateLimit-Limit` response header) — don't issue more than a couple of search calls per topic.

### 5. YouTube — via `yt-dlp`, write agents only, skip cleanly if missing

Requires `run_shell` — **only available to write-capable agents (PM or a non-read-only agent), not `research-expert`/`code-explorer`/`task-planner`.** If you're read-only, skip this source with no explanation needed; if you're write-capable, check availability first so a missing binary doesn't fail the whole skill:

```bash
command -v yt-dlp   # macOS/Linux
where yt-dlp         # Windows
```

If not found: skip YouTube entirely and say so in one line in your final synthesis (e.g. "YouTube skipped — yt-dlp not installed"). Do not ask the user to install it unless they ask why YouTube is missing.

If found, search with real engagement numbers (slower — one request per video, so keep counts modest):

```bash
yt-dlp "ytsearch10:YOUR QUERY" --dump-json --skip-download --no-warnings
```

Each line of stdout is one JSON object: `title`, `upload_date` (YYYYMMDD), `view_count`, `like_count`, `comment_count`, `channel`, `webpage_url`, `description`. Filter to the date window using `upload_date`.

For a faster but engagement-blind listing (id/title/url only, no view/like counts), add `--flat-playlist` — use this only when the topic needs broad coverage and per-video metrics aren't essential.

### 6. arXiv — official public API, stable

`http_request`, `url`: `https://export.arxiv.org/api/query?search_query=all:%22YOUR+PHRASE%22&sortBy=submittedDate&sortOrder=descending&max_results=10` (no special headers needed; the tool follows redirects automatically).

- **Quote multi-word phrases** (`%22...%22`) — confirmed live that unquoted space-separated terms are OR'd together (2-word bare query returned 228K+ "hits" instead of a targeted set).
- Response is Atom XML: `<entry>` has `<title>`, `<summary>`, `<published>`, `<author><name>`, `<link href="...">`.
- Fires on research/technical topics; stay quiet (don't force a result) on topics with no plausible academic angle.

### 7. Jobs / careers pages — public ATS boards, no key

See `references/ats-boards.md` for the exact Greenhouse / Lever / Ashby endpoint patterns (all via `http_request`, no special headers), how to resolve a company's board slug, and the important caveat that an empty `[]` is a **valid "no open postings" response**, not a failure — only a 404 means "wrong slug / not on this provider."

Use for `--hiring-signals`-style asks: read open roles as evidence of focus/priority shifts, never as an exact roadmap prediction.

## Synthesis rules

1. **Date-filter first.** Drop anything outside the requested window before you rank or quote it.
2. **Rank by real engagement**, not by search-result order: Reddit score + comments, HN points, GitHub reactions/stars, Polymarket volume/liquidity, YouTube views/likes when fetched.
3. **Cite concretely** — title, source, and link for every claim you make. Never present a synthesized takeaway without a traceable source underneath it.
4. **Say what you skipped.** If YouTube was skipped (read-only agent, or no `yt-dlp`), if Reddit got rate-limited mid-run, or if a source returned nothing relevant, say so in one line — don't silently omit it and don't pad the gap with speculation.
5. **Don't fabricate engagement numbers.** If you only ran the flat/fast YouTube listing, you don't have view counts — say "found, engagement not fetched," don't guess a number.

## Known limitations (verified live, 2026-07-12)

- **Reddit**: the classic `.json` API is dead for non-browser clients (403 on every variant tested: `www.reddit.com`, `old.reddit.com`, with and without custom headers). Only the HTML pages work.
- **Reddit + `http_request` needs the full header set, not just `User-Agent`.** Confirmed live: an AgentDesk `http_request` call (which runs on `fetch()`) with only `User-Agent` gets 403'd on `old.reddit.com`, on the *same* URL/UA that `curl` succeeds on — `curl` fills in enough default headers implicitly that this doesn't show up there. Always send the full header block documented in the Reddit section above. If a request with that full set still 403s, that's a genuine Reddit-side change — treat Reddit as unavailable for the run rather than guessing at a further workaround.
- **Reddit + `http_request`'s default truncation.** A production validation run confirmed the header fix (200 OK, no 403) but then silently failed to read any actual post — `old.reddit.com` pages carry ~20-24K characters of boilerplate before the first result, past `http_request`'s default 15,000-char cap. `maxChars: 40000` (documented in the Reddit section above) fixes this — a 200 status alone does not mean the request actually reached real content, always check that `maxChars` was set.
- **Reddit rate limits**: bursts of requests within a few seconds reliably 429. Pace deliberately.
- **GitHub**: 10 req/min unauthenticated — plan your queries, don't retry-loop into the cap.
- **arXiv / GitHub**: both silently OR unquoted multi-word queries — always quote phrases.
- **Lever**: `[]` is a normal empty response, not an error; a 404 means the slug/provider guess was wrong.
- **YouTube requires shell**: unlike the other six sources, this one cannot run under a read-only agent — that's an AgentDesk tool-permission boundary (`run_shell` is a write tool), not a limitation of yt-dlp itself.
