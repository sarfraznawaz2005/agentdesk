# Freelance Feature — Implementation Plan

> ⚠️ **STATUS: IMPLEMENTED, with divergence — treat as the original v1 design, not current reality.**
> The feature shipped, but the integration approach changed: it is **Freelancer.com only, sourced via
> RSS** (`src/bun/freelance/rss-fetcher.ts`) — NOT Upwork, and NOT the official platform APIs described
> below. "Upwork" survives only as a vestigial label. Discovery/shortlist/per-listing chat are live; the
> act layer (inbox sync, bidding, replies) is the **Auto-Earn** engine (`docs/auto-earn-plan.md`).
> Current source of truth: `project-wiki/subsystems/freelance-autoearn.md`.

## 1. Overview

The Freelance feature turns AgentDesk into a freelance project pipeline. It
connects to Upwork and Freelancer.com via their official APIs, polls for
projects matching the user's configured keywords and budget filters, and
presents them in a dedicated UI page. The user approves or dismisses each
listing. Approving a project automatically creates an AgentDesk project and
triggers the existing PM → Task Planner flow so a plan is ready for human
review. Bidding is handled by opening the platform URL in the system browser
where the user is assumed to be logged in.

**Motto alignment:** this is a 99% agent-driven feature. The human's only
actions are approving/dismissing fetched listings and approving the resulting
agent-generated plan — exactly what AgentDesk is designed for.

---

## 2. Why This Feature

The client is a Pakistani freelancer who wants to eliminate the manual work of
browsing multiple platforms, reading project descriptions, and deciding whether
to pursue a job. AgentDesk is already capable of project planning and code
generation once a project exists. This feature closes the gap between "finding
a job" and "delivering a project" by automating discovery and plan generation,
leaving only final human judgment for bid submission.

---

## 3. Scope Decisions & Rationale

### Platforms: Upwork + Freelancer.com only (v1)

| Platform | Direct Bank Transfer (Pakistan) | Official API | Decision |
|---|---|---|---|
| **Upwork** | ✅ Direct PKR, $0.99/withdrawal | ✅ GraphQL API | **Included** |
| **Freelancer.com** | ✅ Express Withdrawal (free, direct to Pakistani banks) | ✅ REST API | **Included** |
| PeoplePerHour | ❌ Payoneer/wire only | RSS only | Excluded v1 |
| Guru.com | ✅ $1 fee | RSS only (unverified) | Excluded v1 |
| Fiverr | ❌ Payoneer gateway only | ❌ No API | Excluded |

Upwork and Freelancer.com are the only two platforms that satisfy both
criteria: direct bank transfer support for Pakistan AND a legitimate
documented public API for project listing. No scraping is required, which
means no bot-detection risk, no camoufox-js, no residential proxies.

### Data access: official APIs only

No scraping. Using official OAuth-protected REST/GraphQL APIs eliminates
bot-detection risk, ToS violations, and maintenance burden of keeping scrapers
working against UI changes.

### Bidding: system browser only

Upwork's API is read-only (no proposal submission endpoint by design).
Freelancer.com's API does support bidding but that would require storing
credentials and managing bid text within AgentDesk — adding significant
complexity. For v1, all bidding is done by opening the project URL in the
system browser where the user is already logged in.

### Auto-bidding via AI (future): the PM agent can be enhanced later to
draft a bid message and display it for copy-paste before opening the browser.

---

## 4. Feature Activation (File Flag)

The Freelance feature is hidden by default and activated by the presence of a
file named `freelance` (no extension) in the same directory as the app
executable.

### Detection logic

```ts
// src/bun/freelance/feature-flag.ts
import { existsSync } from "fs";
import { dirname } from "path";

export function isFreelanceEnabled(): boolean {
  const appDir = dirname(process.execPath);
  return existsSync(`${appDir}/freelance`);
}
```

