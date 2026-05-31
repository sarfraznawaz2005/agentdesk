import { eq, desc } from "drizzle-orm";
import { readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { notes, projects } from "../db/schema";

export async function getProjectNotes(projectId: string) {
	return db
		.select()
		.from(notes)
		.where(eq(notes.projectId, projectId))
		.orderBy(desc(notes.updatedAt));
}

export async function getNote(id: string) {
	const rows = await db
		.select()
		.from(notes)
		.where(eq(notes.id, id))
		.limit(1);

	return rows.length > 0 ? rows[0] : null;
}

export async function createNote(params: {
	projectId: string;
	title: string;
	content: string;
	authorAgentId?: string;
}) {
	const id = crypto.randomUUID();
	await db.insert(notes).values({
		id,
		projectId: params.projectId,
		title: params.title,
		content: params.content,
		authorAgentId: params.authorAgentId ?? null,
	});
	return { success: true, id };
}

export async function updateNote(params: {
	id: string;
	title?: string;
	content?: string;
}) {
	const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
	if (params.title !== undefined) updates.title = params.title;
	if (params.content !== undefined) updates.content = params.content;
	await db.update(notes).set(updates).where(eq(notes.id, params.id));
	return { success: true };
}

export async function deleteNote(id: string) {
	await db.delete(notes).where(eq(notes.id, id));
	return { success: true };
}

export async function getWorkspacePlans(projectId: string): Promise<
	Array<{ title: string; content: string; path: string; updatedAt: string }>
> {
	const rows = await db
		.select({ workspacePath: projects.workspacePath })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	if (!rows[0]?.workspacePath) return [];

	const plansDir = join(rows[0].workspacePath, "plans");

	let entries: string[];
	try {
		entries = readdirSync(plansDir).filter((f) => f.endsWith(".md"));
	} catch {
		// Directory doesn't exist yet — no plans created
		return [];
	}

	return entries
		.map((filename) => {
			const filePath = join(plansDir, filename);
			try {
				const content = readFileSync(filePath, "utf8");
				const stat = statSync(filePath);
				// Derive a human-friendly title from filename (strip .md, replace dashes/underscores)
				const title = basename(filename, ".md")
					.replace(/[-_]+/g, " ")
					.replace(/\b\w/g, (c) => c.toUpperCase());
				return {
					title,
					content,
					path: filePath,
					updatedAt: stat.mtime.toISOString(),
				};
			} catch {
				return null;
			}
		})
		.filter((p): p is NonNullable<typeof p> => p !== null)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteWorkspacePlan(path: string): Promise<{ success: boolean }> {
	try {
		unlinkSync(path);
		return { success: true };
	} catch {
		return { success: false };
	}
}

export async function searchNotes(projectId: string, query: string) {
	if (!query.trim()) {
		return db.select().from(notes).where(eq(notes.projectId, projectId)).orderBy(desc(notes.updatedAt));
	}
	// Use FTS5 for fast full-text search with prefix matching, fall back to LIKE
	// Append * to each token so partial words match (e.g. "implem" → "implem*" matches "implementation")
	const ftsQuery = query.trim().split(/\s+/).map((t) => `${t}*`).join(" ");
	try {
		return sqlite.prepare(
			`SELECT n.* FROM notes n
			 JOIN notes_fts f ON n.rowid = f.rowid
			 WHERE notes_fts MATCH ?2 AND f.project_id = ?1
			 ORDER BY rank
			 LIMIT 50`
		).all(projectId, ftsQuery) as Array<typeof notes.$inferSelect>;
	} catch {
		const pattern = `%${query}%`;
		return sqlite.prepare(
			`SELECT * FROM notes WHERE project_id = ?1 AND (title LIKE ?2 OR content LIKE ?2) ORDER BY updated_at DESC LIMIT 50`
		).all(projectId, pattern) as Array<typeof notes.$inferSelect>;
	}
}
