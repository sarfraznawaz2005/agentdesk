// ---------------------------------------------------------------------------
// General Chat memory tools (injected into the Assistant agent via extraTools)
//
// save_memory / recall_memory / delete_memory here are bound to
// `general_chat_memories` — a table exclusive to the standalone Assistant
// agent, distinct from both per-project `agent_memories` and PM's
// `global_memories`. NOT registered in the shared toolRegistry
// (src/bun/agents/tools/index.ts) — no other agent can ever get these.
// ---------------------------------------------------------------------------

import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import { eq, asc, desc, or, like, sql } from "drizzle-orm";
import { db } from "../../db";
import { generalChatMemories } from "../../db/schema";

const MAX_CONTENT_CHARS = 2000;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 200;
const SOFT_CAP = 50;
const HARD_CAP = 100;
const RECALL_LIMIT = 5;

interface GeneralChatMemoryRow {
	id: string;
	title: string;
	description: string;
	content: string;
	recallCount: number;
	lastRecalledAt: string | null;
	updatedAt: string;
}

async function countMemories(): Promise<number> {
	const rows = await db.select({ n: sql<number>`count(*)` }).from(generalChatMemories);
	return rows[0]?.n ?? 0;
}

/** Evict the single coldest memory (least recalled, then oldest) so a new insert stays within HARD_CAP. */
async function evictColdest(): Promise<void> {
	const victim = await db
		.select({ id: generalChatMemories.id })
		.from(generalChatMemories)
		.orderBy(asc(generalChatMemories.lastRecalledAt), asc(generalChatMemories.createdAt))
		.limit(1);
	if (victim.length > 0) {
		await db.delete(generalChatMemories).where(eq(generalChatMemories.id, victim[0].id));
	}
}

export function createGeneralChatMemoryTools(): Record<string, Tool> {
	return {
		save_memory: tool({
			description:
				"Save a durable memory — something the user asked you to remember, or a fact worth " +
				"carrying into future General Chat conversations. Re-saving the same title UPDATES that " +
				"memory in place. Keep each memory to a single concise fact (max ~2000 chars).",
			inputSchema: z.object({
				title: z.string().describe("Short, unique title for this memory, e.g. 'Prefers concise answers'"),
				content: z.string().describe("The fact to remember, in full. One concise fact — not a document."),
				description: z
					.string()
					.optional()
					.describe("One-line hook describing when this memory is relevant"),
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
						.select({ id: generalChatMemories.id })
						.from(generalChatMemories)
						.where(eq(generalChatMemories.title, cleanTitle))
						.limit(1);

					let updated = false;
					if (existing.length > 0) {
						await db
							.update(generalChatMemories)
							.set({ content: storedContent, description: cleanDescription, updatedAt: sql`CURRENT_TIMESTAMP` })
							.where(eq(generalChatMemories.id, existing[0].id));
						updated = true;
					} else {
						const count = await countMemories();
						if (count >= HARD_CAP) await evictColdest();
						await db.insert(generalChatMemories).values({
							title: cleanTitle,
							description: cleanDescription,
							content: storedContent,
						});
					}

					const total = await countMemories();
					const warnings: string[] = [];
					if (truncated) warnings.push(`content was truncated to ${MAX_CONTENT_CHARS} chars — keep memories to a single fact`);
					if (total > SOFT_CAP) warnings.push(`you now have ${total} memories saved (soft limit ${SOFT_CAP}); consider delete_memory to consolidate stale ones`);

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

		recall_memory: tool({
			description:
				"Recall your saved memories. Pass a query to search by keyword (title, description, or " +
				"content) and get the full content of the best matches; omit the query to list your most " +
				"recent memories.",
			inputSchema: z.object({
				query: z
					.string()
					.optional()
					.describe("Keywords to search your memories for. Omit to list your most recent ones."),
			}),
			execute: async ({ query }) => {
				try {
					const q = (query ?? "").trim();
					let rows: GeneralChatMemoryRow[];
					if (q) {
						const needle = `%${q}%`;
						rows = await db
							.select({
								id: generalChatMemories.id,
								title: generalChatMemories.title,
								description: generalChatMemories.description,
								content: generalChatMemories.content,
								recallCount: generalChatMemories.recallCount,
								lastRecalledAt: generalChatMemories.lastRecalledAt,
								updatedAt: generalChatMemories.updatedAt,
							})
							.from(generalChatMemories)
							.where(
								or(
									like(generalChatMemories.title, needle),
									like(generalChatMemories.description, needle),
									like(generalChatMemories.content, needle),
								),
							)
							.orderBy(desc(generalChatMemories.recallCount), desc(generalChatMemories.updatedAt))
							.limit(RECALL_LIMIT);
					} else {
						rows = await db
							.select({
								id: generalChatMemories.id,
								title: generalChatMemories.title,
								description: generalChatMemories.description,
								content: generalChatMemories.content,
								recallCount: generalChatMemories.recallCount,
								lastRecalledAt: generalChatMemories.lastRecalledAt,
								updatedAt: generalChatMemories.updatedAt,
							})
							.from(generalChatMemories)
							.orderBy(desc(generalChatMemories.updatedAt))
							.limit(RECALL_LIMIT);
					}

					if (rows.length === 0) {
						return JSON.stringify({ success: true, memories: [], message: q ? `No memories match "${q}".` : "No memories saved yet." });
					}

					const ids = rows.map((r) => r.id);
					await db
						.update(generalChatMemories)
						.set({ recallCount: sql`${generalChatMemories.recallCount} + 1`, lastRecalledAt: sql`CURRENT_TIMESTAMP` })
						.where(or(...ids.map((id) => eq(generalChatMemories.id, id))));

					return JSON.stringify({
						success: true,
						memories: rows.map((r) => ({ title: r.title, description: r.description, content: r.content })),
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		delete_memory: tool({
			description:
				"Delete a saved memory by its exact title — use to remove one that is wrong, stale, or no " +
				"longer useful. Saving a new one with an existing title updates rather than duplicating, so " +
				"you only need this to remove memories.",
			inputSchema: z.object({
				title: z.string().describe("The exact title of the memory to delete"),
			}),
			execute: async ({ title }) => {
				try {
					const cleanTitle = title.trim();
					const existing = await db
						.select({ id: generalChatMemories.id })
						.from(generalChatMemories)
						.where(eq(generalChatMemories.title, cleanTitle))
						.limit(1);
					if (existing.length === 0) {
						return JSON.stringify({ success: false, error: `No memory titled "${cleanTitle}".` });
					}
					await db.delete(generalChatMemories).where(eq(generalChatMemories.id, existing[0].id));
					return JSON.stringify({ success: true, deleted: cleanTitle });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),
	};
}
