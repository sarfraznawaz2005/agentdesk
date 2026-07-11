import { eq, and, or, inArray, sql } from "drizzle-orm";
import { Utils } from "electrobun/bun";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { collections, collectionNotes, collectionNoteAttachments, collectionNoteLinks } from "../db/schema";
import * as storage from "../collections/storage";
import { syncNoteLinks, getLinkedNotes as getLinkedNotesImpl, getBacklinks as getBacklinksImpl } from "../collections/links";
import { exportNoteToFile, exportCollectionToFile, type ExportableNote } from "../collections/export";
import * as modelManager from "../collections/embeddings/model-manager";
import { scheduleReembed, reindexAll, getLastIndexedAt } from "../collections/embeddings/indexer";
import {
	sendCollectionsChatMessage as sendCollectionsChatMessageImpl,
	abortCollectionsChatMessage as abortCollectionsChatMessageImpl,
	clearCollectionsChatSession as clearCollectionsChatSessionImpl,
} from "../collections/chat";
import type {
	CollectionDto,
	CollectionNoteSummaryDto,
	CollectionNoteDto,
	CollectionAttachmentDto,
	CollectionListScope,
	CollectionNoteSort,
	CollectionNoteSourceType,
	CollectionNoteSourceRef,
	CollectionSearchScope,
	CollectionAttachPickerResultDto,
	CollectionLinkedNoteDto,
	CollectionExportFormat,
	EmbeddingModelStatusDto,
} from "../../shared/rpc/collections";

// ---------------------------------------------------------------------------
// Phase 1 CRUD + Phase 2 attachment storage. searchCollectionNotes, export, links, and
// embedding lifecycle are implemented below; the chat streaming/tool-calling assistant
// itself lives in ../collections/chat.ts (see docs/collections-plan.md §12).
// ---------------------------------------------------------------------------

function parseTags(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
	} catch {
		return [];
	}
}

