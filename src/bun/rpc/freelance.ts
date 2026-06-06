import { eq, desc, count, and, or, like, notInArray } from "drizzle-orm";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { sqlite } from "../db/connection";
import { db } from "../db";
import { freelanceListings, freelanceChatMessages, settings } from "../db/schema";
import { isFreelanceEnabled } from "../freelance/feature-flag";
import { getFreelanceSettings, saveFreelanceSetting } from "../freelance/settings";
import { FREELANCE_EVENTS } from "../freelance/events";
import { formatBudget } from "../freelance/budget";
import { fetchAllPlatforms } from "../freelance/fetcher";
import { getCurrencyRates } from "../freelance/currency-exchange";
import { getOrCreateEngine, broadcastToWebview } from "../engine-manager";
import type { FreelanceListingDto, FreelanceListingStatus } from "../../shared/rpc/freelance";

const PAGE_SIZE = 20;

// ─── getFeatureEnabled ────────────────────────────────────────────────────────
export async function getFeatureEnabled(): Promise<{ enabled: boolean }> {
  return { enabled: isFreelanceEnabled() };
}

// ─── getSettings ─────────────────────────────────────────────────────────────
export async function getSettings() {
  return getFreelanceSettings();
}

// ─── saveSettings ────────────────────────────────────────────────────────────
export async function saveSettings(params: {
  rssSources: Array<{ name: string; url: string; enabled: boolean }>;
  keywords: string[];
  pollingInterval: number;
  maxFeeds: number;
  maxListings: number;
  autoShortlistEnabled: boolean;
  autoShortlistCount: number;
  autoShortlistOnStartup: boolean;
  analysisProviderId: string | null;
  additionalNotes: string;
  preferredCurrency: string;
}): Promise<{ success: boolean }> {
  await saveFreelanceSetting("rssSources", params.rssSources);
  await saveFreelanceSetting("keywords", params.keywords);
  await saveFreelanceSetting("pollingInterval", params.pollingInterval);
  await saveFreelanceSetting("maxFeeds", params.maxFeeds);
  await saveFreelanceSetting("maxListings", params.maxListings);
  await saveFreelanceSetting("autoShortlistEnabled", params.autoShortlistEnabled);
  await saveFreelanceSetting("autoShortlistCount", params.autoShortlistCount);
  await saveFreelanceSetting("autoShortlistOnStartup", params.autoShortlistOnStartup);
  await saveFreelanceSetting("analysisProviderId", params.analysisProviderId);
  await saveFreelanceSetting("additionalNotes", params.additionalNotes);
  await saveFreelanceSetting("preferredCurrency", params.preferredCurrency);
  return { success: true };
}

// ─── getCurrencyRates ─────────────────────────────────────────────────────────
// Returns cached USD-based exchange rates, fetching from network if stale (>24h).
export async function getCurrencyRatesHandler(): Promise<{ rates: Record<string, number>; fetchedAt: string | null }> {
  const cached = await getCurrencyRates();
  if (!cached) return { rates: {}, fetchedAt: null };
  return { rates: cached.rates, fetchedAt: cached.fetchedAt };
}

// ─── getListings ─────────────────────────────────────────────────────────────
// Deleted listings (is_deleted = 1) are never returned regardless of filter.
export async function getListings(params: {
  status?: FreelanceListingStatus;
  page?: number;
  search?: string;
}): Promise<{ listings: FreelanceListingDto[]; total: number; page: number }> {
  const page = params.page ?? 1;
  const offset = (page - 1) * PAGE_SIZE;

  const notDeleted = eq(freelanceListings.isDeleted, 0);
  const q = params.search?.trim();
  const searchFilter = q
    ? or(
        like(freelanceListings.title, `%${q}%`),
        like(freelanceListings.description, `%${q}%`),
        like(freelanceListings.skills, `%${q}%`),
      )
    : undefined;

  const where = and(
    notDeleted,
    params.status ? eq(freelanceListings.status, params.status) : undefined,
    searchFilter,
  );

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(freelanceListings)
      .where(where)
      .orderBy(desc(freelanceListings.fetchedAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(freelanceListings).where(where),
  ]);

  const total = totalRows[0]?.count ?? 0;

  const listings: FreelanceListingDto[] = rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    title: row.title,
    description: row.description,
    skills: (() => {
      try {
        const parsed = JSON.parse(row.skills) as unknown[];
        // Normalize entries that rss-parser stored as {_: "text", $: {attrs}} objects
        return parsed
          .map((s) => {
            if (typeof s === "string") return s;
            if (s && typeof s === "object" && "_" in s) return String((s as Record<string, unknown>)._);
            return null;
          })
          .filter((s): s is string => typeof s === "string" && s.length > 0);
      } catch {
        return [];
      }
    })(),
    budgetType: row.budgetType as "fixed" | "hourly",
    budgetMin: row.budgetMin ?? null,
    budgetMax: row.budgetMax ?? null,
    currency: row.currency,
    url: row.url,
    postedAt: row.postedAt ?? null,
    status: row.status as "new" | "approved" | "closed" | "shortlisted",
    projectId: row.projectId ?? null,
    fetchedAt: row.fetchedAt,
    wizardVerdict: (row.wizardVerdict as "workable" | "not_workable" | null) ?? null,
    wizardReason: row.wizardReason ?? null,
    wizardBlockers: (() => {
      try { return row.wizardBlockers ? (JSON.parse(row.wizardBlockers) as string[]) : null; } catch { return null; }
    })(),
    wizardAnalysisText: row.wizardAnalysisText ?? null,
  }));

  return { listings, total, page };
}

