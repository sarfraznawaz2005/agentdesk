import { and, eq, lt, asc, isNotNull, inArray } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { freelanceListings, settings as settingsTable } from "../db/schema";
import { getFreelanceSettings } from "./settings";
import { getAutoEarnSettings } from "./auto-earn-settings";
import { fetchRssFeed } from "./rss-fetcher";
import { normalizeRssItem } from "./normalizer";
import { FREELANCE_EVENTS } from "./events";
import { broadcastToWebview } from "../engine-manager";
import { sendDesktopNotification } from "../notifications/desktop";
import { runAutoShortlist } from "../rpc/freelance-wizard";


// Soft-deletes non-approved listings whose clientCountry matches the blocked list.
// Called on every fetch run so listings blocked after they were first stored get
// cleaned up automatically on the next poll.
async function purgeBlockedCountryListings(): Promise<void> {
  const aeSettings = await getAutoEarnSettings().catch(() => null);
  // Respect the master switch — skip purge when client filtering is disabled,
  // even if clientBlockedCountries is still populated from a prior configuration.
  if (!aeSettings?.clientFilterEnabled || !aeSettings.clientBlockedCountries.trim()) return;

  const blocked = aeSettings.clientBlockedCountries.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (blocked.length === 0) return;

  // Load all non-deleted new/shortlisted listings that have country data
  const rows = await db
    .select({ id: freelanceListings.id, clientCountry: freelanceListings.clientCountry })
    .from(freelanceListings)
    .where(and(
      eq(freelanceListings.isDeleted, 0),
      isNotNull(freelanceListings.clientCountry),
      inArray(freelanceListings.status, ["new", "shortlisted"]),
    ));

  const now = new Date().toISOString();
  let purged = 0;
  for (const row of rows) {
    const countryLower = (row.clientCountry ?? "").toLowerCase().trim();
    if (blocked.some((b) => countryLower === b || countryLower.endsWith(`, ${b}`))) {
      sqlite
        .prepare("UPDATE freelance_listings SET is_deleted = 1, updated_at = ? WHERE id = ?")
        .run(now, row.id);
      purged++;
    }
  }
  if (purged > 0) console.log(`[freelance] Soft-deleted ${purged} listing(s) from blocked countries`);
}

async function purgeOldDeletedListings(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await db
    .delete(freelanceListings)
    .where(and(eq(freelanceListings.isDeleted, 1), lt(freelanceListings.createdAt, cutoff)));
}

// Reclaims room for new RSS entries by soft-deleting old "new"-column listings
// down to maxListings. New entries are ALWAYS inserted first (never blocked by
// the cap) — this just trims afterward.
//
// Protection: only "new"-column listings are ever eligible. Shortlisted,
// approved, and done/closed listings are NEVER touched — they represent the
// user's decisions and committed work.
//
// Deletion priority within "new": already-judged non-workable / gated listings
// first (skill-gate, client-quality, non-software, analysis-fail — all persisted
// as wizard_verdict='not_workable'), THEN the oldest of the rest. This clears the
// low-value "junk" first so fresh, unanalyzed RSS entries and workable-pending
// listings survive longest. Each tier is oldest-first. Soft-delete preserves the
// (platform, external_id) unique row so a trimmed listing is never re-imported.
// Yield a macrotask so a burst of synchronous bun:sqlite writes interleaves with
// pending UI RPCs (which arrive as I/O) instead of holding the event loop for the
// whole batch. Called every few writes during insert/trim.
const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function trimListingsToMax(maxListings: number): Promise<void> {
  const rows = await db
    .select({ id: freelanceListings.id, verdict: freelanceListings.wizardVerdict })
    .from(freelanceListings)
    .where(and(eq(freelanceListings.isDeleted, 0), eq(freelanceListings.status, "new")))
    .orderBy(asc(freelanceListings.createdAt)); // oldest first

  const excess = rows.length - maxListings;
  if (excess <= 0) return;

  // Junk (non-workable/gated) oldest-first, then everything else oldest-first.
  const ordered = [
    ...rows.filter((r) => r.verdict === "not_workable"),
    ...rows.filter((r) => r.verdict !== "not_workable"),
  ];
  const toTrim = ordered.slice(0, excess).map((r) => r.id);

  const now = new Date().toISOString();
  let n = 0;
  for (const id of toTrim) {
    await db
      .update(freelanceListings)
      .set({ isDeleted: 1, updatedAt: now })
      .where(eq(freelanceListings.id, id));
    if (++n % 5 === 0) await yieldToLoop();
  }
  console.log(`[freelance] Soft-deleted ${toTrim.length} old listing(s) to stay within maxListings=${maxListings}`);
}