**Dev mode caveat:** `process.execPath` points to the Bun runtime binary
during development, not the project folder. The flag check must also fall back
to `process.cwd()` when the app is not bundled:

```ts
export function isFreelanceEnabled(): boolean {
  const candidates = [
    dirname(process.execPath),
    process.cwd(),
  ];
  return candidates.some(dir => existsSync(`${dir}/freelance`));
}
```

### Startup integration

In `src/bun/index.ts`, call `isFreelanceEnabled()` early in the startup
sequence (after DB init, before cron). Store the result in a module-level
export so RPC handlers and the cron scheduler can read it without re-checking
the filesystem on every request.

```ts
// src/bun/index.ts (add after seedDatabase())
import { isFreelanceEnabled } from "./freelance/feature-flag";
export const FREELANCE_ENABLED = isFreelanceEnabled();
```

### Frontend integration

The flag value is sent to the frontend via a new RPC method
`freelance.getFeatureEnabled` that returns `{ enabled: boolean }`. The
sidebar reads this once on mount and conditionally adds the nav item. This
avoids baking a file-system check into the frontend.

---

## 5. Platform API Reference

### 5.1 Upwork GraphQL API

- **Base URL:** `https://api.upwork.com/graphql`
- **Auth:** OAuth 2.0 Authorization Code (RFC 6749)
- **Developer portal:** https://www.upwork.com/developer
- **App registration:** user registers at the portal, gets Client ID + Secret
- **Scopes needed:** `jobs:read` (job search and detail)
- **Key query:** `searchJobs` — accepts keywords, budget range, job type,
  category, skills; returns `title`, `description`, `budget`, `skills`,
  `clientCountry`, `url`, `postedOn`, `jobType` (fixed/hourly)
- **Rate limits:** 100 req/min per OAuth token
- **Token refresh:** access tokens expire in 24h; refresh token is long-lived

**Example GraphQL query for job search:**
```graphql
query SearchJobs($query: String!, $budgetMin: Int, $budgetMax: Int) {
  searchJobs(
    input: {
      q: $query
      budget: { min: $budgetMin, max: $budgetMax }
      paging: { offset: 0, count: 50 }
    }
  ) {
    results {
      id
      title
      description
      skills { name }
      budget { type min max }
      postedOn
      url
    }
  }
}
```

### 5.2 Freelancer.com REST API

- **Base URL:** `https://www.freelancer.com/api`
- **Auth:** OAuth 2.0 Authorization Code
- **Developer portal:** https://developers.freelancer.com
- **App registration:** user registers at the portal, gets Client ID + Secret
- **Key endpoint:** `GET /projects/0.1/projects/active/` — search active
  projects by skills/keywords, returns `title`, `description`, `budget`,
  `jobs` (skills), `type` (fixed/hourly), `submitdate`, `seoUrl`
- **Rate limits:** Documented per-endpoint; generous for read operations
- **Token refresh:** OAuth refresh token flow; access tokens expire in 1h

**Example endpoint:**
```
GET /api/projects/0.1/projects/active/?
  query=react+typescript&
  min_avg_price=100&
  max_avg_price=5000&
  project_types[]=fixed&
  job_details=true&
  full_description=true&
  limit=50&
  offset=0
```

---

## 6. OAuth Flow for Desktop Apps (RFC 8252)

Both platforms use standard OAuth 2.0 Authorization Code flow. For a desktop
app, the redirect URI uses a temporary localhost server:

### Flow steps

1. User clicks "Connect" in Freelance settings for a platform
2. Backend starts a one-shot HTTP server on `localhost:37911` (or next free
   port if occupied)
3. Backend constructs the authorization URL:
   `https://www.upwork.com/ab/account-security/oauth2/authorize?client_id=...&redirect_uri=http://localhost:37911/callback&response_type=code&scope=jobs:read`
4. Backend sends the URL to the frontend via RPC response
5. Frontend calls `window.open(url)` to open the system browser
6. User authorizes; platform redirects to `localhost:37911/callback?code=...`
7. Backend's temporary server captures `code`, closes itself, exchanges code
   for access + refresh tokens, saves tokens to `settings` table (encrypted)