// ─── getListingCounts ─────────────────────────────────────────────────────────
export async function getListingCounts(): Promise<{ new: number; approved: number; shortlisted: number; closed: number; all: number }> {
  const notDeleted = eq(freelanceListings.isDeleted, 0);
  const [newCount, approvedCount, shortlistedCount, closedCount, allCount] = await Promise.all([
    db.select({ count: count() }).from(freelanceListings)
      .where(and(notDeleted, eq(freelanceListings.status, "new"))),
    db.select({ count: count() }).from(freelanceListings)
      .where(and(notDeleted, eq(freelanceListings.status, "approved"))),
    db.select({ count: count() }).from(freelanceListings)
      .where(and(notDeleted, eq(freelanceListings.status, "shortlisted"))),
    db.select({ count: count() }).from(freelanceListings)
      .where(and(notDeleted, eq(freelanceListings.status, "closed"))),
    db.select({ count: count() }).from(freelanceListings)
      .where(notDeleted),
  ]);
  return {
    new: newCount[0]?.count ?? 0,
    approved: approvedCount[0]?.count ?? 0,
    shortlisted: shortlistedCount[0]?.count ?? 0,
    closed: closedCount[0]?.count ?? 0,
    all: allCount[0]?.count ?? 0,
  };
}

// ─── markListingDone ──────────────────────────────────────────────────────────
export async function markListingDone(params: {
  listingId: string;
}): Promise<{ success: boolean }> {
  const rows = await db
    .select({ status: freelanceListings.status })
    .from(freelanceListings)
    .where(eq(freelanceListings.id, params.listingId))
    .limit(1);

  if (!rows[0]) throw new Error(`Listing ${params.listingId} not found`);
  if (!["new", "shortlisted", "approved"].includes(rows[0].status)) {
    throw new Error(`Cannot close listing in status "${rows[0].status}"`);
  }

  const now = new Date().toISOString();
  await db
    .update(freelanceListings)
    .set({ status: "closed", updatedAt: now })
    .where(eq(freelanceListings.id, params.listingId));
  broadcastToWebview(FREELANCE_EVENTS.LISTINGS_UPDATED, { count: 0 });
  return { success: true };
}

// ─── deleteListing ────────────────────────────────────────────────────────────
// Soft-deletes a listing by setting is_deleted = 1.
// Deleted listings are excluded from all queries and never re-inserted by fetchers
// because the (platform, external_id) unique index still exists in the DB.
// Records older than 30 days are hard-deleted during the next fetch run.
export async function deleteListing(params: {
  listingId: string;
}): Promise<{ success: boolean }> {
  const now = new Date().toISOString();
  await db
    .update(freelanceListings)
    .set({ isDeleted: 1, updatedAt: now })
    .where(eq(freelanceListings.id, params.listingId));

  // Clean up associated chat messages so they don't accumulate for deleted listings
  await db
    .delete(freelanceChatMessages)
    .where(eq(freelanceChatMessages.listingId, params.listingId));

  const [{ count: newCount }] = await db
    .select({ count: count() })
    .from(freelanceListings)
    .where(and(eq(freelanceListings.status, "new"), eq(freelanceListings.isDeleted, 0)));
  broadcastToWebview(FREELANCE_EVENTS.LISTINGS_UPDATED, { count: newCount });
  return { success: true };
}

// ─── deleteAllListings ────────────────────────────────────────────────────────
// Soft-deletes every non-deleted, non-approved listing.
// Approved listings are preserved. Soft-delete keeps the (platform, external_id)
// unique row intact so these listings are never re-imported on the next fetch.
// Hard purge of old soft-deleted rows happens in purgeOldDeletedListings (30-day TTL).
export async function deleteAllListings(): Promise<{ success: boolean; deleted: number }> {
  const deletable = and(
    eq(freelanceListings.isDeleted, 0),
    notInArray(freelanceListings.status, ["approved", "shortlisted", "closed"]),
  );

  const rows = await db
    .select({ id: freelanceListings.id })
    .from(freelanceListings)
    .where(deletable);

  if (rows.length === 0) return { success: true, deleted: 0 };

  const now = new Date().toISOString();
  await db
    .update(freelanceListings)
    .set({ isDeleted: 1, updatedAt: now })
    .where(deletable);

  broadcastToWebview(FREELANCE_EVENTS.LISTINGS_UPDATED, { count: 0, source: "manual" });
  return { success: true, deleted: rows.length };
}

