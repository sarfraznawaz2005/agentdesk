// Keeps collection_notes.embedding current: a debounced background re-embed on every
// create/update (never blocks the save's RPC response), plus a manual full reindex for
// Settings' "Re-index notes" action (e.g. after a model change).

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { collectionNotes, settings } from "../../db/schema";
import { embedText } from "./embedder";
import { packVector } from "./similarity";
import { EMBEDDING_MODEL_ID, isEmbeddingModelDownloaded } from "./model-manager";

const DEBOUNCE_MS = 1500;
export const LAST_INDEXED_SETTING_KEY = "collections:lastIndexedAt";

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function embeddingInputFor(title: string, contentMarkdown: string): string {
	return `${title}\n\n${contentMarkdown}`;
}

async function embedAndStoreNote(noteId: string): Promise<void> {
	const rows = await db
		.select({ title: collectionNotes.title, contentMarkdown: collectionNotes.contentMarkdown, isDeleted: collectionNotes.isDeleted })
		.from(collectionNotes)
		.where(eq(collectionNotes.id, noteId))
		.limit(1);
	const note = rows[0];
	if (!note || note.isDeleted === 1) return; // deleted/moved to trash before the debounce fired

	const vector = await embedText(embeddingInputFor(note.title, note.contentMarkdown));
	await db
		.update(collectionNotes)
		.set({ embedding: packVector(vector), embeddingModel: EMBEDDING_MODEL_ID })
		.where(eq(collectionNotes.id, noteId));
}

// Fire-and-forget — callers never await this, so a note save's RPC response is never blocked on
// embedding. Debounced per note so rapid successive saves collapse into a single re-embed.
export function scheduleReembed(noteId: string): void {
	if (!isEmbeddingModelDownloaded()) return; // silently skip — Settings gates chat/search on this anyway

	const existing = pendingTimers.get(noteId);
	if (existing) clearTimeout(existing);

	const timer = setTimeout(() => {
		pendingTimers.delete(noteId);
		embedAndStoreNote(noteId).catch((err) => {
			console.error(`[collections/indexer] Failed to re-embed note ${noteId}:`, err);
		});
	}, DEBOUNCE_MS);
	pendingTimers.set(noteId, timer);
}

async function setLastIndexedAt(iso: string): Promise<void> {
	await db
		.insert(settings)
		.values({ key: LAST_INDEXED_SETTING_KEY, value: iso, category: "collections" })
		.onConflictDoUpdate({ target: settings.key, set: { value: iso, updatedAt: iso } });
}

export async function getLastIndexedAt(): Promise<string | null> {
	const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, LAST_INDEXED_SETTING_KEY)).limit(1);
	return rows[0]?.value ?? null;
}

// Full manual reindex — every non-deleted note, sequentially (brute-force scale, see
// docs/collections-plan.md §7; a note-count high enough to need batching isn't this feature's
// target use case).
export async function reindexAll(): Promise<{ success: boolean; indexed: number }> {
	if (!isEmbeddingModelDownloaded()) {
		return { success: false, indexed: 0 };
	}

	const notes = await db
		.select({ id: collectionNotes.id, title: collectionNotes.title, contentMarkdown: collectionNotes.contentMarkdown })
		.from(collectionNotes)
		.where(eq(collectionNotes.isDeleted, 0));

	let indexed = 0;
	for (const note of notes) {
		try {
			const vector = await embedText(embeddingInputFor(note.title, note.contentMarkdown));
			await db
				.update(collectionNotes)
				.set({ embedding: packVector(vector), embeddingModel: EMBEDDING_MODEL_ID })
				.where(eq(collectionNotes.id, note.id));
			indexed++;
		} catch (err) {
			console.error(`[collections/indexer] Failed to reindex note ${note.id}:`, err);
		}
	}

	await setLastIndexedAt(new Date().toISOString());
	return { success: true, indexed };
}
