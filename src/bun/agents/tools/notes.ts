import { tool } from "ai";
import { z } from "zod";
import { eq, like } from "drizzle-orm";
import { join } from "path";
import { db } from "../../db";
import { projects } from "../../db/schema";
import * as notesRpc from "../../rpc/notes";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// Helper: resolve project ID from UUID or name
//
// Agents sometimes pass the project name instead of the UUID when calling
// tools that require a project_id. This resolves the name to the real UUID
// so the DB foreign-key constraint doesn't fail.
// ---------------------------------------------------------------------------

async function resolveProjectId(projectIdOrName: string): Promise<string | null> {
	// Quick UUID heuristic — 8-4-4-4-12 hex groups
	const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (uuidPattern.test(projectIdOrName)) return projectIdOrName;

	// Try exact name match first
	const rows = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.name, projectIdOrName))
		.limit(1);

	if (rows.length > 0) return rows[0].id;

	// Try case-insensitive partial match
	const partial = await db
		.select({ id: projects.id, name: projects.name })
		.from(projects)
		.where(like(projects.name, `%${projectIdOrName}%`))
		.limit(1);

	return partial.length > 0 ? partial[0].id : null;
}

export const notesTools: Record<string, ToolRegistryEntry> = {
	create_doc: {
		category: "notes",
		tool: tool({
			description:
				"Create a new document with a title and markdown content, stored within a project.",
			inputSchema: z.object({
				title: z.string().describe("The title of the document"),
				content: z.string().describe("The markdown content of the document"),
				project_id: z.string().describe("The ID of the project this document belongs to"),
			}),
			execute: async (args) => {
				try {
					const projectId = await resolveProjectId(args.project_id);
					if (!projectId) {
						return JSON.stringify({
							success: false,
							error: `Project not found: "${args.project_id}". Use the project UUID (found in the Project Context section of your instructions) or the exact project name.`,
						});
					}
					const result = await notesRpc.createNote({
						projectId,
						title: args.title,
						content: args.content,
						authorAgentId: "Agent",
					});
					return JSON.stringify(result);
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	update_doc: {
		category: "notes",
		tool: tool({
			description: "Update the title and/or content of an existing document.",
			inputSchema: z.object({
				id: z.string().describe("The ID of the document to update"),
				title: z.string().optional().describe("New title for the document"),
				content: z.string().optional().describe("New markdown content for the document"),
			}),
			execute: async (args) => {
				try {
					const result = await notesRpc.updateNote({
						id: args.id,
						title: args.title,
						content: args.content,
					});
					return JSON.stringify({ ...result, id: args.id });
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	list_docs: {
		category: "notes",
		tool: tool({
			description: "List all documents for a given project, returning id, title, and timestamps.",
			inputSchema: z.object({
				project_id: z.string().describe("The ID of the project whose documents to list"),
			}),
			execute: async (args) => {
				try {
					const resolvedId = await resolveProjectId(args.project_id);
					if (!resolvedId) {
						return JSON.stringify({ success: false, notes: [], error: `Project not found: "${args.project_id}"` });
					}
					const rows = await notesRpc.getProjectNotes(resolvedId);
					const summaries = rows.map((r) => ({
						id: r.id,
						title: r.title,
						createdAt: r.createdAt,
						updatedAt: r.updatedAt,
					}));
					return JSON.stringify({ success: true, notes: summaries });
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},

	get_doc: {
		category: "notes",
		tool: tool({
			description: "Get the full content of a specific document by its ID.",
			inputSchema: z.object({
				id: z.string().describe("The ID of the document to retrieve"),
			}),
			execute: async (args) => {
				try {
					const note = await notesRpc.getNote(args.id);
					if (!note) {
						return JSON.stringify({ success: false, error: "Document not found" });
					}
					return JSON.stringify({ success: true, note });
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			},
		}),
	},
};

// ---------------------------------------------------------------------------
// Decisions log tool — appends to DECISIONS.md in the workspace
// ---------------------------------------------------------------------------

/**
 * Creates a `log_decision` tool that appends architectural decisions to
 * DECISIONS.md in the workspace. The workspacePath is injected at creation
 * time by the agent-loop.
 */
export function createDecisionsTool(workspacePath: string): Record<string, ToolRegistryEntry> {
	return {
		log_decision: {
			category: "notes",
			tool: tool({
				description:
					"Log an architectural or design decision to the project's DECISIONS.md file. " +
					"Use this when you make a choice that other agents need to know about: " +
					"tech stack choices, naming conventions, data structures, API shapes, " +
					"auth strategies, file organization patterns, etc. " +
					"Always check DECISIONS.md (loaded in your prompt) before making a decision — " +
					"a prior agent may have already decided.",
				inputSchema: z.object({
					title: z.string().describe("Short decision title, e.g. 'Auth: use JWT tokens' or 'DB: SQLite with WAL mode'"),
					rationale: z.string().describe("Why this decision was made — alternatives considered, tradeoffs, constraints"),
					impact: z.string().optional().describe("What files/modules/agents are affected by this decision"),
				}),
				execute: async ({ title, rationale, impact }) => {
					try {
						const filePath = join(workspacePath, "DECISIONS.md");
						const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

						let entry = `\n## ${title}\n`;
						entry += `**When**: ${timestamp}\n\n`;
						entry += `${rationale}\n`;
						if (impact) entry += `\n**Impact**: ${impact}\n`;

						// Read existing content or create new file
						const decisionFile = Bun.file(filePath);
						let existing: string;
						if (await decisionFile.exists()) {
							existing = await decisionFile.text();
						} else {
							existing = "# Project Decisions\n\nArchitectural and design decisions made during development.\nAll agents should read this before starting work and log new decisions here.\n";
						}

						const finalContent = existing + entry;
						await Bun.write(filePath, finalContent);

						// Sync to Docs tab — upsert a note titled "DECISIONS.md"
						// so it appears in the activity pane's Docs tab
						try {
							const { projects: projectsTable } = await import("../../db/schema");
							const projRows = await db
								.select({ id: projectsTable.id })
								.from(projectsTable)
								.where(like(projectsTable.workspacePath, `%${workspacePath.replace(/\\/g, "\\\\").split(/[\\/]/).pop()}%`))
								.limit(1);
							if (projRows.length > 0) {
								const existingNotes = await notesRpc.getProjectNotes(projRows[0].id);
								const decisionsNote = existingNotes.find((n) => n.title === "DECISIONS.md");
								if (decisionsNote) {
									await notesRpc.updateNote({ id: decisionsNote.id, content: finalContent });
								} else {
									await notesRpc.createNote({ projectId: projRows[0].id, title: "DECISIONS.md", content: finalContent, authorAgentId: "system" });
								}
							}
						} catch { /* non-fatal — Docs sync is best-effort */ }

						return JSON.stringify({
							success: true,
							message: `Decision logged: "${title}"`,
							file: "DECISIONS.md",
						});
					} catch (err) {
						return JSON.stringify({
							success: false,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				},
			}),
		},
	};
}