// Cheap markdown-to-plain-text for list-card snippets — strips the common GFM
// syntax noise without pulling in a full markdown parser for a 140-char preview.
function snippetFromMarkdown(markdown: string, maxLen = 140): string {
	const plain = markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_`~]/g, "")
		.replace(/^[-*+]\s+/gm, "")
		.replace(/^\|.*\|$/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > maxLen ? `${plain.slice(0, maxLen).trimEnd()}…` : plain;
}

function toSummaryDto(
	row: typeof collectionNotes.$inferSelect,
	hasAttachment: boolean,
): CollectionNoteSummaryDto {
	return {
		id: row.id,
		collectionId: row.collectionId,
		title: row.title,
		snippet: snippetFromMarkdown(row.contentMarkdown),
		tags: parseTags(row.tags),
		isFavorite: row.isFavorite === 1,
		isDeleted: row.isDeleted === 1,
		hasAttachment,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function toAttachmentDto(row: typeof collectionNoteAttachments.$inferSelect): CollectionAttachmentDto {
	return {
		id: row.id,
		noteId: row.noteId,
		fileName: row.fileName,
		fileSize: row.fileSize,
		mimeType: row.mimeType,
		createdAt: row.createdAt,
	};
}

async function noteIdsWithAttachments(noteIds: string[]): Promise<Set<string>> {
	if (noteIds.length === 0) return new Set();
	const rows = await db
		.select({ noteId: collectionNoteAttachments.noteId })
		.from(collectionNoteAttachments)
		.where(inArray(collectionNoteAttachments.noteId, noteIds));
	return new Set(rows.map((r) => r.noteId));
}

// ---------------------------------------------------------------------------
// Collections CRUD
// ---------------------------------------------------------------------------

export async function listCollections(): Promise<CollectionDto[]> {
	const rows = await db
		.select()
		.from(collections)
		.orderBy(sql`${collections.isDefault} DESC`, collections.sortOrder, collections.name);

	const counts = await db
		.select({ collectionId: collectionNotes.collectionId, n: sql<number>`count(*)` })
		.from(collectionNotes)
		.where(eq(collectionNotes.isDeleted, 0))
		.groupBy(collectionNotes.collectionId);
	const countByCollection = new Map(counts.map((c) => [c.collectionId, c.n]));

	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		color: r.color,
		icon: r.icon,
		isDefault: r.isDefault === 1,
		sortOrder: r.sortOrder,
		noteCount: countByCollection.get(r.id) ?? 0,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	}));
}

export async function createCollection(params: { name: string; color: string; icon?: string }) {
	const id = crypto.randomUUID();
	await db.insert(collections).values({
		id,
		name: params.name,
		color: params.color,
		icon: params.icon ?? null,
	});
	return { success: true, id };
}

export async function renameCollection(params: { id: string; name: string }) {
	await db
		.update(collections)
		.set({ name: params.name, updatedAt: new Date().toISOString() })
		.where(eq(collections.id, params.id));
	return { success: true };
}

export async function recolorCollection(params: { id: string; color: string; icon?: string }) {
	const updates: Record<string, unknown> = { color: params.color, updatedAt: new Date().toISOString() };
	if (params.icon !== undefined) updates.icon = params.icon;
	await db.update(collections).set(updates).where(eq(collections.id, params.id));
	return { success: true };
}

export async function reorderCollections(params: { orderedIds: string[] }) {
	const tx = db.transaction(async (txDb) => {
		for (let i = 0; i < params.orderedIds.length; i++) {
			await txDb
				.update(collections)
				.set({ sortOrder: i, updatedAt: new Date().toISOString() })
				.where(eq(collections.id, params.orderedIds[i]));
		}
	});
	await tx;
	return { success: true };
}

export async function deleteCollection(params: { id: string }) {
	const rows = await db.select().from(collections).where(eq(collections.id, params.id)).limit(1);
	const target = rows[0];
	if (!target) return { success: false, error: "Collection not found" };
	if (target.isDefault === 1) {
		return { success: false, error: "The Default collection cannot be deleted" };
	}

	const defaultRows = await db.select().from(collections).where(eq(collections.isDefault, 1)).limit(1);
	const defaultId = defaultRows[0]?.id;
	if (!defaultId) return { success: false, error: "No Default collection found to move notes into" };

	const noteCountRows = await db
		.select({ n: sql<number>`count(*)` })
		.from(collectionNotes)
		.where(eq(collectionNotes.collectionId, params.id));
	const movedNoteCount = noteCountRows[0]?.n ?? 0;

	if (movedNoteCount > 0) {
		await db
			.update(collectionNotes)
			.set({ collectionId: defaultId, updatedAt: new Date().toISOString() })
			.where(eq(collectionNotes.collectionId, params.id));
	}

	await db.delete(collections).where(eq(collections.id, params.id));
	return { success: true, movedNoteCount };
}

// ---------------------------------------------------------------------------
// Notes CRUD
// ---------------------------------------------------------------------------

export async function listNotes(params: {
	collectionId: CollectionListScope;
	query?: string;
	tags?: string[];
	sort?: CollectionNoteSort;
}): Promise<CollectionNoteSummaryDto[]> {
	const conditions = [];
	if (params.collectionId === "favorites") {
		conditions.push(eq(collectionNotes.isFavorite, 1), eq(collectionNotes.isDeleted, 0));
	} else if (params.collectionId === "trash") {
		conditions.push(eq(collectionNotes.isDeleted, 1));
	} else {
		conditions.push(eq(collectionNotes.collectionId, params.collectionId), eq(collectionNotes.isDeleted, 0));
	}
	if (params.query?.trim()) {
		const pattern = `%${params.query.trim()}%`;
		conditions.push(
			sql`(${collectionNotes.title} LIKE ${pattern} OR ${collectionNotes.contentMarkdown} LIKE ${pattern})`,
		);
	}

	let rows = await db
		.select()
		.from(collectionNotes)
		.where(and(...conditions));

	// Tag filtering done in JS — tags is a JSON-string column, not relational.
	if (params.tags && params.tags.length > 0) {
		const wanted = new Set(params.tags);
		rows = rows.filter((r) => parseTags(r.tags).some((t) => wanted.has(t)));
	}

	const sort = params.sort ?? "updated";
	rows.sort((a, b) => {
		switch (sort) {
			case "created":
				return b.createdAt.localeCompare(a.createdAt);
			case "title":
				return a.title.localeCompare(b.title);
			case "favorite":
				if (a.isFavorite !== b.isFavorite) return b.isFavorite - a.isFavorite;
				return b.updatedAt.localeCompare(a.updatedAt);
			case "updated":
			default:
				return b.updatedAt.localeCompare(a.updatedAt);
		}
	});

	const withAttachments = await noteIdsWithAttachments(rows.map((r) => r.id));
	return rows.map((r) => toSummaryDto(r, withAttachments.has(r.id)));
}

// Mirrors listNotes' own favorites/trash/collection branching so a single
// search implementation covers every rail scope, not just real collections.
function searchScopeCondition(scope: CollectionSearchScope): { sql: string; args: string[] } {
	if (scope === "favorites") return { sql: "cn.is_favorite = 1 AND cn.is_deleted = 0", args: [] };
	if (scope === "trash") return { sql: "cn.is_deleted = 1", args: [] };
	if (scope === "all") return { sql: "cn.is_deleted = 0", args: [] };
	return { sql: "cn.is_deleted = 0 AND cn.collection_id = ?", args: [scope] };
}

type SearchRawRow = {
	id: string;
	collectionId: string;
	title: string;
	contentMarkdown: string;
	tags: string;
	isFavorite: number;
	isDeleted: number;
	createdAt: string;
	updatedAt: string;
};

const SEARCH_COLUMNS = `cn.id AS id, cn.collection_id AS collectionId, cn.title AS title,
	cn.content_markdown AS contentMarkdown, cn.tags AS tags,
	cn.is_favorite AS isFavorite, cn.is_deleted AS isDeleted,
	cn.created_at AS createdAt, cn.updated_at AS updatedAt`;

// FTS5 full-text search over collection_notes_fts (migration v56), LIKE
// fallback if the MATCH query throws (e.g. FTS5 special-character syntax
// errors) — same try/catch shape as bun/rpc/notes.ts:114-135's searchNotes.
export async function searchCollectionNotes(params: {
	query: string;
	scope: CollectionSearchScope;
}): Promise<CollectionNoteSummaryDto[]> {
	const query = params.query.trim();
	if (!query) return [];

	const cond = searchScopeCondition(params.scope);
	let rows: SearchRawRow[];
	try {
		// Append * to each token so partial words match (e.g. "implem" -> "implem*").
		const ftsQuery = query
			.split(/\s+/)
			.map((t) => `${t.replace(/"/g, '""')}*`)
			.join(" ");
		rows = sqlite
			.prepare(
				`SELECT ${SEARCH_COLUMNS} FROM collection_notes cn
				 JOIN collection_notes_fts f ON cn.rowid = f.rowid
				 WHERE collection_notes_fts MATCH ? AND ${cond.sql}
				 ORDER BY rank
				 LIMIT 50`,
			)
			.all(ftsQuery, ...cond.args) as SearchRawRow[];
	} catch {
		const pattern = `%${query}%`;
		rows = sqlite
			.prepare(
				`SELECT ${SEARCH_COLUMNS} FROM collection_notes cn
				 WHERE (cn.title LIKE ? OR cn.content_markdown LIKE ?) AND ${cond.sql}
				 ORDER BY cn.updated_at DESC
				 LIMIT 50`,
			)
			.all(pattern, pattern, ...cond.args) as SearchRawRow[];
	}

	const withAttachments = await noteIdsWithAttachments(rows.map((r) => r.id));
	return rows.map((r) => ({
		id: r.id,
		collectionId: r.collectionId,
		title: r.title,
		snippet: snippetFromMarkdown(r.contentMarkdown),
		tags: parseTags(r.tags),
		isFavorite: r.isFavorite === 1,
		isDeleted: r.isDeleted === 1,
		hasAttachment: withAttachments.has(r.id),
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	}));
}

export async function sendCollectionsChatMessage(params: {
	sessionId: string;
	content: string;
	scope: CollectionSearchScope;
}): Promise<{ messageId: string }> {
	return sendCollectionsChatMessageImpl(params);
}

export function abortCollectionsChatMessage(params: { sessionId: string }): { success: boolean } {
	return abortCollectionsChatMessageImpl(params);
}

export function clearCollectionsChatSession(params: { sessionId: string }): { success: boolean } {
	return clearCollectionsChatSessionImpl(params);
}

export async function getCollectionNote(id: string): Promise<CollectionNoteDto | null> {
	const rows = await db.select().from(collectionNotes).where(eq(collectionNotes.id, id)).limit(1);
	const row = rows[0];
	if (!row) return null;

	const attachmentRows = await db
		.select()
		.from(collectionNoteAttachments)
		.where(eq(collectionNoteAttachments.noteId, id));

	let sourceRef: CollectionNoteSourceRef | null = null;
	if (row.sourceRef) {
		try {
			sourceRef = JSON.parse(row.sourceRef);
		} catch {
			sourceRef = null;
		}
	}

	return {
		...toSummaryDto(row, attachmentRows.length > 0),
		contentMarkdown: row.contentMarkdown,
		sourceType: (row.sourceType as CollectionNoteSourceType | null) ?? null,
		sourceRef,
		attachments: attachmentRows.map(toAttachmentDto),
	};
}

export async function createCollectionNote(params: {
	collectionId: string;
	title: string;
	contentMarkdown?: string;
}) {
	const id = crypto.randomUUID();
	const contentMarkdown = params.contentMarkdown ?? "";
	await db.insert(collectionNotes).values({
		id,
		collectionId: params.collectionId,
		title: params.title,
		contentMarkdown,
	});
	await syncNoteLinks(id, contentMarkdown);
	scheduleReembed(id);
	return { success: true, id };
}

export async function saveToCollection(params: {
	collectionId: string;
	title: string;
	contentMarkdown: string;
	sourceType?: CollectionNoteSourceType;
	sourceRef?: CollectionNoteSourceRef;
}) {
	const id = crypto.randomUUID();
	await db.insert(collectionNotes).values({
		id,
		collectionId: params.collectionId,
		title: params.title,
		contentMarkdown: params.contentMarkdown,
		sourceType: params.sourceType ?? null,
		sourceRef: params.sourceRef ? JSON.stringify(params.sourceRef) : null,
	});
	await syncNoteLinks(id, params.contentMarkdown);
	scheduleReembed(id);
	return { success: true, id };
}

export async function updateCollectionNote(params: {
	id: string;
	title?: string;
	contentMarkdown?: string;
	tags?: string[];
}) {
	const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
	if (params.title !== undefined) updates.title = params.title;
	if (params.contentMarkdown !== undefined) updates.contentMarkdown = params.contentMarkdown;
	if (params.tags !== undefined) updates.tags = JSON.stringify(params.tags);
	await db.update(collectionNotes).set(updates).where(eq(collectionNotes.id, params.id));
	// Re-parse [[wiki-links]] whenever content actually changed — a tags-only
	// or title-only save leaves prior content untouched, so its link set is
	// already correct and doesn't need re-resolving.
	if (params.contentMarkdown !== undefined) {
		await syncNoteLinks(params.id, params.contentMarkdown);
		scheduleReembed(params.id);
	}
	return { success: true };
}

export async function toggleFavorite(params: { id: string }) {
	const rows = await db
		.select({ isFavorite: collectionNotes.isFavorite })
		.from(collectionNotes)
		.where(eq(collectionNotes.id, params.id))
		.limit(1);
	if (!rows[0]) return { success: false, isFavorite: false };

	const next = rows[0].isFavorite === 1 ? 0 : 1;
	await db
		.update(collectionNotes)
		.set({ isFavorite: next, updatedAt: new Date().toISOString() })
		.where(eq(collectionNotes.id, params.id));
	return { success: true, isFavorite: next === 1 };
}

export async function moveNote(params: { id: string; targetCollectionId: string }) {
	await db
		.update(collectionNotes)
		.set({ collectionId: params.targetCollectionId, updatedAt: new Date().toISOString() })
		.where(eq(collectionNotes.id, params.id));
	return { success: true };
}

// ---------------------------------------------------------------------------
// Trash lifecycle — isDeleted flag only; updatedAt doubles as the purge clock
// (see docs/collections-plan.md §3 for why there's no separate deletedAt column).
// ---------------------------------------------------------------------------

export async function softDeleteNote(params: { id: string }) {
	await db
		.update(collectionNotes)
		.set({ isDeleted: 1, updatedAt: new Date().toISOString() })
		.where(eq(collectionNotes.id, params.id));
	return { success: true };
}

export async function restoreNote(params: { id: string }) {
	await db
		.update(collectionNotes)
		.set({ isDeleted: 0, updatedAt: new Date().toISOString() })
		.where(eq(collectionNotes.id, params.id));
	return { success: true };
}

export async function permanentlyDeleteNote(params: { id: string }) {
	const attachmentRows = await db
		.select({ filePath: collectionNoteAttachments.filePath })
		.from(collectionNoteAttachments)
		.where(eq(collectionNoteAttachments.noteId, params.id));
	for (const a of attachmentRows) storage.deleteAttachmentFile(a.filePath);

	await db.delete(collectionNoteAttachments).where(eq(collectionNoteAttachments.noteId, params.id));
	// A note can be a link's source (its own [[wiki-links]]) or target (another
	// note links to it) — both reference this note's id via a FK, so both must
	// be cleared before the note row itself can be deleted.
	await db
		.delete(collectionNoteLinks)
		.where(or(eq(collectionNoteLinks.sourceNoteId, params.id), eq(collectionNoteLinks.targetNoteId, params.id)));
	await db.delete(collectionNotes).where(eq(collectionNotes.id, params.id));
	return { success: true };
}

export async function emptyTrash() {
	const trashed = await db
		.select({ id: collectionNotes.id })
		.from(collectionNotes)
		.where(eq(collectionNotes.isDeleted, 1));
	const ids = trashed.map((t) => t.id);
	if (ids.length > 0) {
		const attachmentRows = await db
			.select({ filePath: collectionNoteAttachments.filePath })
			.from(collectionNoteAttachments)
			.where(inArray(collectionNoteAttachments.noteId, ids));
		for (const a of attachmentRows) storage.deleteAttachmentFile(a.filePath);

		await db.delete(collectionNoteAttachments).where(inArray(collectionNoteAttachments.noteId, ids));
		await db
			.delete(collectionNoteLinks)
			.where(or(inArray(collectionNoteLinks.sourceNoteId, ids), inArray(collectionNoteLinks.targetNoteId, ids)));
		await db.delete(collectionNotes).where(inArray(collectionNotes.id, ids));
	}
	return { success: true, deletedCount: ids.length };
}

// ---------------------------------------------------------------------------
// Attachments (download-only — never inline-previewed)
// ---------------------------------------------------------------------------

export async function addAttachment(params: { noteId: string; sourcePath: string }) {
	const noteRows = await db
		.select({ id: collectionNotes.id })
		.from(collectionNotes)
		.where(eq(collectionNotes.id, params.noteId))
		.limit(1);
	if (!noteRows[0]) throw new Error("Note not found");

	const stored = storage.storeAttachment(params.noteId, params.sourcePath);
	const id = crypto.randomUUID();
	await db.insert(collectionNoteAttachments).values({
		id,
		noteId: params.noteId,
		fileName: stored.fileName,
		filePath: stored.relativePath,
		fileSize: stored.fileSize,
		mimeType: stored.mimeType,
	});

	const rows = await db
		.select()
		.from(collectionNoteAttachments)
		.where(eq(collectionNoteAttachments.id, id))
		.limit(1);
	return { success: true, attachment: toAttachmentDto(rows[0]) };
}

export async function removeAttachment(params: { id: string }) {
	const rows = await db
		.select({ filePath: collectionNoteAttachments.filePath })
		.from(collectionNoteAttachments)
		.where(eq(collectionNoteAttachments.id, params.id))
		.limit(1);
	if (!rows[0]) return { success: false };

	storage.deleteAttachmentFile(rows[0].filePath);
	await db.delete(collectionNoteAttachments).where(eq(collectionNoteAttachments.id, params.id));
	return { success: true };
}

// ---------------------------------------------------------------------------
// Save-to-Collection / Attach-as-context — Phase 4
// ---------------------------------------------------------------------------

type AttachPickerRawRow = {
	id: string;
	title: string;
	contentMarkdown: string;
	collectionName: string;
};

// Lightweight cross-collection search for the "Attach a note" picker
// (attach-note-modal.tsx). Mirrors searchCollectionNotes' FTS5-with-LIKE-fallback
// shape but returns collectionName instead of collectionId, and has no scope param
// since the picker always searches everywhere.
export async function listNotesForAttachPicker(params: {
	query?: string;
}): Promise<CollectionAttachPickerResultDto[]> {
	const query = params.query?.trim() ?? "";
	let rows: AttachPickerRawRow[];

	if (!query) {
		rows = sqlite
			.prepare(
				`SELECT cn.id AS id, cn.title AS title, cn.content_markdown AS contentMarkdown, c.name AS collectionName
				 FROM collection_notes cn
				 JOIN collections c ON c.id = cn.collection_id
				 WHERE cn.is_deleted = 0
				 ORDER BY cn.updated_at DESC
				 LIMIT 30`,
			)
			.all() as AttachPickerRawRow[];
	} else {
		try {
			const ftsQuery = query
				.split(/\s+/)
				.map((t) => `${t.replace(/"/g, '""')}*`)
				.join(" ");
			rows = sqlite
				.prepare(
					`SELECT cn.id AS id, cn.title AS title, cn.content_markdown AS contentMarkdown, c.name AS collectionName
					 FROM collection_notes cn
					 JOIN collection_notes_fts f ON cn.rowid = f.rowid
					 JOIN collections c ON c.id = cn.collection_id
					 WHERE collection_notes_fts MATCH ? AND cn.is_deleted = 0
					 ORDER BY rank
					 LIMIT 30`,
				)
				.all(ftsQuery) as AttachPickerRawRow[];
		} catch {
			const pattern = `%${query}%`;
			rows = sqlite
				.prepare(
					`SELECT cn.id AS id, cn.title AS title, cn.content_markdown AS contentMarkdown, c.name AS collectionName
					 FROM collection_notes cn
					 JOIN collections c ON c.id = cn.collection_id
					 WHERE (cn.title LIKE ? OR cn.content_markdown LIKE ?) AND cn.is_deleted = 0
					 ORDER BY cn.updated_at DESC
					 LIMIT 30`,
				)
				.all(pattern, pattern) as AttachPickerRawRow[];
		}
	}

	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		collectionName: r.collectionName,
		snippet: snippetFromMarkdown(r.contentMarkdown, 100),
	}));
}

