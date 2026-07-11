import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { collectionNotes, collectionNoteLinks, collections } from "../db/schema";

// Matches [[Note Title]] occurrences. Titles are trimmed; empty brackets ([[]])
// and unterminated brackets are ignored by the regex itself (non-greedy, no
// nested [[ ]] support — matches the "flat wiki-link" scope of docs/collections-plan.md).
const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

export function parseWikiLinkTitles(markdown: string): string[] {
	const titles = new Set<string>();
	for (const match of markdown.matchAll(WIKI_LINK_RE)) {
		const title = match[1]?.trim();
		if (title) titles.add(title);
	}
	return [...titles];
}

// Resolves [[Title]] occurrences in `contentMarkdown` against every non-deleted
// note (global scope, not collection-scoped — matches docs/collections-plan.md's
// "Resolution is global" note on the schema). Unresolved titles are silently
// dropped — a typo'd or not-yet-created target must never fail the save. Self-links
// are dropped too (a note can't link to itself). Replaces the note's entire outgoing
// link set on every save, so removing a [[link]] from the text removes the row.
export async function syncNoteLinks(noteId: string, contentMarkdown: string): Promise<void> {
	const titles = parseWikiLinkTitles(contentMarkdown);

	let targetIds: string[] = [];
	if (titles.length > 0) {
		const candidates = await db
			.select({ id: collectionNotes.id, title: collectionNotes.title })
			.from(collectionNotes)
			.where(eq(collectionNotes.isDeleted, 0));

		const byLowerTitle = new Map<string, string>();
		for (const c of candidates) {
			// First match wins on duplicate titles — deterministic, no ambiguity prompt (v1 scope).
			if (!byLowerTitle.has(c.title.toLowerCase())) byLowerTitle.set(c.title.toLowerCase(), c.id);
		}

		const resolved = new Set<string>();
		for (const title of titles) {
			const targetId = byLowerTitle.get(title.toLowerCase());
			if (targetId && targetId !== noteId) resolved.add(targetId);
		}
		targetIds = [...resolved];
	}

	await db.delete(collectionNoteLinks).where(eq(collectionNoteLinks.sourceNoteId, noteId));
	if (targetIds.length > 0) {
		await db.insert(collectionNoteLinks).values(
			targetIds.map((targetId) => ({
				id: crypto.randomUUID(),
				sourceNoteId: noteId,
				targetNoteId: targetId,
			})),
		);
	}
}

type LinkedNoteRow = {
	id: string;
	title: string;
	collectionId: string;
	collectionName: string;
};

async function fetchLinkedNoteRows(noteIds: string[]): Promise<LinkedNoteRow[]> {
	if (noteIds.length === 0) return [];
	const rows = await db
		.select({
			id: collectionNotes.id,
			title: collectionNotes.title,
			collectionId: collectionNotes.collectionId,
		})
		.from(collectionNotes)
		.where(inArray(collectionNotes.id, noteIds));

	const collectionRows = await db.select({ id: collections.id, name: collections.name }).from(collections);
	const nameById = new Map(collectionRows.map((c) => [c.id, c.name]));

	return rows.map((r) => ({ ...r, collectionName: nameById.get(r.collectionId) ?? "Unknown" }));
}

// Notes THIS note links out to (its own [[wiki-links]]).
export async function getLinkedNotes(noteId: string): Promise<LinkedNoteRow[]> {
	const rows = await db
		.select({ targetNoteId: collectionNoteLinks.targetNoteId })
		.from(collectionNoteLinks)
		.where(eq(collectionNoteLinks.sourceNoteId, noteId));
	return fetchLinkedNoteRows(rows.map((r) => r.targetNoteId));
}

// Notes that link TO this note (backlinks).
export async function getBacklinks(noteId: string): Promise<LinkedNoteRow[]> {
	const rows = await db
		.select({ sourceNoteId: collectionNoteLinks.sourceNoteId })
		.from(collectionNoteLinks)
		.where(eq(collectionNoteLinks.targetNoteId, noteId));
	return fetchLinkedNoteRows(rows.map((r) => r.sourceNoteId));
}
