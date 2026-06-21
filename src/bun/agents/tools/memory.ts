import { tool } from "ai";
import { z } from "zod";
import { and, eq, asc, desc, or, like, sql } from "drizzle-orm";
import { db } from "../../db";
import { agentMemories } from "../../db/schema";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// Agent memory — per (agent + project) durable store
//
// Two-tier "hybrid" recall (mirrors how Claude Code memory works):
//   - an always-on INDEX (title + description, one line each) is injected into
//     the agent's system prompt every run via buildMemoryIndexSection(), so a
//     fresh/stateless agent knows what it has saved;
//   - full bodies are pulled on demand by recall_memory.
//
// Distinct from log_decision (architectural decisions → DECISIONS.md, project-
// wide) and create_doc/notes (project documents). Memory = this agent's own
// learnings + things the USER explicitly asked it to remember.
// ---------------------------------------------------------------------------

// Size guards — keep the always-on index cost bounded and prevent unbounded
// growth without relying on agent self-discipline.
const MAX_CONTENT_CHARS = 2000; // a memory is a fact, not a document
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 200;
const SOFT_CAP = 50; // warn the agent to consolidate beyond this
const HARD_CAP = 100; // never exceed — evict the coldest (LRU) on new inserts
const INDEX_LIMIT = 30; // most-recent memories listed in the always-on index
const RECALL_LIMIT = 5; // full bodies returned per recall_memory call

