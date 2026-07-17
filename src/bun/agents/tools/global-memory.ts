import { tool } from "ai";
import { z } from "zod";
import { eq, asc, desc, or, like, sql } from "drizzle-orm";
import { db } from "../../db";
import { globalMemories } from "../../db/schema";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// Global memory — PM-only, NOT scoped to any project
//
// Same two-tier "hybrid" recall as agent_memories (memory.ts): an always-on
// INDEX is injected into the PM's system prompt every run via
// buildGlobalMemoryIndexSection(), full bodies are pulled on demand by
// recall_global_memory.
//
// Distinct from agent_memories: this is for facts about the USER that apply
// everywhere — name, habits, recurring preferences — the way Claude Code's
// own cross-session memory works. Per-project learnings still belong in
// save_memory.
// ---------------------------------------------------------------------------

const MAX_CONTENT_CHARS = 2000;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 200;
const SOFT_CAP = 50;
const HARD_CAP = 100;
const INDEX_LIMIT = 30;
const RECALL_LIMIT = 5;

export interface GlobalMemoryRow {
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

async function countGlobalMemories(): Promise<number> {
	const rows = await db.select({ n: sql<number>`count(*)` }).from(globalMemories);
	return rows[0]?.n ?? 0;
}

/** Evict the single coldest memory (least recalled, then oldest) so a new insert stays within HARD_CAP. */
async function evictColdest(): Promise<void> {
	const victim = await db
		.select({ id: globalMemories.id })
		.from(globalMemories)
		.orderBy(asc(globalMemories.lastRecalledAt), asc(globalMemories.createdAt))
		.limit(1);
	if (victim.length > 0) {
		await db.delete(globalMemories).where(eq(globalMemories.id, victim[0].id));
	}
}

/**
 * The always-on global memory index: the INDEX_LIMIT most-recently-updated
 * memories (title + description only) plus the total count.
 */
export async function getGlobalMemoryIndex(): Promise<{ total: number; items: Array<{ title: string; description: string }> }> {
	const total = await countGlobalMemories();
	if (total === 0) return { total: 0, items: [] };
	const rows = await db
		.select({ title: globalMemories.title, description: globalMemories.description })
		.from(globalMemories)
		.orderBy(desc(globalMemories.updatedAt))
		.limit(INDEX_LIMIT);
	return { total, items: rows };
}

/**
 * Builds the "## Your Global Memory" system-prompt section for the PM, or ""
 * when there are no global memories yet. Injected by getPMSystemPrompt every run.
 */
export async function buildGlobalMemoryIndexSection(): Promise<string> {
	let index: { total: number; items: Array<{ title: string; description: string }> };
	try {
		index = await getGlobalMemoryIndex();
	} catch {
		return "";
	}
	if (index.total === 0) return "";

	const lines = index.items.map((m) =>
		m.description ? `- **${m.title}** — ${m.description}` : `- **${m.title}**`,
	);
	const more = index.total > index.items.length ? `\n- …and ${index.total - index.items.length} more` : "";

	return (
		"## Your Global Memory (across all projects)\n\n" +
		"Durable facts about the user that apply everywhere — their name, habits, recurring " +
		"preferences, and things they've explicitly asked you to always remember. Not tied to this " +
		"project. This is an **index** — use `recall_global_memory` to read the full content of any " +
		"that look relevant. Save new ones with `save_global_memory`.\n\n" +
		"> Use this instead of `save_memory` for anything that should follow the user to every " +
		"project (e.g. \"I prefer concise answers\", \"my timezone is X\", \"I run a solo dev shop\"). " +
		"Use `save_memory` instead for learnings specific to THIS project.\n\n" +
		lines.join("\n") +
		more +
		`\n\n(${index.total} ${index.total === 1 ? "memory" : "memories"} saved.)`
	);
}

// ---------------------------------------------------------------------------
// Tools — PM-only (not part of the per-agent toggleable tool registry)
// ---------------------------------------------------------------------------

export function createGlobalMemoryTools(): Record<string, ToolRegistryEntry> {
	return {
		save_global_memory: {
			category: "memory",
			tool: tool({
				description:
					"Save a durable memory about the USER that applies across EVERY project — their name, " +
					"habits, recurring preferences, or something they explicitly asked you to always " +
					"remember. Unlike save_memory (scoped to this one project), this follows the user " +
					"everywhere. Re-saving the same title UPDATES that memory in place. Keep each memory " +
					"to a single concise fact (max ~2000 chars).",
				inputSchema: z.object({
					title: z.string().describe("Short, unique title for this memory, e.g. 'Prefers concise answers'"),
					content: z.string().describe("The fact to remember, in full. One concise fact — not a document."),
					description: z
						.string()
						.optional()
						.describe("One-line hook shown in your always-on global memory index (helps you decide when to recall it)"),
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

						const existing = await db
							.select({ id: globalMemories.id })
							.from(globalMemories)
							.where(eq(globalMemories.title, cleanTitle))
							.limit(1);

						let updated = false;
						if (existing.length > 0) {
							await db
								.update(globalMemories)
								.set({ content: storedContent, description: cleanDescription, updatedAt: sql`CURRENT_TIMESTAMP` })
								.where(eq(globalMemories.id, existing[0].id));
							updated = true;
						} else {
							const count = await countGlobalMemories();
							if (count >= HARD_CAP) await evictColdest();
							await db.insert(globalMemories).values({
								title: cleanTitle,
								description: cleanDescription,
								content: storedContent,
							});
						}

						const total = await countGlobalMemories();
						const warnings: string[] = [];
						if (truncated) warnings.push(`content was truncated to ${MAX_CONTENT_CHARS} chars — keep memories to a single fact`);
						if (total > SOFT_CAP) warnings.push(`you now have ${total} global memories (soft limit ${SOFT_CAP}); consider delete_global_memory to consolidate stale ones`);

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

		recall_global_memory: {
			category: "memory",
			tool: tool({
				description:
					"Recall your saved global memories about the user (not scoped to this project). Pass a " +
					"query to search by keyword (title, description, or content) and get the full content of " +
					"the best matches; omit the query to list your most recent global memories.",
				inputSchema: z.object({
					query: z
						.string()
						.optional()
						.describe("Keywords to search your global memories for. Omit to list your most recent ones."),
				}),
				execute: async ({ query }) => {
					try {
						const q = (query ?? "").trim();
						let rows: GlobalMemoryRow[];
						if (q) {
							const needle = `%${q}%`;
							rows = await db
								.select({
									id: globalMemories.id,
									title: globalMemories.title,
									description: globalMemories.description,
									content: globalMemories.content,
									recallCount: globalMemories.recallCount,
									lastRecalledAt: globalMemories.lastRecalledAt,
									updatedAt: globalMemories.updatedAt,
								})
								.from(globalMemories)
								.where(
									or(
										like(globalMemories.title, needle),
										like(globalMemories.description, needle),
										like(globalMemories.content, needle),
									),
								)
								.orderBy(desc(globalMemories.recallCount), desc(globalMemories.updatedAt))
								.limit(RECALL_LIMIT);
						} else {
							rows = await db
								.select({
									id: globalMemories.id,
									title: globalMemories.title,
									description: globalMemories.description,
									content: globalMemories.content,
									recallCount: globalMemories.recallCount,
									lastRecalledAt: globalMemories.lastRecalledAt,
									updatedAt: globalMemories.updatedAt,
								})
								.from(globalMemories)
								.orderBy(desc(globalMemories.updatedAt))
								.limit(RECALL_LIMIT);
						}

						if (rows.length === 0) {
							return JSON.stringify({ success: true, memories: [], message: q ? `No global memories match "${q}".` : "No global memories saved yet." });
						}

						const ids = rows.map((r) => r.id);
						await db
							.update(globalMemories)
							.set({ recallCount: sql`${globalMemories.recallCount} + 1`, lastRecalledAt: sql`CURRENT_TIMESTAMP` })
							.where(or(...ids.map((id) => eq(globalMemories.id, id))));

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

		delete_global_memory: {
			category: "memory",
			tool: tool({
				description:
					"Delete a saved global memory by its exact title — use to remove one that is wrong, " +
					"stale, or no longer useful (curation). Saving a new one with an existing title updates " +
					"rather than duplicating, so you only need this to remove memories.",
				inputSchema: z.object({
					title: z.string().describe("The exact title of the global memory to delete"),
				}),
				execute: async ({ title }) => {
					try {
						const cleanTitle = title.trim();
						const existing = await db
							.select({ id: globalMemories.id })
							.from(globalMemories)
							.where(eq(globalMemories.title, cleanTitle))
							.limit(1);
						if (existing.length === 0) {
							return JSON.stringify({ success: false, error: `No global memory titled "${cleanTitle}".` });
						}
						await db.delete(globalMemories).where(eq(globalMemories.id, existing[0].id));
						return JSON.stringify({ success: true, deleted: cleanTitle });
					} catch (err) {
						return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
					}
				},
			}),
		},
	};
}