8. Backend sends `freelance.authComplete` broadcast to frontend so the UI
   updates to show "Connected"

### Token storage

Tokens stored in `settings` table under these keys (category `"freelance"`):

| Key | Value |
|---|---|
| `freelance_upwork_client_id` | string |
| `freelance_upwork_client_secret` | string |
| `freelance_upwork_access_token` | string (JSON-encoded) |
| `freelance_upwork_refresh_token` | string |
| `freelance_upwork_token_expires_at` | ISO date string |
| `freelance_freelancer_client_id` | string |
| `freelance_freelancer_client_secret` | string |
| `freelance_freelancer_access_token` | string |
| `freelance_freelancer_refresh_token` | string |
| `freelance_freelancer_token_expires_at` | ISO date string |

Token refresh is handled transparently in the API client before each request:
if `token_expires_at` is within 5 minutes of expiry, refresh first.

---

## 7. User-Configurable Settings

All stored in the `settings` table under category `"freelance"`:

| Setting Key | Type | Default | Description |
|---|---|---|---|
| `freelance_enabled_platforms` | JSON string[] | `[]` | Which platforms are active, e.g. `["upwork","freelancer"]` |
| `freelance_keywords` | JSON string[] | `[]` | Keywords to search for, e.g. `["React","TypeScript","Node.js"]` |
| `freelance_budget_min` | JSON number | `0` | Minimum budget in USD |
| `freelance_budget_max` | JSON number | `10000` | Maximum budget in USD |
| `freelance_project_type` | JSON string | `"both"` | `"fixed"`, `"hourly"`, or `"both"` |
| `freelance_polling_interval` | JSON number | `6` | Hours between automatic fetches |

These settings are managed through the Freelance Settings UI (sub-section of
the Freelance page) and read by the polling service and API clients.

---

## 8. Database Schema

### 8.1 New table: `freelance_listings`

Add to `src/bun/db/schema.ts`:

```ts
export const freelanceListings = sqliteTable("freelance_listings", {
  id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  platform:    text("platform").notNull(),         // "upwork" | "freelancer"
  externalId:  text("external_id").notNull(),      // platform's own job ID
  title:       text("title").notNull(),
  description: text("description").notNull(),
  skills:      text("skills").notNull(),           // JSON string[]
  budgetType:  text("budget_type").notNull(),      // "fixed" | "hourly"
  budgetMin:   integer("budget_min"),              // USD cents or null
  budgetMax:   integer("budget_max"),              // USD cents or null
  currency:    text("currency").notNull().default("USD"),
  url:         text("url").notNull(),
  postedAt:    text("posted_at"),                  // ISO string from platform
  status:      text("status").notNull().default("new"), // "new" | "approved" | "dismissed"
  projectId:   text("project_id").references(() => projects.id), // set on approval
  fetchedAt:   text("fetched_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt:   text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt:   text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

**Uniqueness:** `(platform, externalId)` must be unique — prevents duplicate
listings across polling runs. Enforced via migration SQL (`UNIQUE` constraint)
and upsert logic in the fetch handler.

### 8.2 Migration: `v12_freelance-listings.ts`

```ts
import { sqlite } from "../connection";

export const name = "freelance-listings";