export async function getNoteContentForContext(
	params: { id: string },
): Promise<{ title: string; contentMarkdown: string } | null> {
	const rows = await db
		.select({ title: collectionNotes.title, contentMarkdown: collectionNotes.contentMarkdown })
		.from(collectionNotes)
		.where(eq(collectionNotes.id, params.id))
		.limit(1);
	return rows[0] ?? null;
}

export async function getAttachmentDownloadPath(params: { id: string }) {
	const rows = await db
		.select({ filePath: collectionNoteAttachments.filePath })
		.from(collectionNoteAttachments)
		.where(eq(collectionNoteAttachments.id, params.id))
		.limit(1);
	if (!rows[0]) return null;
	return { filePath: storage.absoluteAttachmentPath(rows[0].filePath) };
}

// ---------------------------------------------------------------------------
// Backlinks — Phase 5 (src/bun/collections/links.ts owns parsing/resolution)
// ---------------------------------------------------------------------------

export async function getLinkedNotes(params: { id: string }): Promise<CollectionLinkedNoteDto[]> {
	return getLinkedNotesImpl(params.id);
}

export async function getBacklinks(params: { id: string }): Promise<CollectionLinkedNoteDto[]> {
	return getBacklinksImpl(params.id);
}

// ---------------------------------------------------------------------------
// Export — Phase 5 (src/bun/collections/export.ts owns file generation)
// ---------------------------------------------------------------------------

