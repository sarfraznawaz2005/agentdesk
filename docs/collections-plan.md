# Collections — Personal Knowledge Base (Plan)

> Status: **Planned, not started.** HTML mockup reviewed and approved
> (library / editor / chat / settings / save & attach modals / empty state /
> trash-undo). This document is the implementation plan derived from it.

---

## 1. Goal

A new top-level sidebar feature, independent of the project/kanban/review
system, where a user stores and organizes their own notes, research, and
reusable reference material — across every project, not scoped to one.

It is deliberately **separate** from the existing per-project `notes` table
(`src/bun/db/schema.ts:184`, surfaced in Activity → Docs, `notes-tab.tsx`).
That table is project documentation (agent- or user-authored docs about *this
build*). Collections is a personal, cross-project knowledge base — different
job, different lifecycle, own nav entry. No migration or shared schema
between the two.

---

## 2. Locked decisions

Recap of the choices made during scoping — treat these as constraints, not
suggestions, unless the user revisits them:

| Decision | Choice |
|---|---|
| Relationship to project Notes/Docs | Fully separate feature and schema |
| Note content format | **Markdown**, not rich text/contenteditable |
| Editing UX | Toolbar + Write/Preview/Live modes via an existing markdown-editor package |
| Embedding pipeline | Build a real local ONNX pipeline now (ReelForge only has the *interface*, not a working download/inference flow — ours must be the real thing) |
| Agent write access | **Human-only.** No `save_to_collection` tool for agents in v1 — saving is always a deliberate UI click |
| Collection nesting | **Flat.** Collection → Notes only, no sub-folders |
| Favorites | **Virtual smart view** — a star toggle on any note; the note stays in its real collection and also appears under Favorites. Not a literal folder notes get moved into |
| System collections | `Default` (real, undeletable) + `Favorites` (virtual, not a DB row) |
| Attach-as-context | Read-only: pull a saved note into a new chat as reference. Does not conflict with human-only writes |
| Auto-Earn integration | Save-to-Collection available on inbox drafts/replies with an explicit collection picker — no auto-feed into Auto-Earn's own drafting |

---

## 3. Data model

New tables in `src/bun/db/schema.ts`, migration **`v56_collections.ts`**
(latest today is v55). Indexes and the FTS5 virtual table are added via raw
SQL in the migration file, per this repo's convention (`schema.ts:211-213`).

```ts
// ---------------------------------------------------------------------------
// collections
// ---------------------------------------------------------------------------
export const collections = sqliteTable("collections", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  color: text("color").notNull(),           // one of the fixed accent hues
  icon: text("icon"),                        // optional lucide icon name
  isDefault: integer("is_default").notNull().default(0), // Default collection only; blocks delete
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// collection_notes
// ---------------------------------------------------------------------------
export const collectionNotes = sqliteTable("collection_notes", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  collectionId: text("collection_id").notNull().references(() => collections.id),
  title: text("title").notNull(),
  contentMarkdown: text("content_markdown").notNull().default(""),
  tags: text("tags").notNull().default("[]"),         // JSON string[]
  isFavorite: integer("is_favorite").notNull().default(0),
  isDeleted: integer("is_deleted").notNull().default(0), // Trash (soft delete)
  sourceType: text("source_type"),   // 'pm_chat' | 'council' | 'freelance_chat' | 'skills_chat' | 'freelance_inbox' | 'manual'
  sourceRef: text("source_ref"),     // JSON: { projectId?, projectName?, taskId? } — powers the provenance chip
  embedding: blob("embedding", { mode: "buffer" }),   // packed Float32Array, same convention as ReelForge
  embeddingModel: text("embedding_model"),             // e.g. "all-MiniLM-L6-v2:384" — lets re-index detect staleness
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`), // also used as the Trash purge clock
});

