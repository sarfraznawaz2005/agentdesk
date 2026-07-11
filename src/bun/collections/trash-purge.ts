// Background 30-day auto-purge for Collections Trash — see docs/collections-plan.md §3.
// updatedAt doubles as the purge clock (softDeleteNote bumps it on delete); there is no
// separate deletedAt column. Mirrors the startup+interval timer pattern used by
// startWalCheckpointTimer (src/bun/db/connection.ts).
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { collectionNotes, collectionNoteAttachments } from "../db/schema";
import * as storage from "./storage";

const PURGE_RETENTION_DAYS = 30;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily is plenty of granularity for a 30-day window

let purgeTimer: ReturnType<typeof setInterval> | null = null;

/** Permanently deletes trashed notes (and their attachment files) past the retention
 *  window. Never throws — a failed purge must never crash the app. */
export async function purgeExpiredTrash(days = PURGE_RETENTION_DAYS): Promise<number> {
	try {
		const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
		const expired = await db
			.select({ id: collectionNotes.id })
			.from(collectionNotes)
			.where(and(eq(collectionNotes.isDeleted, 1), lt(collectionNotes.updatedAt, cutoff)));
		const ids = expired.map((r) => r.id);
		if (ids.length === 0) return 0;

		const attachmentRows = await db
			.select({ filePath: collectionNoteAttachments.filePath })
			.from(collectionNoteAttachments)
			.where(inArray(collectionNoteAttachments.noteId, ids));
		for (const a of attachmentRows) storage.deleteAttachmentFile(a.filePath);

		await db.delete(collectionNoteAttachments).where(inArray(collectionNoteAttachments.noteId, ids));
		await db.delete(collectionNotes).where(inArray(collectionNotes.id, ids));
		console.log(`[collections] Purged ${ids.length} trashed note(s) past the ${days}-day retention window.`);
		return ids.length;
	} catch (e) {
		console.error("[collections] Trash purge failed:", e);
		return 0;
	}
}

export function startCollectionsTrashPurgeTimer(): void {
	void purgeExpiredTrash();
	purgeTimer = setInterval(() => { void purgeExpiredTrash(); }, PURGE_INTERVAL_MS);
}

export function stopCollectionsTrashPurgeTimer(): void {
	if (purgeTimer) clearInterval(purgeTimer);
	purgeTimer = null;
}
