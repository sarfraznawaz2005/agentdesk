// Per-project "unread agent activity" tracking.
//
// One row per (projectId, location). A location is a leaf UI spot where an agent
// produced work — e.g. "chat" or "issue-fixer:history". Unread = lastActivityAt
// is newer than lastSeenAt. The backend bumps lastActivityAt when an agent
// finishes (recordActivity); the frontend bumps lastSeenAt when the user opens
// that view (markActivitySeen). Drives the dashboard-card + project-tab dots.

import { db } from "../db";
import { projectActivity } from "../db/schema";
import { eq } from "drizzle-orm";

export interface UnreadActivityEntry {
	projectId: string;
	location: string;
}

// Pseudo-location storing the per-project "card acknowledged" timestamp. Opening
// the project bumps its lastSeenAt; the dashboard card dot then only shows for
// leaf activity NEWER than that ack — so clicking the card clears the card dot
// without forcing the user to open every individual unread leaf.
const CARD_LOCATION = "__card__";

// broadcastToWebview lives in engine-manager, which imports this module — load it
// lazily to avoid a static import cycle.
async function broadcast(projectId: string, location: string): Promise<void> {
	try {
		const { broadcastToWebview } = await import("../engine-manager");
		broadcastToWebview("activityUpdated", { projectId, location });
	} catch {
		/* non-critical */
	}
}

/** Record that an agent finished work for (projectId, location). Marks it unread. */
export async function recordActivity(projectId: string, location: string): Promise<void> {
	if (!projectId || !location) return;
	const now = new Date().toISOString();
	await db
		.insert(projectActivity)
		.values({ projectId, location, lastActivityAt: now, lastSeenAt: null })
		.onConflictDoUpdate({
			target: [projectActivity.projectId, projectActivity.location],
			set: { lastActivityAt: now },
		});
	await broadcast(projectId, location);
}

/**
 * Returns:
 *  - `entries`: leaf (projectId, location) pairs whose latest activity is unseen
 *    (drives the per-tab dots; `__card__` excluded).
 *  - `cards`: projectIds whose dashboard-card dot should show — i.e. there's an
 *    unread leaf with activity NEWER than the card was last acknowledged.
 */
export async function getUnreadActivity(): Promise<{ entries: UnreadActivityEntry[]; cards: string[] }> {
	const rows = await db.select().from(projectActivity);

	const byProject = new Map<string, typeof rows>();
	for (const r of rows) {
		const list = byProject.get(r.projectId);
		if (list) list.push(r);
		else byProject.set(r.projectId, [r]);
	}

	const entries: UnreadActivityEntry[] = [];
	const cards: string[] = [];
	for (const [projectId, prows] of byProject) {
		const cardSeen = prows.find((r) => r.location === CARD_LOCATION)?.lastSeenAt ?? null;
		let cardUnread = false;
		for (const r of prows) {
			if (r.location === CARD_LOCATION) continue;
			const leafUnread = !!r.lastActivityAt && (!r.lastSeenAt || r.lastActivityAt > r.lastSeenAt);
			if (!leafUnread) continue;
			entries.push({ projectId, location: r.location });
			// Counts toward the card only if newer than the last card acknowledgment.
			if (!cardSeen || (r.lastActivityAt && r.lastActivityAt > cardSeen)) cardUnread = true;
		}
		if (cardUnread) cards.push(projectId);
	}
	return { entries, cards };
}

/** Mark a (projectId, location) as seen — clears its unread dot. */
export async function markActivitySeen(params: { projectId: string; location: string }): Promise<{ ok: boolean }> {
	const { projectId, location } = params;
	if (!projectId || !location) return { ok: false };
	const now = new Date().toISOString();
	await db
		.insert(projectActivity)
		.values({ projectId, location, lastActivityAt: null, lastSeenAt: now })
		.onConflictDoUpdate({
			target: [projectActivity.projectId, projectActivity.location],
			set: { lastSeenAt: now },
		});
	await broadcast(projectId, location);
	return { ok: true };
}

/** Clear all activity rows for a project (used on project delete/reset). */
export async function clearProjectActivity(projectId: string): Promise<void> {
	await db.delete(projectActivity).where(eq(projectActivity.projectId, projectId));
}