// ---------------------------------------------------------------------------
// collection_note_attachments
// ---------------------------------------------------------------------------
export const collectionNoteAttachments = sqliteTable("collection_note_attachments", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  noteId: text("note_id").notNull().references(() => collectionNotes.id),
  fileName: text("file_name").notNull(),
  filePath: text("file_path").notNull(),  // relative path under the collections storage dir
  fileSize: integer("file_size").notNull(),
  mimeType: text("mime_type"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// collection_note_links — resolved [[wiki-links]] between notes (backlinks)
// ---------------------------------------------------------------------------
export const collectionNoteLinks = sqliteTable("collection_note_links", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sourceNoteId: text("source_note_id").notNull().references(() => collectionNotes.id),
  targetNoteId: text("target_note_id").notNull().references(() => collectionNotes.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

**Migration `v56` also adds (raw SQL, matching `v50_freelance-listings-indexes.ts` style):**
- Indexes: `collection_notes(collection_id)`, `collection_notes(is_deleted)`,
  `collection_note_attachments(note_id)`,
  `collection_note_links(source_note_id)`, `collection_note_links(target_note_id)`.
- `collection_notes_fts` FTS5 virtual table over `title` + `content_markdown`,
  kept in sync via triggers — same pattern as `notes_fts`
  (`src/bun/rpc/notes.ts:114-135`).
- Seeds the `Default` collection (`isDefault = 1`) so it always exists,
  mirroring how `agent-tools`/roster rows are seeded in `db/seed.ts`.

**Trash purge:** no separate `deletedAt` column — reuses `updatedAt` (which a
delete action bumps) to compute the 30-day window, keeping the plain
`isDeleted` flag convention already used elsewhere (`freelanceListings.isDeleted`,
`schema.ts:743`) instead of introducing a second timestamp column.

**Favorites is not a table.** `listNotes({ collectionId: "favorites" })` is a
query across all collections filtered on `isFavorite = 1` — no schema
footprint.

---

## 4. RPC surface

`src/shared/rpc/collections.ts` (contract) → `src/bun/rpc/collections.ts`
(handlers, Drizzle) → new `src/bun/rpc-groups/collections.ts` → one import +
one spread line in `src/bun/remote/rpc-handlers.ts` → merged into
`AgentDeskRPC` in `src/shared/rpc/index.ts`. Same five-step pattern as Notes
(`docs` research already traced this end-to-end).

| Method | Purpose |
|---|---|
| `listCollections()` | Rail contents incl. per-collection note counts |
| `createCollection` / `renameCollection` / `recolorCollection` | CRUD, `isDefault` blocks rename-away-from-protected-status but not rename-of-name |
| `reorderCollections({ orderedIds })` | Drag-and-drop rail order |
| `deleteCollection({ id })` | Rejected for `isDefault`; non-empty collections require confirming — notes move to `Default`, never silently deleted |
| `listNotes({ collectionId \| "favorites" \| "trash", query?, tags?, sort? })` | Note list pane |
| `getNote` / `createNote` / `updateNote` | Editor CRUD |
| `toggleFavorite({ id })` | Favorites virtual view |
| `moveNote({ id, targetCollectionId })` | Move-across-collections |
| `softDeleteNote` / `restoreNote` / `permanentlyDeleteNote` / `emptyTrash` | Trash lifecycle + Undo |
| `searchNotes({ query, scope })` | FTS5 keyword search (the search box) |
| `chatWithCollections({ query, scope, history })` | Embedding-based retrieval + cited answer (the chat FAB) |
| `exportNote({ id, format })` / `exportCollection({ id, format })` | Markdown / PDF / JSON |
| `addAttachment` / `removeAttachment` / `getAttachmentDownloadPath` | File attachments (download-only, never previewed) |
| `getLinkedNotes` / `getBacklinks` | Backlinks panel |
| `saveToCollection({ collectionId, title, contentMarkdown, sourceType, sourceRef })` | Shared handler behind every "Save to Collection" icon |
| `listNotesForAttachPicker({ query })` / `getNoteContentForContext({ id })` | Attach-note-as-context |
| `getEmbeddingModelStatus()` / `downloadEmbeddingModel()` / `reindexNotes()` | Settings tab, model lifecycle |

---

## 5. Frontend structure

Mirrors the Freelance pattern (`freelance.tsx` thin tab shell +
`components/freelance/*`), not the single-file Playground pattern, since
Collections has real per-domain sub-components.

```
src/mainview/
├── pages/collections.tsx                  # Tab shell: Library / Settings
├── components/collections/
│   ├── collections-rail.tsx               # Left pane: Default/Favorites + custom, + New popover
│   ├── note-list.tsx                      # Middle pane: search/sort/tag-filter/cards
│   ├── note-editor.tsx                    # Right pane: markdown editor + actions + attachments + backlinks
│   ├── save-to-collection-modal.tsx       # Shared — imported from chat components
│   ├── attach-note-modal.tsx              # Shared — imported from chat-input
│   ├── chat-fab.tsx + chat-panel.tsx      # "Ask your Collections"
│   ├── settings-tab.tsx
│   └── new-collection-popover.tsx
└── stores/collections-store.ts            # zustand: selected collection/note id, list cache, model status
```

Backend:
```
src/bun/collections/
├── storage.ts       # attachment read/write under Utils.paths.userData/collections/<noteId>/, safeDest-sanitized (mirrors freelance/expert/tools.ts:252-278)
├── export.ts         # markdown/PDF/JSON export
├── links.ts           # [[wiki-link]] parsing + resolution into collection_note_links
├── embeddings/
│   ├── model-manager.ts   # download/verify/status, progress events
│   ├── embedder.ts         # load ONNX model, generate embeddings
│   └── similarity.ts       # cosine, brute-force search over the BLOB column
└── chat.ts            # retrieval + prompt composition for chatWithCollections
```

**Sidebar:** add one entry to `BASE_NAV_ITEMS` in
`src/mainview/components/layout/sidebar.tsx:57-68` (a static entry is enough —
no feature flag needed, unlike Freelance). Suggested icon: `BookMarked` or
`NotebookText` (lucide-react) — pick whichever reads more like "saved
knowledge" vs. the existing `BookOpen` already used for Prompts.

**Route:** `src/mainview/router.tsx` — `createRoute({ path: "/collections",
component: CollectionsPage })`, added to `rootRoute.addChildren([...])`.

---

## 6. Markdown editing

Package: **`@uiw/react-md-editor`** — actively maintained, MIT, and already
aligned with this repo's stack: it's built on `remark`/`rehype` under the
hood, same family as the `react-markdown` + `remark-gfm` + `rehype-sanitize`
already in `package.json` (used today by `notes-tab.tsx`). Add as a new
dependency.

- **Modes:** `preview="live"` by default (split source/rendered — what the
  mockup shows), with `write`/`preview` also available via the same
  three-way switch. Matches the library's native `preview` prop values.
- **Toolbar:** trimmed to the commands the mockup shows — bold, italic,
  strikethrough, heading, quote, inline code, bulleted/numbered/task list,
  table, link. The library's default toolbar has more (fullscreen, HR,
  comment) — pass a custom `commands` array to drop anything not in the
  approved set.
- **Attachment button is custom, not the library's default image command.**
  Files are download-only and never inline-previewed (per the original
  spec), so wiring the toolbar's image slot to raw `![]()` markdown would be
  wrong. Instead: a custom `ICommand` that opens the OS file picker →calls
  `addAttachment` → inserts a small reference marker (not a markdown image)
  that the note renderer turns back into the attachment chip.
- **Theme:** `data-color-mode` prop driven off the same source the app's own
  `.dark` class toggle reads from, so the editor never disagrees with the
  rest of the UI.
- **Storage:** `contentMarkdown` is the raw GFM markdown string, stored as-is
  in `collection_notes.content_markdown` — no HTML, no ProseMirror/Tiptap
  JSON. Note-card list previews strip markdown syntax client-side for the
  2-line excerpt.

---

## 7. Embedding & local chat pipeline

Grounded in the ReelForge research: it has the *interface* and *storage
shape*, not a working download/inference pipeline — that has to be built
here from scratch.

- **Model:** `sentence-transformers/all-MiniLM-L6-v2`, 384 dimensions,
  ~90 MB, standard Transformers.js/HF-ONNX layout (`model.onnx` +
  `config.json` + `tokenizer.json` + `tokenizer_config.json` +
  `special_tokens_map.json` + `vocab.txt`).
- **Runtime:** `@huggingface/transformers` (the maintained successor to
  `@xenova/transformers`, same API) — pure-JS ONNX inference, no native
  bindings to compile, runs under Bun. **Flag as a spike item** (§10): Bun
  compatibility with its `onnxruntime-node` backend hasn't been verified in
  this codebase yet and should be a day-one smoke test, not an assumption.
- **Download flow:** Settings → "Download model" fetches the HF repo files
  into `Utils.paths.userData/collections/embed-model/`, with progress
  reported back to the Settings tab (reuse whatever progress-streaming
  pattern an existing long download in this codebase already uses — e.g.
  skill installs — rather than inventing a new one).
- **Storage:** pack each note's embedding as a little-endian `Float32Array`
  buffer into `collection_notes.embedding` (BLOB) — identical approach to
  ReelForge's `packVector`/`unpackVector`. `embedding_model` records which
  model produced it so a future model change can detect and trigger
  re-indexing.
- **Retrieval:** brute-force cosine similarity in JS over the notes in
  scope (all collections, or one, per the chat panel's scope switch). No
  ANN index (`sqlite-vec` etc.) for v1 — reasonable at the scale a personal
  notes app actually reaches; revisit only if it becomes a real bottleneck.
- **Indexing trigger:** on note create/update, re-embed in the background
  (debounced) so search/chat stay current without a manual step; "Re-index
  notes" in Settings is the manual fallback (e.g. after a model change).
- **Gating:** the chat FAB and Settings' chat scope are disabled/greyed
  with a "Download the embedding model to start chatting" prompt whenever
  `getEmbeddingModelStatus()` isn't `ready` — exactly the mockup's toggle
  behavior.
- **Chat generation:** `chatWithCollections` embeds the query, retrieves
  top-k notes by cosine similarity, and calls the user's already-configured
  AI provider (via `src/bun/providers/`) with the retrieved note content as
  context, returning an answer plus the source note ids for the citation
  chips. No new provider/credential surface — reuses what's already wired
  for chat elsewhere in the app.

---

## 8. "Save to Collection" and "Attach as context" — integration points

Traced against the actual component tree, not assumed:

- **`src/mainview/components/chat/message-bubble.tsx:748-783`** — the
  existing hover action row (Copy → Retry → Fork → Delete). Add the
  Save-to-Collection icon here, next to Copy. `MessageBubble` is shared by
  **four** surfaces already (confirmed via usage search): main project chat
  (`message-list.tsx`), `council.tsx`, `freelance-chat-modal.tsx`, and
  `skills-search-chat-modal.tsx` — one change point covers all four.
- **`src/mainview/components/freelance/inbox-tab.tsx`** — the outbox/drafts
  queue item (~line 1035-1067) and the sent-reply viewer modal
  (~line 1190-1216) already have a Copy icon to mirror; add Save-to-Collection
  alongside it. This is the concrete path for the approved "Auto-Earn
  proposal templates" use case — clicking it opens the same
  `save-to-collection-modal.tsx` with the collection picker, no special-cased
  UI for Auto-Earn.
- **Chat input attach flow** (`src/mainview/components/chat/chat-input.tsx`,
  `processFiles()` ~line 113) — add an "Attach a note" entry alongside the
  existing file-attach affordance, opening `attach-note-modal.tsx`. Selected
  note content is fetched via `getNoteContentForContext` and inlined into
  the outgoing message exactly like a regular file attachment is today — no
  new attachment plumbing on the chat side.
- **Playground is out of scope** — it doesn't use `MessageBubble` and is
  explicitly decoupled from the rest of the app's chat surfaces.

---

## 9. Search, sort, filter

- **Note list search box** → `searchNotes` (FTS5 over
  `collection_notes_fts`, LIKE fallback — same pattern as
  `searchNotes` in `bun/rpc/notes.ts:114-135`). Fast, exact, works with zero
  embedding model.
- **Sort:** Last updated (default) / Created / Title A–Z / Favorites first.
- **Filter:** tag chips derived from the union of tags in the active
  collection (client-computed from the loaded note list, no separate tags
  table needed for v1).
- **Global search** (`page-topbar` search box) runs the same `searchNotes`
  with `scope: "all"` instead of one collection.

---

## 10. Non-goals for v1 (explicitly deferred)

- Agents writing to Collections autonomously (locked decision — human-only).
- Nested sub-collections (locked decision — flat only).
- `sqlite-vec` / ANN indexing — brute-force cosine is the v1 retrieval
  strategy; only revisit if corpus size makes it a measured problem.
- Collaboration/sharing — this is a local, single-user store like the rest
  of AgentDesk's data.
- Inline attachment preview — attachments remain download-only per the
  original spec.

---

## 11. Open risks to validate early (spikes before full build-out)

1. **`@huggingface/transformers` under Bun** — confirm the ONNX runtime
   backend loads and runs inference inside Bun's runtime (not just Node),
   before committing the embedding architecture. This is the single
   highest-uncertainty item in the whole plan.
2. **Model download size/UX** — ~90 MB on first use; confirm the
   progress-reporting pattern this codebase already uses elsewhere for long
   downloads, so Settings doesn't invent a new one.
3. **`@uiw/react-md-editor` bundle weight** inside an Electrobun/Vite build —
   sanity-check it doesn't meaningfully move startup time given the app's
   existing performance envelope.

---

## 12. Suggested build order

1. Schema + migration v56, RPC scaffolding (CRUD only, no embeddings/markdown editor yet) — prove the data layer and the sidebar/page/route wiring end to end.
2. Markdown editor integration (`@uiw/react-md-editor`, custom attachment command) + attachment storage.
3. Favorites, Trash + Undo, tags, sort/filter, search (FTS5).
4. Save-to-Collection + Attach-as-context integration points (§8).
5. Export (Markdown/PDF/JSON), backlinks ([[links]] parsing + panel).
6. Embedding pipeline spike (§11.1) → model download/settings → indexing → chat FAB.
7. Polish pass: empty states, confirmations, drag-and-drop reorder (`@dnd-kit`, already a dependency — reuse rather than adding a new DnD library).
