import { sqlite } from "../db/connection";

export interface SearchResult {
	type: "project" | "conversation" | "task" | "doc";
	id: string;
	title: string;
	description: string;
	projectId?: string;
}

/**
 * Global search using FTS5 where available, with LIKE fallback.
 * Capped at 20 total results.
 */
export async function globalSearch(query: string): Promise<SearchResult[]> {
	if (!query.trim()) return [];
	const pattern = `%${query}%`;
	const results: SearchResult[] = [];

	// Search projects (small table, LIKE is fine)
	const projectRows = sqlite.prepare(
		`SELECT id, name, description FROM projects
		 WHERE name LIKE ?1 OR description LIKE ?1
		 LIMIT 5`
	).all(pattern) as Array<{ id: string; name: string; description: string | null }>;
	for (const p of projectRows) {
		results.push({ type: "project", id: p.id, title: p.name, description: p.description ?? "" });
	}

	// Search conversations by title (small table, LIKE is fine)
	const convRows = sqlite.prepare(
		`SELECT id, project_id, title FROM conversations
		 WHERE title LIKE ?1
		 LIMIT 5`
	).all(pattern) as Array<{ id: string; project_id: string; title: string }>;
	for (const c of convRows) {
		results.push({ type: "conversation", id: c.id, title: c.title, description: "", projectId: c.project_id });
	}

	// Search kanban tasks (small table, LIKE is fine)
	const taskRows = sqlite.prepare(
		`SELECT id, project_id, title, description FROM kanban_tasks
		 WHERE title LIKE ?1 OR description LIKE ?1
		 LIMIT 5`
	).all(pattern) as Array<{ id: string; project_id: string; title: string; description: string | null }>;
	for (const t of taskRows) {
		results.push({ type: "task", id: t.id, title: t.title, description: t.description ?? "", projectId: t.project_id });
	}

	// Search notes via FTS5 (can grow large)
	try {
		const noteRows = sqlite.prepare(
			`SELECT n.id, n.project_id, n.title FROM notes n
			 JOIN notes_fts f ON n.rowid = f.rowid
			 WHERE notes_fts MATCH ?1
			 ORDER BY rank LIMIT 5`
		).all(query) as Array<{ id: string; project_id: string; title: string }>;
		for (const n of noteRows) {
			results.push({ type: "doc", id: n.id, title: n.title, description: "", projectId: n.project_id });
		}
	} catch {
		const noteRows = sqlite.prepare(
			`SELECT id, project_id, title FROM notes
			 WHERE title LIKE ?1 OR content LIKE ?1
			 LIMIT 5`
		).all(pattern) as Array<{ id: string; project_id: string; title: string }>;
		for (const n of noteRows) {
			results.push({ type: "doc", id: n.id, title: n.title, description: "", projectId: n.project_id });
		}
	}

	return results.slice(0, 20);
}
