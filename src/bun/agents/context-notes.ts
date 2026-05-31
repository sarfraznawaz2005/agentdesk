import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { notes, projects } from "../db/schema";

// ---------------------------------------------------------------------------
// Auto-sync workspace context files as project notes
//
// Detects README.md, CLAUDE.md, and AGENTS.md in the project workspace and
// creates/updates them as project notes so agents can reference them via
// list_docs / get_doc during work.
// ---------------------------------------------------------------------------

const CONTEXT_FILES = ["README.md", "CLAUDE.md", "AGENTS.md"] as const;

const NOTE_TITLE_PREFIX = "Context: ";

/**
 * Syncs workspace context files as project notes.
 *
 * - Creates a note titled "Context: README.md" (etc.) if the file exists and
 *   no note with that title exists yet.
 * - Updates existing notes if the file content has changed.
 * - Skips files that don't exist or are empty.
 *
 * Safe to call multiple times — idempotent.
 */
export async function syncContextFilesAsNotes(projectId: string): Promise<void> {
	// Look up the workspace path
	const rows = await db
		.select({ workspacePath: projects.workspacePath })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	const workspacePath = rows[0]?.workspacePath;
	if (!workspacePath) return;

	for (const filename of CONTEXT_FILES) {
		const filePath = join(workspacePath, filename);

		// Check if file exists and has content
		if (!existsSync(filePath)) continue;
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8").trim();
		} catch {
			continue;
		}
		if (!content) continue;

		const title = NOTE_TITLE_PREFIX + filename;

		// Check if a note with this title already exists for this project
		const existing = await db
			.select({ id: notes.id, content: notes.content })
			.from(notes)
			.where(and(eq(notes.projectId, projectId), eq(notes.title, title)))
			.limit(1);

		if (existing.length > 0) {
			// Update only if content changed
			if (existing[0].content !== content) {
				await db
					.update(notes)
					.set({ content, updatedAt: new Date().toISOString() })
					.where(eq(notes.id, existing[0].id));
			}
		} else {
			// Create new note
			await db.insert(notes).values({
				id: crypto.randomUUID(),
				projectId,
				title,
				content,
				authorAgentId: null,
			});
		}
	}
}