export function run(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS freelance_listings (
      id           TEXT PRIMARY KEY,
      platform     TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL,
      skills       TEXT NOT NULL DEFAULT '[]',
      budget_type  TEXT NOT NULL DEFAULT 'fixed',
      budget_min   INTEGER,
      budget_max   INTEGER,
      currency     TEXT NOT NULL DEFAULT 'USD',
      url          TEXT NOT NULL,
      posted_at    TEXT,
      status       TEXT NOT NULL DEFAULT 'new',
      project_id   TEXT REFERENCES projects(id),
      fetched_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_freelance_listings_platform_external
      ON freelance_listings(platform, external_id);

    CREATE INDEX IF NOT EXISTS
      idx_freelance_listings_status
      ON freelance_listings(status);
  `);
}
```

---

## 9. Backend Architecture

### 9.1 File structure (new files)

```
src/bun/freelance/
├── feature-flag.ts       # isFreelanceEnabled() — checks for 'freelance' file
├── settings.ts           # Read/write helpers for freelance_* settings keys
├── oauth.ts              # OAuth flow (localhost callback server, token refresh)
├── upwork-client.ts      # Upwork GraphQL API client
├── freelancer-client.ts  # Freelancer.com REST API client
├── fetcher.ts            # Orchestrates fetching from enabled platforms, deduplication
└── normalizer.ts         # Maps platform-specific responses to FreelanceListing shape

src/bun/rpc/freelance.ts  # All freelance RPC handlers
src/shared/rpc/freelance.ts  # RPC contract types
```

### 9.2 `fetcher.ts` — Core polling logic

```
fetchAllPlatforms()
  ├── read settings (enabled platforms, keywords, budget, type)
  ├── for each enabled platform with valid tokens:
  │   ├── call platform client → raw results
  │   ├── normalizer.normalize() → FreelanceListing[]
  │   └── upsert into DB (INSERT OR IGNORE on platform+externalId)
  └── broadcast "freelance.listingsUpdated" to frontend
```

The upsert uses `INSERT OR IGNORE` — existing listings (already approved or
dismissed) are never overwritten. Only truly new listings are inserted.

### 9.3 `upwork-client.ts`

- `searchJobs(params: SearchParams): Promise<RawUpworkJob[]>`
- Internally: check token expiry → refresh if needed → POST to GraphQL endpoint
- Maps keywords + budget + type to the `searchJobs` query variables
- Handles pagination: fetches up to 3 pages (150 jobs max) per poll run

### 9.4 `freelancer-client.ts`

- `searchProjects(params: SearchParams): Promise<RawFreelancerProject[]>`
- Internally: check token expiry → refresh if needed → GET `/projects/0.1/projects/active/`
- Handles pagination via `offset` parameter; fetches up to 3 pages (150 jobs max)

### 9.5 `normalizer.ts`

Converts platform-specific shapes into a common `FreelanceListing` interface:

```ts
interface FreelanceListing {
  platform: "upwork" | "freelancer";
  externalId: string;
  title: string;
  description: string;
  skills: string[];
  budgetType: "fixed" | "hourly";
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string;
  url: string;
  postedAt: string | null;
}
```

### 9.6 Polling integration

The poller is not a DB-persisted cron job (that would require users to manage
it via the scheduler UI). Instead it is an **in-process interval** started
by `src/bun/index.ts` at startup if `FREELANCE_ENABLED` is true:

```ts
// src/bun/index.ts
if (FREELANCE_ENABLED) {
  import("./freelance/fetcher").then(({ startFreelancePoller }) => {
    startFreelancePoller();
  });
}
```

`startFreelancePoller()` in `fetcher.ts`:
1. Reads `freelance_polling_interval` from settings (default 6h)
2. Runs `fetchAllPlatforms()` immediately on startup
3. Schedules subsequent runs using `setInterval` with the configured interval
4. The interval is re-read from settings before each run so changes take effect
   on the next tick without needing a restart

### 9.7 RPC handlers (`src/bun/rpc/freelance.ts`)

| RPC Method | Purpose |
|---|---|
| `freelance.getFeatureEnabled` | Returns `{ enabled: boolean }` — read feature flag |
| `freelance.getSettings` | Returns all freelance settings as a typed object |
| `freelance.saveSettings` | Saves settings (keywords, budget, type, interval, platforms) |
| `freelance.getCredentials` | Returns OAuth connection status per platform (never returns raw tokens) |
| `freelance.saveCredentials` | Saves client ID + secret for a platform |
| `freelance.initiateOAuth` | Starts localhost server, returns authorization URL to open |
| `freelance.getListings` | Returns listings from DB (paginated, filtered by status) |
| `freelance.approveListing` | Sets status="approved", creates AgentDesk project, returns projectId |
| `freelance.dismissListing` | Sets status="dismissed" |
| `freelance.triggerFetch` | Manual "Fetch Now" — calls fetchAllPlatforms() immediately |

---

## 10. Approve Listing → Create Project Flow

When `freelance.approveListing(listingId)` is called:

1. Load the listing from DB
2. Call the existing `createProject` DB logic (same as `projects.createProject`
   RPC) with:
   - `name`: listing title
   - `description`: listing description
   - `path`: user's global workspace path (from settings `global_workspace_path`)
     + `/` + slugified title
3. Mark listing `status = "approved"`, set `projectId` to the new project ID
4. Craft an initial PM message containing the full project description, budget,
   skills required, and a note that this is a freelance project from the
   platform
5. Insert this message into the new project's conversation as the first user
   message (same pattern as kanban task description injection)
6. Start the AgentEngine for this project — the PM will read the message,
   call `run_agent("task-planner", ...)`, the task planner will call
   `define_tasks(...)`, and then `request_plan_approval` will surface the plan
   card to the user
7. Return `{ projectId }` to the frontend, which navigates to `/project/{projectId}`

**No new code needed for the planning step** — the existing PM → task planner
flow handles it entirely. We only need to create the project and inject the
first message.

### Initial PM message template

```
You have been assigned a new freelance project fetched from {platform}.

**Project:** {title}
**Budget:** {budgetType === "fixed" ? `$${budgetMin}–$${budgetMax} fixed` : `$${budgetMin}–$${budgetMax}/hr`}
**Skills Required:** {skills.join(", ")}
**Platform URL:** {url}

**Project Description:**
{description}

Please create a plan for delivering this project. Use the task planner to
define all tasks needed to complete this work.
```

---

## 11. Frontend Architecture

### 11.1 Sidebar nav item

In `src/mainview/components/layout/sidebar.tsx`:

- Import `Briefcase` from `lucide-react`
- On mount, call `rpc.freelance.getFeatureEnabled()` — store result in
  component state
- Conditionally inject `{ label: "Freelance", icon: Briefcase, href: "/freelance" }`
  into `BASE_NAV_ITEMS` just before the Settings entry

### 11.2 Route

In `src/mainview/router.tsx`:

```ts
import { FreelancePage } from "./pages/freelance";
const freelanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/freelance",
  component: FreelancePage,
});
// Add to routeTree.addChildren([...])
```

### 11.3 Page layout: `src/mainview/pages/freelance.tsx`

Two-tab layout:

```
/freelance
├── Tab: Listings       ← default active tab
└── Tab: Settings
```

### 11.4 Listings tab

```
[ Fetch Now button ]  [ Status filter: All | New | Approved | Dismissed ]

┌─────────────────────────────────────────────┐
│ [Upwork badge]  React Developer for SaaS MVP │
│ $500–$2,000 · Fixed Price · Posted 2h ago   │
│                                               │
│ We need a React + TypeScript developer to... │
│ (truncated at 200 chars)                      │
│                                               │
│ Skills: React  TypeScript  Tailwind           │
│                                               │
│ [Approve →]  [Dismiss]  [View on Platform ↗] │
└─────────────────────────────────────────────┘
... more cards ...
```

**Card component:** `FreelanceListingCard`
- Platform badge: colored chip (orange = Upwork, blue = Freelancer.com)
- Budget rendered as: `$500–$2,000 · Fixed` or `$25–$50/hr · Hourly`
- Description truncated to 200 chars with "Show more" toggle
- Skills as small pills
- **Approve** button: calls `rpc.freelance.approveListing(id)`, on success
  navigates to `/project/{projectId}` via TanStack Router `useNavigate()`
- **Dismiss** button: calls `rpc.freelance.dismissListing(id)`, removes card
  from the "New" view
- **View on Platform** button: calls
  `window.open(listing.url, "_blank")` — opens in system browser

**Empty state:** "No new listings. Click Fetch Now or wait for the next
scheduled fetch."

**Loading state:** skeleton cards while fetching.

**"Fetch Now" button:** calls `rpc.freelance.triggerFetch()`, shows spinner
on button, re-fetches listings list when `freelance.listingsUpdated` broadcast
is received.

**Real-time updates:** Listen for `freelance.listingsUpdated` DOM event
(broadcast from backend via `broadcastToWebview`) to refresh the listing
count in the sidebar badge and re-fetch the list.

### 11.5 Settings tab

Two sections:

**Platforms section**
- Toggle switches: "Upwork" (on/off), "Freelancer.com" (on/off)
- Per-platform, when toggled on: show connection status
  - If not connected: show "Connect" button with link to developer portal
    (with brief instructions: "Register your app at [portal link] to get your
    Client ID and Secret")
  - Client ID and Client Secret input fields
  - "Authorize with [Platform]" button → calls `rpc.freelance.initiateOAuth(platform)`
    → backend returns auth URL → frontend calls `window.open(url)` → after
    OAuth completes, backend broadcasts `freelance.authComplete` event →
    frontend shows "Connected ✓"
  - If connected: show "Connected ✓" + "Disconnect" button

**Filters section**
- Keywords: tag input (type + Enter to add keyword chips; click × to remove)
- Budget range: two number inputs (Min USD, Max USD)
- Project type: radio buttons — Fixed Price / Hourly / Both
- Polling interval: number input + "hours" label (min 1, max 168)
- Save button

### 11.6 New component files

```
src/mainview/pages/freelance.tsx                # Page root + tab switcher
src/mainview/components/freelance/
├── listing-card.tsx                             # FreelanceListingCard
├── listings-tab.tsx                             # Listings tab content
├── settings-tab.tsx                             # Settings tab content
├── platform-connect.tsx                         # OAuth connect UI per platform
└── keyword-input.tsx                            # Tag-style keyword input
```

---

## 12. RPC Contract (`src/shared/rpc/freelance.ts`)

```ts
export type FreelanceRequests = {
  "freelance.getFeatureEnabled": {
    params: Record<string, never>;
    response: { enabled: boolean };
  };
  "freelance.getSettings": {
    params: Record<string, never>;
    response: {
      enabledPlatforms: string[];
      keywords: string[];
      budgetMin: number;
      budgetMax: number;
      projectType: "fixed" | "hourly" | "both";
      pollingInterval: number;
    };
  };
  "freelance.saveSettings": {
    params: {
      enabledPlatforms: string[];
      keywords: string[];
      budgetMin: number;
      budgetMax: number;
      projectType: "fixed" | "hourly" | "both";
      pollingInterval: number;
    };
    response: { success: boolean };
  };
  "freelance.getCredentials": {
    params: Record<string, never>;
    response: {
      upwork: { connected: boolean; clientId: string };
      freelancer: { connected: boolean; clientId: string };
    };
  };
  "freelance.saveCredentials": {
    params: {
      platform: "upwork" | "freelancer";
      clientId: string;
      clientSecret: string;
    };
    response: { success: boolean };
  };
  "freelance.initiateOAuth": {
    params: { platform: "upwork" | "freelancer" };
    response: { authUrl: string };
  };
  "freelance.getListings": {
    params: { status?: "new" | "approved" | "dismissed"; page?: number };
    response: {
      listings: FreelanceListingDto[];
      total: number;
      page: number;
    };
  };
  "freelance.approveListing": {
    params: { listingId: string };
    response: { projectId: string };
  };
  "freelance.dismissListing": {
    params: { listingId: string };
    response: { success: boolean };
  };
  "freelance.triggerFetch": {
    params: Record<string, never>;
    response: { success: boolean };
  };
};

export interface FreelanceListingDto {
  id: string;
  platform: "upwork" | "freelancer";
  title: string;
  description: string;
  skills: string[];
  budgetType: "fixed" | "hourly";
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string;
  url: string;
  postedAt: string | null;
  status: "new" | "approved" | "dismissed";
  projectId: string | null;
  fetchedAt: string;
}
```

Add `"freelance.listingsUpdated"` to `src/shared/rpc/webview.ts` (the
server-push events schema) so the frontend can subscribe to it.

---

## 13. `src/shared/rpc/index.ts` Changes

```ts
import type { FreelanceRequests } from "./freelance";
// Add to BunRequests intersection:
// & FreelanceRequests
// Add to exports:
export type { FreelanceRequests, FreelanceListingDto } from "./freelance";
```

---

## 14. Error Handling & Edge Cases

| Scenario | Handling |
|---|---|
| Feature flag file absent | Freelance route returns 404; sidebar item not shown |
| Platform not connected | `getListings` returns empty; settings tab shows "Connect" CTA |
| API token expired | `oauth.ts` refreshes transparently before each request |
| OAuth callback timeout (user closes browser) | localhost server times out after 5 min, RPC returns error, frontend shows toast |
| Duplicate listings across polls | `INSERT OR IGNORE` on `(platform, external_id)` unique index |
| Fetch fails (network error, rate limit) | Log error, emit toast via `broadcastToWebview("toast", {...})`, do not crash poller |
| User approves listing, project creation fails | DB transaction rollback, listing status stays "new", return error to frontend |
| Polling interval changed in settings | Takes effect on next poll tick (interval re-read each time) |
| Both platforms disabled in settings | Poller skips all fetching, no API calls made |
| Keywords list empty | Do not fetch (require at least one keyword) — show warning in settings |

---

## 15. Security Considerations

- **Client secrets** are stored in the `settings` table as plain text (same
  as API keys for AI providers in this app). For v1 this is consistent with
  existing practice; encryption at rest is a future hardening task.
- **Tokens** (access + refresh) stored the same way — consistent with how AI
  provider keys are handled.
- **OAuth localhost server** is bound to `127.0.0.1` only, not `0.0.0.0`,
  preventing remote exploitation of the callback endpoint.
- **`window.open()`** for bidding opens the URL in the system browser. The
  URL comes from the platform's own API response — no user-generated URL
  is ever passed to `window.open()`.
- The `freelance` feature-flag file check uses `existsSync` with a fixed
  filename — no path traversal risk.

---

## 16. Implementation Tasks (Ordered)

### Phase 1 — Backend foundation

1. **`v12_freelance-listings.ts`** migration
   - Create `freelance_listings` table with unique index on `(platform, external_id)`

2. **`src/bun/db/schema.ts`** — add `freelanceListings` Drizzle table definition

3. **`src/bun/freelance/feature-flag.ts`** — `isFreelanceEnabled()` with dev fallback

4. **`src/bun/index.ts`** — export `FREELANCE_ENABLED`, conditionally start poller

5. **`src/bun/freelance/settings.ts`** — typed read/write helpers for all
   `freelance_*` settings keys; seed default values via migration or seed.ts

6. **`src/bun/freelance/oauth.ts`**
   - `startOAuthFlow(platform)` → starts localhost:37911 server, returns auth URL
   - `handleCallback(platform, code)` → token exchange, saves to settings
   - `getValidToken(platform)` → returns token (refreshing if needed)

7. **`src/bun/freelance/normalizer.ts`** — `normalize()` for both platforms

8. **`src/bun/freelance/upwork-client.ts`** — `searchJobs()` with token management

9. **`src/bun/freelance/freelancer-client.ts`** — `searchProjects()` with token management

10. **`src/bun/freelance/fetcher.ts`**
    - `fetchAllPlatforms()` — orchestrates clients, normalizer, DB upsert, broadcast
    - `startFreelancePoller()` — interval-based polling

### Phase 2 — RPC layer

11. **`src/shared/rpc/freelance.ts`** — full contract type as defined in §12

12. **`src/shared/rpc/index.ts`** — import + intersect `FreelanceRequests`

13. **`src/shared/rpc/webview.ts`** — add `freelance.listingsUpdated` and
    `freelance.authComplete` to server-push schema

14. **`src/bun/rpc/freelance.ts`** — implement all 10 RPC handlers

15. **`src/bun/rpc-registration.ts`** — import `* as freelanceRpc` and register handlers

### Phase 3 — Frontend

16. **`src/mainview/components/freelance/keyword-input.tsx`** — tag-style input

17. **`src/mainview/components/freelance/platform-connect.tsx`** — OAuth connect UI

18. **`src/mainview/components/freelance/listing-card.tsx`** — full card component

19. **`src/mainview/components/freelance/listings-tab.tsx`** — list + filter + fetch now

20. **`src/mainview/components/freelance/settings-tab.tsx`** — platforms + filters form

21. **`src/mainview/pages/freelance.tsx`** — page root with two tabs

22. **`src/mainview/router.tsx`** — add `/freelance` route

23. **`src/mainview/components/layout/sidebar.tsx`** — conditionally add nav item
    (call `freelance.getFeatureEnabled` on mount, show Briefcase icon + "Freelance")

### Phase 4 — Approve flow & integration

24. **`src/bun/rpc/freelance.ts` `approveListing`** — full approve flow:
    create project, craft initial PM message, insert into conversation, start
    AgentEngine, return projectId

25. **End-to-end test** — place `freelance` file, configure settings, trigger
    fetch, approve listing, verify project + plan card appear

---

## 17. File Map (All New/Modified Files)

### New files
```
src/bun/freelance/feature-flag.ts
src/bun/freelance/settings.ts
src/bun/freelance/oauth.ts
src/bun/freelance/normalizer.ts
src/bun/freelance/upwork-client.ts
src/bun/freelance/freelancer-client.ts
src/bun/freelance/fetcher.ts
src/bun/rpc/freelance.ts
src/shared/rpc/freelance.ts
src/mainview/pages/freelance.tsx
src/mainview/components/freelance/listing-card.tsx
src/mainview/components/freelance/listings-tab.tsx
src/mainview/components/freelance/settings-tab.tsx
src/mainview/components/freelance/platform-connect.tsx
src/mainview/components/freelance/keyword-input.tsx
src/bun/db/migrations/v12_freelance-listings.ts
```

### Modified files
```
src/bun/db/schema.ts                        # Add freelanceListings table
src/bun/index.ts                            # Export FREELANCE_ENABLED, start poller
src/bun/rpc-registration.ts                 # Register freelanceRpc handlers
src/shared/rpc/index.ts                     # Add FreelanceRequests to BunRequests
src/shared/rpc/webview.ts                   # Add server-push event types
src/mainview/router.tsx                     # Add /freelance route
src/mainview/components/layout/sidebar.tsx  # Conditional nav item
```

**Total new files: 16 | Modified files: 7**

---

## 18. Out of Scope (Future Enhancements)

- **AI-drafted bid messages**: PM agent drafts a bid based on listing + user
  profile; shown in UI for copy-paste before opening browser
- **Guru.com + PeoplePerHour**: add via RSS once confirmed working; or add
  Guru's official API if they release one
- **Budget currency normalization**: currently assumes USD; platforms may
  return other currencies
- **Notification channels**: send new listing summaries to Discord/WhatsApp/Email
  via existing ChannelManager
- **Saved search presets**: multiple keyword+budget profiles switchable in UI
- **Project matching score**: LLM-based relevance scoring before showing
  listings to the user
- **Token encryption at rest**: encrypt client secrets and OAuth tokens in
  the settings table