export async function fetchAllPlatforms(options?: { notify?: boolean; source?: "manual" | "scheduled" | "startup" }): Promise<void> {
  await purgeOldDeletedListings().catch((err) =>
    console.error("[freelance] Purge failed:", err),
  );
  await purgeBlockedCountryListings().catch((err) =>
    console.error("[freelance] Blocked-country purge failed:", err),
  );

  const s = await getFreelanceSettings();

  const enabledSources = s.rssSources.filter((src) => src.enabled);
  if (enabledSources.length === 0) {
    console.log("[freelance] Skipping fetch — no RSS sources enabled");
    return;
  }

  const fetchSource = options?.source ?? "scheduled";
  broadcastToWebview(FREELANCE_EVENTS.FETCH_STARTED, { source: fetchSource });

  let totalNew = 0;
  let sourceErrors = 0;

  for (const source of enabledSources) {
    try {
      const items = await fetchRssFeed(source.url, s.keywords, Math.min(100, Math.max(5, s.maxFeeds)));
      const listings = [];
      for (const item of items) {
        try {
          listings.push(normalizeRssItem(item, source.name));
        } catch (err) {
          console.warn(`[freelance] Skipping malformed item from ${source.name}:`, err);
        }
      }
      let insertedCount = 0;
      let writeBatch = 0;

      for (const listing of listings) {
        try {
          const result = db
            .insert(freelanceListings)
            .values({
              platform: listing.platform,
              externalId: listing.externalId,
              title: listing.title,
              description: listing.description,
              skills: JSON.stringify(listing.skills),
              budgetType: listing.budgetType,
              budgetMin: listing.budgetMin ?? undefined,
              budgetMax: listing.budgetMax ?? undefined,
              currency: listing.currency,
              url: listing.url,
              postedAt: listing.postedAt ?? undefined,
            })
            .onConflictDoNothing()
            .run() as unknown as { changes: number };

          if (result.changes > 0) insertedCount++;
        } catch (err) {
          console.error(`[freelance] Failed to insert listing ${listing.externalId}:`, err);
        }
        // Yield to the event loop every few inserts so this synchronous write burst
        // doesn't stall UI RPCs (bun:sqlite writes are synchronous).
        if (++writeBatch % 5 === 0) await yieldToLoop();
      }

      console.log(
        `[freelance] ${source.name}: fetched ${listings.length} matching, inserted ${insertedCount} new`,
      );
      totalNew += insertedCount;
    } catch (err) {
      sourceErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[freelance] Error fetching RSS from ${source.name} (${source.url}):`, err);
      try {
        broadcastToWebview("showToast", {
          type: "error",
          message: `${source.name}: ${msg}`,
        });
      } catch { /* ignore */ }
    }
  }

  // Trim oldest non-approved listings to stay within maxListings
  await trimListingsToMax(Math.min(1000, Math.max(10, s.maxListings))).catch((err) =>
    console.error("[freelance] Trim failed:", err),
  );

  broadcastToWebview(FREELANCE_EVENTS.LISTINGS_UPDATED, { count: totalNew, source: fetchSource, errors: sourceErrors });

  if (options?.notify && totalNew > 0) {
    const prefRow = await db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(and(
        eq(settingsTable.key, "freelance_new_listings_notification"),
        eq(settingsTable.category, "notifications"),
      ))
      .limit(1)
      .catch(() => []);
    const notifEnabled = prefRow[0] ? prefRow[0].value !== "false" : true;
    if (notifEnabled) {
      const body = totalNew === 1
        ? "1 new freelance listing is waiting for your review."
        : `${totalNew} new freelance listings are waiting for your review.`;
      sendDesktopNotification("New Freelance Listings", body).catch(() => {});
    }
  }

  // Trigger auto-shortlist silently after scheduled or startup fetches
  if (fetchSource !== "manual") {
    runAutoShortlist(fetchSource === "startup" ? "startup" : "scheduled").catch((err) => {
      console.error("[freelance] Auto shortlist error:", err);
    });
  }
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

let pollerTimeout: ReturnType<typeof setTimeout> | null = null;

// Hold the startup fetch out of the app's launch / early-navigation window. Its
// network call resolves into synchronous listing processing + DB writes
// (insert/soft-delete), and since bun:sqlite is synchronous that batch briefly
// stalls the event loop — if it lands while a page is loading its data, that page
// flashes a loading state (e.g. "Loading settings…"). 30s clears the window where
// the user is navigating around right after open; the recurring poll is unaffected.
const STARTUP_FETCH_DELAY_MS = 30_000;

function deferStartupFetch(): void {
  setTimeout(() => {
    fetchAllPlatforms({ source: "startup" }).catch((err) =>
      console.error("[freelance] Initial fetch failed:", err),
    );
  }, STARTUP_FETCH_DELAY_MS);
}

export function startFreelancePoller(): void {
  getFreelanceSettings()
    .then((s) => {
      if (s.pollingInterval === 0) {
        console.log("[freelance] Polling disabled — skipping startup fetch");
        return;
      }
      deferStartupFetch();
      scheduleNextPoll();
    })
    .catch((err) => {
      console.error("[freelance] Failed to read settings on startup:", err);
      // Fall back to normal start if settings unreadable
      deferStartupFetch();
      scheduleNextPoll();
    });
}

export function stopFreelancePoller(): void {
  if (pollerTimeout !== null) {
    clearTimeout(pollerTimeout);
    pollerTimeout = null;
  }
}

function scheduleNextPoll(): void {
  getFreelanceSettings()
    .then((s) => {
      if (s.pollingInterval === 0) {
        console.log("[freelance] Polling disabled — poller stopped");
        return;
      }
      const intervalMs = (s.pollingInterval ?? 60) * 60 * 1000;
      pollerTimeout = setTimeout(async () => {
        await fetchAllPlatforms({ notify: true, source: "scheduled" }).catch((err) =>
          console.error("[freelance] Scheduled fetch failed:", err),
        );
        scheduleNextPoll();
      }, intervalMs);
    })
    .catch(() => {
      pollerTimeout = setTimeout(async () => {
        await fetchAllPlatforms({ notify: true, source: "scheduled" }).catch(console.error);
        scheduleNextPoll();
      }, 60 * 60 * 1000);
    });
}