export interface MemoryRow {
	id: string;
	title: string;
	description: string;
	content: string;
	recallCount: number;
	lastRecalledAt: string | null;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------

function scope(projectId: string, agentName: string) {
	return and(eq(agentMemories.projectId, projectId), eq(agentMemories.agentName, agentName));
}

async function countMemories(projectId: string, agentName: string): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)` })
		.from(agentMemories)
		.where(scope(projectId, agentName));
	return rows[0]?.n ?? 0;
}

/**
 * Evict the single coldest memory (least recalled, then oldest) so a new insert
 * stays within HARD_CAP. Called only when at/over the cap.
 */
async function evictColdest(projectId: string, agentName: string): Promise<void> {
	const victim = await db
		.select({ id: agentMemories.id })
		.from(agentMemories)
		.where(scope(projectId, agentName))
		// NULL last_recalled_at (never recalled) sorts first → evicted first.
		.orderBy(asc(agentMemories.lastRecalledAt), asc(agentMemories.createdAt))
		.limit(1);
	if (victim.length > 0) {
		await db.delete(agentMemories).where(eq(agentMemories.id, victim[0].id));
	}
}

/**
 * The always-on memory index for a scope: the INDEX_LIMIT most-recently-updated
 * memories (title + description only) plus the total count. Used by both the
 * prompt-injection and the recall tool's "no query" listing.
 */
export async function getMemoryIndex(
	projectId: string,
	agentName: string,
): Promise<{ total: number; items: Array<{ title: string; description: string }> }> {
	const total = await countMemories(projectId, agentName);
	if (total === 0) return { total: 0, items: [] };
	const rows = await db
		.select({ title: agentMemories.title, description: agentMemories.description })
		.from(agentMemories)
		.where(scope(projectId, agentName))
		.orderBy(desc(agentMemories.updatedAt))
		.limit(INDEX_LIMIT);
	return { total, items: rows };
}

/**
 * Builds the "## Your Memory" system-prompt section for an agent, or "" when the
 * agent has no memories. Injected by getAgentSystemPrompt every run.
 */
export async function buildMemoryIndexSection(
	agentName: string | undefined,
	projectId: string | undefined,
): Promise<string> {
	if (!agentName || !projectId) return "";
	let index: { total: number; items: Array<{ title: string; description: string }> };
	try {
		index = await getMemoryIndex(projectId, agentName);
	} catch {
		return "";
	}
	if (index.total === 0) return "";

	const lines = index.items.map((m) =>
		m.description ? `- **${m.title}** — ${m.description}` : `- **${m.title}**`,
	);
	const more = index.total > index.items.length ? `\n- …and ${index.total - index.items.length} more` : "";

	return (
		"## Your Memory\n\n" +
		"These are things you previously saved to memory for this project (your own learnings " +
		"and things the user asked you to remember). This is an **index** — use the `recall_memory` " +
		"tool to read the full content of any that look relevant before acting. " +
		"Save new ones with `save_memory`.\n\n" +
		"> Not the same as **Architectural Decisions** (DECISIONS.md, shared by all agents) or " +
		"project **docs**. Memory is personal to you: durable preferences, gotchas, and explicit " +
		'user "remember this" requests.\n\n' +
		lines.join("\n") +
		more +
		`\n\n(${index.total} ${index.total === 1 ? "memory" : "memories"} saved.)`
	);
}

// ---------------------------------------------------------------------------
// Tools (identity + project bound per run by the agent-loop overlay)
// ---------------------------------------------------------------------------

/**
 * Creates the real save/recall/delete memory tools bound to a specific agent +
 * project. The agent-loop overlays these over the registry stubs once it has the
 * projectId in scope (see agent-loop.ts), the same way DECISIONS / tracked file
 * tools are bound per run.
 */
export function createMemoryTools(agentName: string, projectId: string): Record<string, ToolRegistryEntry> {
	return {
		save_memory: {
			category: "memory",
			tool: tool({
				description:
					"Save a durable memory for yourself in THIS project — something worth remembering " +
					"across future runs: a user preference, a gotcha you hit, a fact the user explicitly " +
					"asked you to remember, or a hard-won learning. A compact index of your memories is " +
					"shown to you automatically every run; use recall_memory to read full content. " +
					"Re-saving the same title UPDATES that memory in place. " +
					"NOTE: this is NOT for architectural/design decisions other agents must follow — use " +
					"log_decision for those. Keep each memory to a single concise fact (max ~2000 chars).",
				inputSchema: z.object({
					title: z.string().describe("Short, unique title for this memory, e.g. 'User prefers tabs over spaces'"),
					content: z.string().describe("The fact to remember, in full. One concise fact — not a document."),
					description: z
						.string()
						.optional()
						.describe("One-line hook shown in your always-on memory index (helps you decide when to recall it)"),
				}),
				execute: async ({ title, content, description }) => {
					try {
						const cleanTitle = title.trim().slice(0, MAX_TITLE_CHARS);
						if (!cleanTitle) return JSON.stringify({ success: false, error: "title is required" });
						let storedContent = content;
						let truncated = false;
						if (storedContent.length > MAX_CONTENT_CHARS) {
							storedContent = storedContent.slice(0, MAX_CONTENT_CHARS);
							truncated = true;
						}
						const cleanDescription = (description ?? "").trim().slice(0, MAX_DESCRIPTION_CHARS);

						// Dedup by title within scope → update in place.
						const existing = await db
							.select({ id: agentMemories.id })
							.from(agentMemories)
							.where(and(scope(projectId, agentName), eq(agentMemories.title, cleanTitle)))
							.limit(1);

						let updated = false;
						if (existing.length > 0) {
							await db
								.update(agentMemories)
								.set({ content: storedContent, description: cleanDescription, updatedAt: sql`CURRENT_TIMESTAMP` })
								.where(eq(agentMemories.id, existing[0].id));
							updated = true;
						} else {
							// Enforce the hard cap by evicting the coldest memory first.
							const count = await countMemories(projectId, agentName);
							if (count >= HARD_CAP) await evictColdest(projectId, agentName);
							await db.insert(agentMemories).values({
								projectId,
								agentName,
								title: cleanTitle,
								description: cleanDescription,
								content: storedContent,
							});
						}

						const total = await countMemories(projectId, agentName);
						const warnings: string[] = [];
						if (truncated) warnings.push(`content was truncated to ${MAX_CONTENT_CHARS} chars — keep memories to a single fact`);
						if (total > SOFT_CAP) warnings.push(`you now have ${total} memories (soft limit ${SOFT_CAP}); consider delete_memory to consolidate stale ones`);

						return JSON.stringify({
							success: true,
							action: updated ? "updated" : "saved",
							title: cleanTitle,
							total,
							...(warnings.length ? { warnings } : {}),
						});
					} catch (err) {
						return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
					}
				},
			}),
		},

		recall_memory: {
			category: "memory",
			tool: tool({
				description:
					"Recall your saved memories for THIS project. Pass a query to search your memories by " +
					"keyword (title, description, or content) and get the full content of the best matches; " +
					"omit the query to list your most recent memories. Use this when the index in your prompt " +
					"shows a memory that looks relevant to the current task.",
				inputSchema: z.object({
					query: z
						.string()
						.optional()
						.describe("Keywords to search your memories for. Omit to list your most recent memories."),
				}),
				execute: async ({ query }) => {
					try {
						const q = (query ?? "").trim();
						let rows: MemoryRow[];
						if (q) {
							const needle = `%${q}%`;
							rows = await db
								.select({
									id: agentMemories.id,
									title: agentMemories.title,
									description: agentMemories.description,
									content: agentMemories.content,
									recallCount: agentMemories.recallCount,
									lastRecalledAt: agentMemories.lastRecalledAt,
									updatedAt: agentMemories.updatedAt,
								})
								.from(agentMemories)
								.where(
									and(
										scope(projectId, agentName),
										or(
											like(agentMemories.title, needle),
											like(agentMemories.description, needle),
											like(agentMemories.content, needle),
										),
									),
								)
								.orderBy(desc(agentMemories.recallCount), desc(agentMemories.updatedAt))
								.limit(RECALL_LIMIT);
						} else {
							rows = await db
								.select({
									id: agentMemories.id,
									title: agentMemories.title,
									description: agentMemories.description,
									content: agentMemories.content,
									recallCount: agentMemories.recallCount,
									lastRecalledAt: agentMemories.lastRecalledAt,
									updatedAt: agentMemories.updatedAt,
								})
								.from(agentMemories)
								.where(scope(projectId, agentName))
								.orderBy(desc(agentMemories.updatedAt))
								.limit(RECALL_LIMIT);
						}

						if (rows.length === 0) {
							return JSON.stringify({ success: true, memories: [], message: q ? `No memories match "${q}".` : "No memories saved yet." });
						}

						// Bump LRU bookkeeping for the recalled rows.
						const ids = rows.map((r) => r.id);
						await db
							.update(agentMemories)
							.set({ recallCount: sql`${agentMemories.recallCount} + 1`, lastRecalledAt: sql`CURRENT_TIMESTAMP` })
							.where(or(...ids.map((id) => eq(agentMemories.id, id))));

						return JSON.stringify({
							success: true,
							memories: rows.map((r) => ({ title: r.title, description: r.description, content: r.content })),
						});
					} catch (err) {
						return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
					}
				},
			}),
		},

		delete_memory: {
			category: "memory",
			tool: tool({
				description:
					"Delete a saved memory for THIS project by its exact title — use to remove a memory that " +
					"is wrong, stale, or no longer useful (curation). Saving a new memory with an existing " +
					"title updates rather than duplicating, so you only need this to remove memories.",
				inputSchema: z.object({
					title: z.string().describe("The exact title of the memory to delete"),
				}),
				execute: async ({ title }) => {
					try {
						const cleanTitle = title.trim();
						const existing = await db
							.select({ id: agentMemories.id })
							.from(agentMemories)
							.where(and(scope(projectId, agentName), eq(agentMemories.title, cleanTitle)))
							.limit(1);
						if (existing.length === 0) {
							return JSON.stringify({ success: false, error: `No memory titled "${cleanTitle}".` });
						}
						await db.delete(agentMemories).where(eq(agentMemories.id, existing[0].id));
						return JSON.stringify({ success: true, deleted: cleanTitle });
					} catch (err) {
						return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
					}
				},
			}),
		},
	};
}

// ---------------------------------------------------------------------------
// Registry stubs
//
// Placeholder versions registered in the static tool registry so the tools show
// up in tool listings, the per-agent allowlist (agent_tools), and the defaults.
// They never run verbatim: the agent-loop overlays the identity+project-bound
// versions from createMemoryTools() once it has a projectId. If one is ever
// reached without that binding (e.g. no active project), it degrades gracefully.
// ---------------------------------------------------------------------------

const unboundError = () =>
	JSON.stringify({ success: false, error: "Memory is unavailable here — no active project context." });

export const memoryTools: Record<string, ToolRegistryEntry> = {
	save_memory: {
		category: "memory",
		tool: tool({
			description:
				"Save a durable memory for yourself in this project (a user preference, gotcha, learning, " +
				"or something the user asked you to remember). Not for architectural decisions — use " +
				"log_decision for those.",
			inputSchema: z.object({
				title: z.string().describe("Short, unique title for this memory"),
				content: z.string().describe("The fact to remember (one concise fact, max ~2000 chars)"),
				description: z.string().optional().describe("One-line hook shown in your memory index"),
			}),
			execute: async () => unboundError(),
		}),
	},
	recall_memory: {
		category: "memory",
		tool: tool({
			description:
				"Recall your saved memories for this project — search by keyword, or omit the query to list " +
				"recent ones, then read the full content.",
			inputSchema: z.object({
				query: z.string().optional().describe("Keywords to search; omit to list recent memories"),
			}),
			execute: async () => unboundError(),
		}),
	},
	delete_memory: {
		category: "memory",
		tool: tool({
			description: "Delete one of your saved memories for this project by its exact title (curation).",
			inputSchema: z.object({
				title: z.string().describe("The exact title of the memory to delete"),
			}),
			execute: async () => unboundError(),
		}),
	},
};