function toExportableNote(row: typeof collectionNotes.$inferSelect): ExportableNote {
	let sourceRef: unknown = null;
	if (row.sourceRef) {
		try {
			sourceRef = JSON.parse(row.sourceRef);
		} catch {
			sourceRef = null;
		}
	}
	return {
		title: row.title,
		contentMarkdown: row.contentMarkdown,
		tags: parseTags(row.tags),
		sourceType: row.sourceType,
		sourceRef,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function exportNote(
	params: { id: string; format: CollectionExportFormat },
): Promise<{ success: boolean; filePath: string }> {
	const rows = await db.select().from(collectionNotes).where(eq(collectionNotes.id, params.id)).limit(1);
	const row = rows[0];
	if (!row) return { success: false, filePath: "" };

	const filePath = await exportNoteToFile(toExportableNote(row), params.format);
	Utils.showItemInFolder(filePath);
	return { success: true, filePath };
}

export async function exportCollection(
	params: { id: string; format: CollectionExportFormat },
): Promise<{ success: boolean; filePath: string }> {
	const colRows = await db.select().from(collections).where(eq(collections.id, params.id)).limit(1);
	const collection = colRows[0];
	if (!collection) return { success: false, filePath: "" };

	const noteRows = await db
		.select()
		.from(collectionNotes)
		.where(and(eq(collectionNotes.collectionId, params.id), eq(collectionNotes.isDeleted, 0)));

	const filePath = await exportCollectionToFile(collection.name, noteRows.map(toExportableNote), params.format);
	Utils.showItemInFolder(filePath);
	return { success: true, filePath };
}

// ---------------------------------------------------------------------------
// Settings tab — attachment storage disclosure
// ---------------------------------------------------------------------------

export async function getAttachmentStorageInfo(): Promise<{ path: string; totalSizeBytes: number; fileCount: number }> {
	return storage.getStorageInfo();
}

export async function openAttachmentStorageFolder(): Promise<{ success: boolean }> {
	const path = storage.ensureCollectionsRoot();
	Utils.openPath(path);
	return { success: true };
}

export async function getEmbeddingModelStatus(): Promise<EmbeddingModelStatusDto> {
	const [status, lastIndexedAt] = await Promise.all([
		modelManager.getEmbeddingModelStatus(),
		getLastIndexedAt(),
	]);
	return { ...status, lastIndexedAt };
}

export async function downloadEmbeddingModel(): Promise<{ success: boolean }> {
	return modelManager.downloadEmbeddingModel();
}

export async function reindexNotes(): Promise<{ success: boolean; indexed: number }> {
	return reindexAll();
}