// ─── triggerFetch ─────────────────────────────────────────────────────────────
export async function triggerFetch(): Promise<{ success: boolean; skipped?: boolean; reason?: string }> {
  const s = await getFreelanceSettings();
  if (!s.rssSources.some((src) => src.enabled)) {
    return { success: false, skipped: true, reason: "No RSS sources enabled. Enable at least one source in Settings." };
  }
  // Fire and forget — return immediately so the RPC does not block
  fetchAllPlatforms({ source: "manual" }).catch((err) =>
    console.error("[freelance] Manual fetch error:", err),
  );
  return { success: true };
}

// ─── approveListing ───────────────────────────────────────────────────────────
// Full approve flow:
//   1. Load listing
//   2. Create project (name/description/path derived from listing)
//   3. Mark listing approved + set projectId
//   4. Create a conversation for the new project
//   5. Insert the initial PM message
//   6. Start AgentEngine so PM picks up the message
//   7. Return { projectId }
export async function approveListing(params: {
  listingId: string;
}): Promise<{ projectId: string }> {
  // 1. Load listing
  const listingRows = await db
    .select()
    .from(freelanceListings)
    .where(eq(freelanceListings.id, params.listingId))
    .limit(1);

  if (!listingRows[0]) {
    throw new Error(`Listing ${params.listingId} not found`);
  }

  const listing = listingRows[0];

  // Idempotent: if already approved, return the existing projectId
  if (listing.status === "approved") {
    if (listing.projectId) return { projectId: listing.projectId };
    throw new Error("Listing already approved but has no associated project");
  }

  // Status transition validation — closed listings cannot be approved
  if (listing.status === "closed") {
    throw new Error("Cannot approve a closed listing. Restore it to 'new' first.");
  }

  // 2. Resolve global workspace path
  const gwpRows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "global_workspace_path"))
    .limit(1);

  let globalWorkspace = "";
  if (gwpRows[0]) {
    try {
      globalWorkspace = JSON.parse(gwpRows[0].value) as string;
    } catch {
      globalWorkspace = gwpRows[0].value;
    }
  }

  const slug = listing.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  const workspacePath = globalWorkspace ? join(globalWorkspace, slug) : slug;

  // Create workspace directory
  try {
    mkdirSync(workspacePath, { recursive: true });
  } catch {
    // May already exist — non-fatal
  }

  // 3–4. Insert project, mark listing approved, create conversation — all atomic
  const projectId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();

  sqlite.transaction(() => {
    sqlite.prepare(
      "INSERT INTO projects (id, name, description, workspace_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    ).run(projectId, listing.title, listing.description ?? null, workspacePath, now, now);

    sqlite.prepare(
      "UPDATE freelance_listings SET status = 'approved', project_id = ?, updated_at = ? WHERE id = ?",
    ).run(projectId, now, params.listingId);

    sqlite.prepare(
      "INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(conversationId, projectId, listing.title, now, now);
  })();

  // 5. Build the initial PM message
  const skills: string[] = (() => {
    try {
      return JSON.parse(listing.skills) as string[];
    } catch {
      return [];
    }
  })();

  const platformName = listing.platform === "upwork" ? "Upwork" : "Freelancer.com";
  const budgetStr = formatBudget(listing.budgetMin, listing.budgetMax, listing.budgetType, listing.currency);

  const initialMessage = `You have been assigned a new freelance project fetched from ${platformName}.

**Project:** ${listing.title}
**Budget:** ${budgetStr}
**Skills Required:** ${skills.length > 0 ? skills.join(", ") : "Not specified"}
**Platform URL:** ${listing.url}

**Project Description:**
${listing.description}

Please create a plan for delivering this project. Use the task planner to define all tasks needed to complete this work.`;

  // 6. Start AgentEngine — PM will read the message and create a plan
  // Note: sendMessage inserts the user message itself; do NOT pre-insert it here.
  try {
    const engine = getOrCreateEngine(projectId);
    await engine.sendMessage(conversationId, initialMessage);
  } catch (err) {
    console.error(
      "[freelance] AgentEngine failed to start for project — project created, PM can be triggered manually:",
      err,
    );
    // Non-fatal: the project + message were persisted; user can trigger PM manually
  }

  // Notify sidebar badge to recount new listings
  const [{ count: newCount }] = await db
    .select({ count: count() })
    .from(freelanceListings)
    .where(and(eq(freelanceListings.status, "new"), eq(freelanceListings.isDeleted, 0)));
  broadcastToWebview(FREELANCE_EVENTS.LISTINGS_UPDATED, { count: newCount });

  return { projectId };
}
