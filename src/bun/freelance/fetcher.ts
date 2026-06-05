import { and, eq, lt, asc } from "drizzle-orm";
import { db } from "../db";
import { freelanceListings, settings as settingsTable } from "../db/schema";
import { getFreelanceSettings } from "./settings";
import { fetchRssFeed } from "./rss-fetcher";
import { normalizeRssItem } from "./normalizer";
import { FREELANCE_EVENTS } from "./events";
import { broadcastToWebview } from "../engine-manager";
import { sendDesktopNotification } from "../notifications/desktop";
import { runAutoShortlist } from "../rpc/freelance-wizard";


async function purgeOldDeletedListings(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await db
    .delete(freelanceListings)
    .where(and(eq(freelanceListings.isDeleted, 1), lt(freelanceListings.createdAt, cutoff)));
}

// Soft-deletes oldest "new" listings down to maxListings.
// Only "new" listings are eligible — approved, shortlisted, and closed listings
// are never touched. Soft-delete preserves the (platform, external_id) unique
// row so trimmed listings are never re-imported on the next fetch.
async function trimListingsToMax(maxListings: number): Promise<void> {
  const trimmable = and(eq(freelanceListings.isDeleted, 0), eq(freelanceListings.status, "new"));
  const rows = await db
    .select({ id: freelanceListings.id })
    .from(freelanceListings)
    .where(trimmable)
    .orderBy(asc(freelanceListings.createdAt));

  const excess = rows.length - maxListings;
  if (excess <= 0) return;

  const now = new Date().toISOString();
  const toTrim = rows.slice(0, excess).map((r) => r.id);
  for (const id of toTrim) {
    await db
      .update(freelanceListings)
      .set({ isDeleted: 1, updatedAt: now })
      .where(eq(freelanceListings.id, id));
  }
  console.log(`[freelance] Soft-deleted ${toTrim.length} old listing(s) to stay within maxListings=${maxListings}`);
}

export async function fetchAllPlatforms(options?: { notify?: boolean; source?: "manual" | "scheduled" | "startup" }): Promise<void> {
  await purgeOldDeletedListings().catch((err) =>
    console.error("[freelance] Purge failed:", err),
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

export function startFreelancePoller(): void {
  getFreelanceSettings()
    .then((s) => {
      if (s.pollingInterval === 0) {
        console.log("[freelance] Polling disabled — skipping startup fetch");
        return;
      }
      fetchAllPlatforms({ source: "startup" }).catch((err) =>
        console.error("[freelance] Initial fetch failed:", err),
      );
      scheduleNextPoll();
    })
    .catch((err) => {
      console.error("[freelance] Failed to read settings on startup:", err);
      // Fall back to normal start if settings unreadable
      fetchAllPlatforms({ source: "startup" }).catch(console.error);
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
