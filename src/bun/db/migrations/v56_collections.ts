import { sqlite } from "../connection";

export const name = "collections";

// Personal, cross-project knowledge base — see docs/collections-plan.md.
// Drizzle-managed tables (schema.ts: collections, collectionNotes,
// collectionNoteAttachments, collectionNoteLinks). The CREATEs here keep the
// raw migration runner and the Drizzle schema in lock-step, matching the
// v52 (model_preferences) precedent — idempotent via IF NOT EXISTS, safe on
// both fresh and existing databases.
//
// collection_notes_fts is an external-content FTS5 table over collection_notes
// (title, content_markdown), mirroring the notes_fts pattern from
// v1_initial-schema.ts exactly (sync triggers, not a backing content table).
//
// Seeds exactly one "Default" collection (is_default = 1), guarded by a count
// check rather than a fixed id, consistent with this codebase's random-UUID
// id convention (see v42_request-human-input-backfill.ts for the same
// prepare-guard-insert shape).
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS collections (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL,
  icon         TEXT,
  is_default   INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collection_notes (
  id                TEXT PRIMARY KEY,
  collection_id     TEXT NOT NULL REFERENCES collections(id),
  title             TEXT NOT NULL,
  content_markdown  TEXT NOT NULL DEFAULT '',
  tags              TEXT NOT NULL DEFAULT '[]',
  is_favorite       INTEGER NOT NULL DEFAULT 0,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  source_type       TEXT,
  source_ref        TEXT,
  embedding         BLOB,
  embedding_model   TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collection_note_attachments (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES collection_notes(id),
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  file_size   INTEGER NOT NULL,
  mime_type   TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collection_note_links (
  id              TEXT PRIMARY KEY,
  source_note_id  TEXT NOT NULL REFERENCES collection_notes(id),
  target_note_id  TEXT NOT NULL REFERENCES collection_notes(id),
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_collection_notes_collection_id
  ON collection_notes(collection_id);
CREATE INDEX IF NOT EXISTS idx_collection_notes_is_deleted
  ON collection_notes(is_deleted);
CREATE INDEX IF NOT EXISTS idx_collection_note_attachments_note_id
  ON collection_note_attachments(note_id);
CREATE INDEX IF NOT EXISTS idx_collection_note_links_source_note_id
  ON collection_note_links(source_note_id);
CREATE INDEX IF NOT EXISTS idx_collection_note_links_target_note_id
  ON collection_note_links(target_note_id);
`);

	// External-content FTS5 index over collection_notes — same shape as
	// notes_fts (v1_initial-schema.ts:525-542): column names must match the
	// source table exactly for the content='collection_notes' linkage to work.
	sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS collection_notes_fts USING fts5(
		title, content_markdown, collection_id UNINDEXED,
		content='collection_notes', content_rowid='rowid'
	)`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS collection_notes_fts_ai AFTER INSERT ON collection_notes BEGIN
		INSERT INTO collection_notes_fts(rowid, title, content_markdown, collection_id)
		VALUES (NEW.rowid, NEW.title, NEW.content_markdown, NEW.collection_id);
	END`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS collection_notes_fts_ad AFTER DELETE ON collection_notes BEGIN
		INSERT INTO collection_notes_fts(collection_notes_fts, rowid, title, content_markdown, collection_id)
		VALUES ('delete', OLD.rowid, OLD.title, OLD.content_markdown, OLD.collection_id);
	END`);
	sqlite.exec(`CREATE TRIGGER IF NOT EXISTS collection_notes_fts_au AFTER UPDATE ON collection_notes BEGIN
		INSERT INTO collection_notes_fts(collection_notes_fts, rowid, title, content_markdown, collection_id)
		VALUES ('delete', OLD.rowid, OLD.title, OLD.content_markdown, OLD.collection_id);
		INSERT INTO collection_notes_fts(rowid, title, content_markdown, collection_id)
		VALUES (NEW.rowid, NEW.title, NEW.content_markdown, NEW.collection_id);
	END`);

	// Seed the single Default collection, once.
	const existing = sqlite
		.prepare("SELECT COUNT(*) as n FROM collections WHERE is_default = 1")
		.get() as { n: number };
	if (existing.n === 0) {
		sqlite
			.prepare(
				"INSERT INTO collections (id, name, color, is_default, sort_order) VALUES (?, 'Default', 'slate', 1, 0)",
			)
			.run(crypto.randomUUID());
	}
}
