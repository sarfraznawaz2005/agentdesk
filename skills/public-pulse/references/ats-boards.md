# Public ATS Job Board Endpoints

Three providers cover most public company career pages. All three are plain, unauthenticated JSON GETs — no key, no account, no special headers. Call each via your `http_request` tool (works for read-only agents too). Try them in this order for a given company; each 404 just means "not this provider," not a failure.

The `curl` lines below are the equivalent request shown for readability — translate directly to an `http_request` call with that `url` and `method: "GET"`.

## 1. Greenhouse

```bash
curl -s "https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true"
```

- Confirmed live (tested against `stripe` — returned real postings).
- `content=true` includes the full job description HTML; omit it for a lighter listing.
- Response shape: `{"jobs":[{"id":..., "title":..., "location":{"name":...}, "absolute_url":..., "updated_at":..., "content": "..." }]}`.
- 404 with no body (or an HTML error page) = wrong slug or company isn't on Greenhouse.

## 2. Lever

```bash
curl -s "https://api.lever.co/v0/postings/<slug>?mode=json"
```

- Confirmed live (tested against `kraken` and the provider's own `lever` board — both returned `200` with a JSON array).
- **`[]` (empty array) is a valid, successful response** — it means the slug is real but there are currently no open postings. Do not treat it as a failure or retry.
- `{"ok":false,"error":"Document not found"}` with **404** means the slug is wrong or the company isn't on Lever — try the next provider.
- Response shape: array of `{"id":..., "text": "<title>", "categories": {"location":..., "team":..., "commitment":...}, "hostedUrl":..., "createdAt": <epoch_ms>}`.

## 3. Ashby

```bash
curl -s "https://api.ashbyhq.com/posting-api/job-board/<slug>"
```

- Confirmed live (tested against `ramp` — returned real postings).
- Response shape: `{"jobs":[{"id":..., "title":..., "department":..., "team":..., "location":..., "employmentType":..., ...}]}`.

## Resolving a company's slug

The slug is usually visible directly in the company's own public careers page URL:
- Greenhouse: `boards.greenhouse.io/<slug>` or a `job-boards.greenhouse.io/<slug>` embed
- Lever: `jobs.lever.co/<slug>`
- Ashby: `jobs.ashbyhq.com/<slug>`

If you don't have the careers-page URL, try the obvious slug guess (lowercase company name, no spaces/punctuation) against all three in order — Greenhouse, then Lever, then Ashby. Stop at the first 200 with actual content. If all three 404, the company likely uses a provider outside this skill's scope (e.g. Workday, iCIMS, a custom ATS) — say so rather than guessing further.
