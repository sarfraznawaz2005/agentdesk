/**
 * Dashboard PM Chat — lightweight in-memory chatbot for the dashboard floating widget.
 *
 * - No DB persistence (in-memory history per sessionId)
 * - Read-only tools only (no agent dispatch, no writes)
 * - Streams tokens via broadcastToWebview("dashboardPMChunk", ...)
 */

import { streamText, tool, isStepCount, type ModelMessage } from "ai";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { db } from "../db";
import {
	projects,
	agents,
	kanbanTasks,
	settings,
	aiProviders,
	pullRequests,
	prComments,
	auditLog,
	githubIssues,
	conversations,
	messages,
} from "../db/schema";
import { createProviderAdapter } from "../providers";
import { getDefaultModel } from "../providers/models";
import { isHaikuModel } from "../providers/claude-subscription";
import { getStreamingMode } from "../agents/streaming-mode";
import { createThrottledAccumulator } from "../agents/throttled-accumulator";
import { webTools } from "../agents/tools/web";
import { kanbanTools } from "../agents/tools/kanban";
import { gitTools } from "../agents/tools/git";
import { skillTools } from "../agents/tools/skills";
import { schedulerTools } from "../agents/tools/scheduler";
import { fileOpsTools } from "../agents/tools/file-ops";
import { processTools } from "../agents/tools/process";
import { notesTools } from "../agents/tools/notes";
import { systemTools } from "../agents/tools/system";
import { imageGenTools } from "../agents/tools/image-gen";
import { extractImagePayload } from "../agents/tools/screenshot";
import { skillRegistry } from "../skills/registry";
import { broadcastToWebview } from "../engine-manager";
import { buildUserProfileSection, loadUserTimezone, SECURITY_RULES_SECTION } from "../agents/prompts";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const sessionHistory = new Map<string, ModelMessage[]>();
const activeAborts = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

async function buildDashboardSystemPrompt(): Promise<string> {
	// Read user's global timezone from settings
	const userTimezone = await loadUserTimezone();

	const now = new Date();
	const localTime = now.toLocaleString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: userTimezone });

	let prompt = `You are the AgentDesk Project Manager assistant, available on the dashboard.

Current time: ${localTime} (${userTimezone})

You can help with:
- Checking the status of projects and their active agents
- Listing or searching projects, kanban tasks, and documents
- Checking git status and recent commits for a project workspace
- Looking up settings and configurations
- Browsing installed skills and reading their instructions
- Answering general questions or searching the web
- **Creating reminders and scheduled tasks** (cron jobs, one-shot timers, recurring schedules)

When asked about kanban tasks or git status for a project, first call list_projects to get the project's workspacePath and ID, then call list_tasks or git_status with the correct values.

---

## Scheduling & Reminders

You can create cron jobs and reminders using the scheduler tools. Use \`create_cron_job\` with \`taskType: "reminder"\` for simple notifications.

For relative time requests ("remind me in 5 minutes", "alert me at 3pm"):
- Compute the target minute and hour from the current time above
- Use wildcards for day, month, dow: \`minute hour * * *\`
- Set \`oneShot: true\` so the job fires once and self-deletes
- **Never pin day-of-month or month** — croner calculates "next run" at job creation time and a pinned past date produces no scheduled run
- Example: "in 10 minutes" at 14:23 → \`33 14 * * *\` with oneShot: true
- If the minute overflows 59, carry into the next hour (e.g. 14:58 + 5 min = \`3 15 * * *\`)
- **Always pass \`timezone: "${userTimezone}"\`** — the user's configured timezone. Never omit it or use UTC unless the user explicitly asks for UTC.

For \`taskType: "pm_prompt"\` or \`"agent_task"\`, a projectId is required — ask the user which project if not specified.

Be concise and helpful. Use tools to get accurate data rather than guessing.

---

${SECURITY_RULES_SECTION}`;

	// User profile (name + email + timezone-derived city) — same block the PM uses
	const userSection = await buildUserProfileSection();
	if (userSection) {
		prompt += `\n\n---\n\n${userSection}`;
	}

	// Append compact skills listing if any are installed
	const skills = skillRegistry.getAll();
	if (skills.length > 0) {
		const lines = skills.map((s) => {
			const agentTag = s.preferredAgent ? ` [agent: ${s.preferredAgent}]` : "";
			return `- **${s.name}**: ${s.description.slice(0, 120)}${agentTag}`;
		});
		prompt += `\n\n---\n\n## Available Skills\n\nThe following skills are installed (built-in + user-created). Use \`read_skill\` to load a skill's full instructions, \`find_skills\` to search them by keyword, or \`list_skills\` to re-list the full catalog.\n\n${lines.join("\n")}`;
	}

	return prompt;
}

// ---------------------------------------------------------------------------
// Dashboard-specific read-only tools
// ---------------------------------------------------------------------------

function createDashboardTools() {
	return {
		list_projects: tool({
			description: "List all projects with their status, description, and last updated time.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const rows = await db.select({
						id: projects.id,
						name: projects.name,
						description: projects.description,
						status: projects.status,
						workspacePath: projects.workspacePath,
						createdAt: projects.createdAt,
						updatedAt: projects.updatedAt,
					}).from(projects).orderBy(desc(projects.updatedAt));
					return JSON.stringify({ success: true, projects: rows, count: rows.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_project_stats: tool({
			description: "Get kanban task counts and active agent info for a specific project.",
			inputSchema: z.object({
				project_id: z.string().describe("The project UUID"),
			}),
			execute: async (args) => {
				try {
					const projectRow = await db.select({ name: projects.name, description: projects.description, status: projects.status, workspacePath: projects.workspacePath })
						.from(projects).where(eq(projects.id, args.project_id)).limit(1);
					if (!projectRow.length) return JSON.stringify({ success: false, error: "Project not found" });

					const tasks = await db.select({ column: kanbanTasks.column, priority: kanbanTasks.priority })
						.from(kanbanTasks).where(eq(kanbanTasks.projectId, args.project_id));

					const columns: Record<string, number> = { backlog: 0, working: 0, review: 0, done: 0 };
					const priorities: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
					for (const t of tasks) {
						columns[t.column] = (columns[t.column] ?? 0) + 1;
						priorities[t.priority] = (priorities[t.priority] ?? 0) + 1;
					}

					return JSON.stringify({
						success: true,
						project: projectRow[0],
						kanban: { total: tasks.length, columns, priorities },
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		list_agents: tool({
			description: "List all available agent types with their capabilities and assigned models.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const rows = await db.select({
						name: agents.name,
						displayName: agents.displayName,
						isEnabled: agents.isEnabled,
						modelId: agents.modelId,
					}).from(agents).orderBy(agents.displayName);
					return JSON.stringify({
						success: true,
						agents: rows.map((a) => ({ name: a.name, displayName: a.displayName, enabled: !!a.isEnabled, model: a.modelId })),
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_settings: tool({
			description: "Read app settings by category (general, providers, channels). Sensitive keys are redacted.",
			inputSchema: z.object({
				category: z.string().optional().describe("Filter by category. Omit for all settings."),
			}),
			execute: async (args) => {
				try {
					let query = db.select({ key: settings.key, value: settings.value, category: settings.category }).from(settings);
					if (args.category) {
						query = db.select({ key: settings.key, value: settings.value, category: settings.category })
							.from(settings).where(eq(settings.category, args.category)) as typeof query;
					}
					const rows = await query;
					const safe = rows
						.filter((r) => !/apiKey|api_key|token|secret|password/i.test(r.key))
						.map((r) => ({ key: r.key, value: r.value, category: r.category }));
					return JSON.stringify({ success: true, settings: safe });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// Kanban tools (read-only)
		list_tasks: kanbanTools.list_tasks.tool,
		get_task: kanbanTools.get_task.tool,

		// Git tools (read-only)
		git_status: gitTools.git_status.tool,
		git_log: gitTools.git_log.tool,
		git_diff: gitTools.git_diff.tool,

		// Web tools (reuse existing implementations)
		web_search: webTools.web_search.tool,
		web_fetch: webTools.web_fetch.tool,

		// Skill tools (read-only — browse and read installed skills)
		read_skill: skillTools.read_skill.tool,
		find_skills: skillTools.find_skills.tool,
		list_skills: skillTools.list_skills.tool,

		// Scheduler tools — create/manage cron jobs and reminders
		...schedulerTools,

		// File tools (read-only)
		file_info: fileOpsTools.file_info.tool,
		directory_tree: fileOpsTools.directory_tree.tool,
		search_files: fileOpsTools.search_files.tool,
		search_content: fileOpsTools.search_content.tool,

		// Process tools
		check_process: processTools.check_process.tool,

		// Notes/docs tools
		list_docs: notesTools.list_docs.tool,

		// Additional web tools
		http_request: webTools.http_request.tool,

		// Image generation — same tool as the main chat, picks an eligible
		// provider/model automatically (see agents/tools/image-gen.ts).
		generate_image: imageGenTools.generate_image.tool,

		// System tools
		environment_info: systemTools.environment_info.tool,
		get_env: systemTools.get_env.tool,

		// Project search
		search_projects: tool({
			description: "Fuzzy-search projects by name. Returns the closest matches.",
			inputSchema: z.object({
				query: z.string().describe("Search query matched against project names and descriptions"),
			}),
			execute: async (args) => {
				try {
					const rows = await db.select({ id: projects.id, name: projects.name, description: projects.description, workspacePath: projects.workspacePath })
						.from(projects);
					const query = args.query.toLowerCase();
					const scored = rows.map((p) => {
						const name = p.name.toLowerCase();
						const desc = (p.description ?? "").toLowerCase();
						let score = 0;
						if (name === query) score = 100;
						else if (name.includes(query)) score = 80;
						else if (query.includes(name)) score = 60;
						else if (desc.includes(query)) score = 40;
						else {
							for (const w of query.split(/\s+/)) {
								if (name.includes(w)) score += 20;
								else if (desc.includes(w)) score += 10;
							}
						}
						return { ...p, score };
					}).filter((p) => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
					return JSON.stringify({ success: true, matches: scored });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// Workspace folders
		list_workspace_folders: tool({
			description: "List all folders in the global workspace directory, including ones not yet registered as projects.",
			inputSchema: z.object({}),
			execute: async () => {
				try {
					const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "global_workspace_path")).limit(1);
					if (rows.length === 0 || !rows[0].value) return JSON.stringify({ success: false, error: "Global workspace path not configured. Set it in Settings → General." });
					let workspacePath: string;
					try { workspacePath = JSON.parse(rows[0].value); } catch { workspacePath = rows[0].value; }
					const { readdir, stat } = await import("node:fs/promises");
					const entries = await readdir(workspacePath, { withFileTypes: true });
					const allProjects = await db.select({ workspacePath: projects.workspacePath }).from(projects);
					const registeredPaths = new Set(allProjects.map((p) => p.workspacePath).filter(Boolean));
					const folders = [];
					for (const entry of entries) {
						if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
						const fullPath = `${workspacePath}/${entry.name}`;
						let hasGit = false;
						try { hasGit = (await stat(`${fullPath}/.git`)).isDirectory(); } catch { /* no .git */ }
						folders.push({ name: entry.name, path: fullPath, hasGit, isRegistered: registeredPaths.has(fullPath) });
					}
					return JSON.stringify({ success: true, workspacePath, folders, count: folders.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// Kanban stats (project-scoped)
		get_kanban_stats: tool({
			description: "Get kanban task counts per column, priority breakdown, and blocked task count for a project.",
			inputSchema: z.object({
				project_id: z.string().describe("Project ID — use list_projects to get it"),
			}),
			execute: async (args) => {
				try {
					const tasks = await db.select({ column: kanbanTasks.column, priority: kanbanTasks.priority, blockedBy: kanbanTasks.blockedBy, assignedAgentId: kanbanTasks.assignedAgentId })
						.from(kanbanTasks).where(eq(kanbanTasks.projectId, args.project_id));
					const columns: Record<string, number> = { backlog: 0, working: 0, review: 0, done: 0 };
					const priorities: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
					let blocked = 0;
					let assigned = 0;
					for (const t of tasks) {
						columns[t.column] = (columns[t.column] ?? 0) + 1;
						priorities[t.priority] = (priorities[t.priority] ?? 0) + 1;
						if (t.blockedBy) { try { const d = JSON.parse(t.blockedBy); if (Array.isArray(d) && d.length > 0) blocked++; } catch { /* empty */ } }
						if (t.assignedAgentId) assigned++;
					}
					return JSON.stringify({ success: true, total: tasks.length, columns, priorities, blocked, assigned });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// Conversation tools
		list_conversations: tool({
			description: "List all conversations for a project.",
			inputSchema: z.object({
				project_id: z.string().describe("Project ID — use list_projects to get it"),
			}),
			execute: async (args) => {
				try {
					const convs = await db.select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt, isPinned: conversations.isPinned })
						.from(conversations).where(eq(conversations.projectId, args.project_id)).orderBy(desc(conversations.updatedAt));
					return JSON.stringify({ success: true, conversations: convs, count: convs.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_conversation_messages: tool({
			description: "Get the most recent messages from a conversation.",
			inputSchema: z.object({
				conversation_id: z.string().describe("Conversation ID — use list_conversations to get it"),
				limit: z.number().optional().default(50).describe("Max messages to return (default 50)"),
			}),
			execute: async (args) => {
				try {
					const msgs = await db.select({ id: messages.id, role: messages.role, agentId: messages.agentId, content: messages.content, createdAt: messages.createdAt })
						.from(messages).where(eq(messages.conversationId, args.conversation_id))
						.orderBy(desc(messages.createdAt)).limit(args.limit ?? 50);
					return JSON.stringify({
						success: true,
						messages: msgs.reverse().map((m) => ({
							id: m.id, role: m.role, agentId: m.agentId,
							content: (m.content ?? "").slice(0, 2000) + ((m.content?.length ?? 0) > 2000 ? "... (truncated)" : ""),
							createdAt: m.createdAt,
						})),
						count: msgs.length,
					});
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		search_conversation_messages: tool({
			description: "Search messages in a specific conversation by text query.",
			inputSchema: z.object({
				conversation_id: z.string().describe("Conversation ID to search in"),
				query: z.string().describe("Text to search for"),
				limit: z.number().optional().default(20).describe("Max results (default 20)"),
			}),
			execute: async (args) => {
				try {
					const { sqlite: sqliteConn } = await import("../db/connection");
					let rows: Array<{ id: string; role: string; agent_id: string | null; content: string; created_at: string }>;
					try {
						rows = sqliteConn.prepare(
							`SELECT m.id, m.role, m.agent_id, m.content, m.created_at FROM messages m JOIN messages_fts f ON m.rowid = f.rowid WHERE messages_fts MATCH ?1 AND f.conversation_id = ?2 ORDER BY rank LIMIT ?3`
						).all(args.query, args.conversation_id, args.limit ?? 20) as typeof rows;
					} catch {
						rows = sqliteConn.prepare(
							`SELECT id, role, agent_id, content, created_at FROM messages WHERE conversation_id = ?1 AND content LIKE '%' || ?2 || '%' ORDER BY created_at LIMIT ?3`
						).all(args.conversation_id, args.query, args.limit ?? 20) as typeof rows;
					}
					return JSON.stringify({ success: true, results: rows.map((r) => ({ id: r.id, role: r.role, agentId: r.agent_id, snippet: r.content.slice(0, 500) + (r.content.length > 500 ? "..." : ""), createdAt: r.created_at })), count: rows.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// Pull requests
		get_pull_requests: tool({
			description: "List pull requests for a project. Shows PR status, branches, and linked tasks.",
			inputSchema: z.object({
				project_id: z.string().describe("Project ID"),
				state: z.string().optional().describe("Filter by state: 'open', 'review', 'merged', 'closed'"),
				limit: z.number().optional().default(20),
			}),
			execute: async (args) => {
				try {
					const { and } = await import("drizzle-orm");
					const where = args.state
						? and(eq(pullRequests.projectId, args.project_id), eq(pullRequests.state, args.state)) ?? undefined
						: eq(pullRequests.projectId, args.project_id);
					const rows = await db.select().from(pullRequests).where(where).orderBy(desc(pullRequests.updatedAt)).limit(args.limit ?? 20);
					return JSON.stringify({ success: true, pullRequests: rows.map((pr) => ({ id: pr.id, prNumber: pr.prNumber, title: pr.title, sourceBranch: pr.sourceBranch, targetBranch: pr.targetBranch, state: pr.state, authorName: pr.authorName, linkedTaskId: pr.linkedTaskId, createdAt: pr.createdAt, updatedAt: pr.updatedAt })), count: rows.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		get_pr_comments: tool({
			description: "Get review comments for a specific pull request.",
			inputSchema: z.object({
				pr_id: z.string().describe("Pull request ID"),
				limit: z.number().optional().default(30),
			}),
			execute: async (args) => {
				try {
					const rows = await db.select().from(prComments).where(eq(prComments.prId, args.pr_id)).orderBy(prComments.createdAt).limit(args.limit ?? 30);
					return JSON.stringify({ success: true, comments: rows.map((c) => ({ id: c.id, file: c.file, lineNumber: c.lineNumber, content: c.content.slice(0, 1000), authorName: c.authorName, authorType: c.authorType, createdAt: c.createdAt })), count: rows.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// GitHub issues
		get_github_issues: tool({
			description: "List GitHub issues linked to a project.",
			inputSchema: z.object({
				project_id: z.string().describe("Project ID"),
				state: z.string().optional().describe("Filter by state: 'open' or 'closed'"),
				limit: z.number().optional().default(30),
			}),
			execute: async (args) => {
				try {
					const { and } = await import("drizzle-orm");
					const where = args.state
						? and(eq(githubIssues.projectId, args.project_id), eq(githubIssues.state, args.state)) ?? undefined
						: eq(githubIssues.projectId, args.project_id);
					const rows = await db.select().from(githubIssues).where(where).orderBy(desc(githubIssues.syncedAt)).limit(args.limit ?? 30);
					return JSON.stringify({ success: true, issues: rows.map((i) => ({ id: i.id, githubIssueNumber: i.githubIssueNumber, title: i.title, state: i.state, labels: i.labels, taskId: i.taskId, syncedAt: i.syncedAt })), count: rows.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// Audit log
		get_audit_log: tool({
			description: "Query the audit log for recent actions across the app.",
			inputSchema: z.object({
				entity_type: z.string().optional().describe("Filter by entity type (e.g. 'project', 'task', 'agent')"),
				limit: z.number().optional().default(30),
			}),
			execute: async (args) => {
				try {
					const rows = args.entity_type
						? await db.select().from(auditLog).where(eq(auditLog.entityType, args.entity_type)).orderBy(desc(auditLog.createdAt)).limit(args.limit ?? 30)
						: await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(args.limit ?? 30);
					return JSON.stringify({ success: true, entries: rows.map((e) => ({ id: e.id, action: e.action, entityType: e.entityType, entityId: e.entityId, details: e.details ? e.details.slice(0, 500) : null, createdAt: e.createdAt })), count: rows.length });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),

		// Project integrity check
		verify_project: tool({
			description: "Verify a project's file integrity: check the entry point exists and trace all imports for missing files.",
			inputSchema: z.object({
				workspace_path: z.string().describe("Absolute path to the project workspace"),
				entry_point: z.string().describe("Entry file relative to workspace (e.g. index.html, src/main.ts)"),
			}),
			execute: async (args) => {
				try {
					const { resolve, dirname, extname } = await import("node:path");
					const { readFileSync, existsSync } = await import("node:fs");
					const entryPath = resolve(args.workspace_path, args.entry_point);
					if (!existsSync(entryPath)) return JSON.stringify({ valid: false, issues: [`Entry point not found: ${args.entry_point}`], filesChecked: 0 });
					const issues: string[] = [];
					const checked = new Set<string>();
					function checkFile(filePath: string, fromFile: string) {
						if (checked.has(filePath)) return;
						checked.add(filePath);
						if (!existsSync(filePath)) { issues.push(`Missing: ${filePath} (from ${fromFile})`); return; }
						const ext = extname(filePath).toLowerCase();
						if (![".html", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".css"].includes(ext)) return;
						let content: string;
						try { content = readFileSync(filePath, "utf-8"); } catch { return; }
						const dir = dirname(filePath);
						if (ext === ".html") {
							for (const m of content.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
								const ref = m[1];
								if (ref.startsWith("http") || ref.startsWith("//") || ref.startsWith("data:") || ref.startsWith("#")) continue;
								checkFile(resolve(dir, ref), filePath);
							}
						} else if ([".js", ".ts", ".jsx", ".tsx", ".mjs"].includes(ext)) {
							for (const m of content.matchAll(/(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g)) {
								const ref = m[1];
								if (!ref.startsWith(".")) continue;
								let resolved = resolve(dir, ref);
								if (!existsSync(resolved)) {
									const found = [".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.js"].find((e) => existsSync(resolved + e));
									if (found) resolved = resolved + found; else { issues.push(`Missing import: ${ref} (from ${filePath})`); continue; }
								}
								checkFile(resolved, filePath);
							}
						}
					}
					checkFile(entryPath, "entry");
					return JSON.stringify({ valid: issues.length === 0, issues, filesChecked: checked.size });
				} catch (err) {
					return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
				}
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getDefaultProviderRow() {
	const rows = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
	if (rows.length === 0) {
		const any = await db.select().from(aiProviders).limit(1);
		if (any.length === 0) throw new Error("No AI provider configured.");
		return any[0];
	}
	return rows[0];
}

// The SDK's query() takes a single prompt, not a ModelMessage[] — flatten the
// conversation history into a text transcript, same approach engine.ts uses
// for the PM's own CLI/SDK-routed transcript.
function flattenHistoryForCli(history: ModelMessage[]): string {
	return history.map((m) => {
		const text = typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content.map((p) => (p && typeof p === "object" && "text" in p ? (p as { text?: string }).text ?? "" : "")).filter(Boolean).join("\n")
				: "";
		return `[${m.role}]\n${text}`;
	}).join("\n\n");
}

// ---------------------------------------------------------------------------
// Exported RPC handlers
// ---------------------------------------------------------------------------

export async function sendDashboardMessage(params: { sessionId: string; content: string }): Promise<{ messageId: string }> {
	const { sessionId, content } = params;

	// Cancel any existing stream for this session
	activeAborts.get(sessionId)?.abort();

	const messageId = crypto.randomUUID();

	// ---------------------------------------------------------------------------
	// /info — hardcoded handler, no LLM call. Matches any casing / whitespace.
	// ---------------------------------------------------------------------------
	if (content.trim().toLowerCase() === "/info") {
		(async () => {
			try {
				const { getStatusReport } = await import("../engine-manager");
				const response = await getStatusReport();
				// Stream the response as a single chunk so the UI uses the same path
				broadcastToWebview("dashboardPMChunk", { sessionId, messageId, token: response });
				broadcastToWebview("dashboardPMComplete", { sessionId, messageId, content: response });
				// Add to session history so context is preserved
				const history = sessionHistory.get(sessionId) ?? [];
				sessionHistory.set(sessionId, [
					...history,
					{ role: "user", content },
					{ role: "assistant", content: response },
				]);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				broadcastToWebview("dashboardPMError", { sessionId, error: errMsg });
			}
		})();
		return { messageId };
	}

	const abortController = new AbortController();
	activeAborts.set(sessionId, abortController);

	// Build history
	const history = sessionHistory.get(sessionId) ?? [];
	const newHistory: ModelMessage[] = [
		...history,
		{ role: "user", content },
	];
	sessionHistory.set(sessionId, newHistory);

	// Run async — return messageId immediately so frontend can track it
	(async () => {
		let fullText = "";
		try {
			const providerRow = await getDefaultProviderRow();
			const modelId = providerRow.defaultModel ?? getDefaultModel(providerRow.providerType);
			const tools = createDashboardTools();
			const systemPrompt = await buildDashboardSystemPrompt();
			const streamingMode = await getStreamingMode();
			const isFullStreaming = streamingMode === "full";
			const isNoStreaming = streamingMode === "none";

			// Claude Subscription's direct-HTTP OAuth path 429s for anything but
			// Haiku — non-Haiku models route through the official Agent SDK
			// instead (see providers/claude-subscription.ts / claude-subscription-cli-runner.ts).
			if (providerRow.providerType === "claude-subscription" && !isHaikuModel(modelId)) {
				const { runClaudeCliTask } = await import("../providers/claude-subscription-cli-runner");
				// onToolCallEnd only carries the callId, not the toolName — track it
				// from onToolCallStart so the image-tool-result broadcast below can
				// tell which tool produced a given result.
				const cliToolNameByCallId = new Map<string, string>();
				// Full Streaming only — broadcastToWebview("dashboardPMChunk", {token})
				// appends client-side, so only the slice new since the last throttled
				// flush is ever sent (not the full accumulated text).
				let flushedLength = 0;
				const textAcc = isFullStreaming ? createThrottledAccumulator((acc) => {
					const delta = acc.slice(flushedLength);
					flushedLength = acc.length;
					if (delta) broadcastToWebview("dashboardPMChunk", { sessionId, messageId, token: delta });
				}) : null;
				const cliResult = await runClaudeCliTask({
					task: flattenHistoryForCli(newHistory),
					systemPrompt,
					tools,
					modelId,
					timeoutMs: 900_000,
					abortSignal: abortController.signal,
					verifyToolCall: false, // dashboard chat is general Q&A — a turn may legitimately need zero tool calls
					onText: (text) => {
						fullText += text;
						// Already delivered progressively via onTextToken in Full Streaming —
						// broadcasting the whole text again here would duplicate it.
						if (!isFullStreaming) broadcastToWebview("dashboardPMChunk", { sessionId, messageId, token: text });
					},
					onReasoning: () => { /* dashboard chat doesn't surface reasoning today (same as the streamText path, which ignores 'reasoning' parts) */ },
					onTextToken: (delta) => textAcc?.push(delta),
					onRetract: () => { textAcc?.cancel(); flushedLength = 0; },
					onToolCallStart: (toolName, args) => {
						const callId = crypto.randomUUID();
						cliToolNameByCallId.set(callId, toolName);
						broadcastToWebview("dashboardPMToolCall", { sessionId, callId, toolName, args });
						if (toolName === "read_skill" && (args as Record<string, unknown>)?.name) {
							console.log(`[skills] Dashboard PM loaded skill "${(args as Record<string, unknown>).name}"`);
						}
						return callId;
					},
					onToolCallEnd: (callId, resultText, isError) => {
						const toolName = cliToolNameByCallId.get(callId);
						cliToolNameByCallId.delete(callId);
						// Only image tools carry a payload worth broadcasting today — avoid
						// blowing up widget state with every other tool's raw output.
						if (!isError && toolName && extractImagePayload(resultText)) {
							broadcastToWebview("dashboardPMToolResult", { sessionId, messageId, callId, toolName, output: resultText });
						}
					},
				});
				textAcc?.flushNow();

				if (abortController.signal.aborted) return;
				if (cliResult.status === "cancelled") return;
				if (cliResult.status === "timeout") {
					throw Object.assign(new Error("This request hit the 15-minute time limit and was stopped. Send a follow-up to continue."), { name: "TimeoutError" });
				}
				if (cliResult.status === "failed") {
					throw new Error(cliResult.summary);
				}
				if (!fullText.trim()) fullText = cliResult.summary;
			} else {
				const adapter = createProviderAdapter({
					id: providerRow.id,
					name: providerRow.name,
					providerType: providerRow.providerType,
					apiKey: providerRow.apiKey,
					baseUrl: providerRow.baseUrl,
					defaultModel: providerRow.defaultModel,
				});
				const model = adapter.createModel(modelId);

				const result = streamText({
					model,
					instructions: systemPrompt,
					messages: newHistory,
					tools,
					stopWhen: [isStepCount(100)],
					abortSignal: AbortSignal.any([abortController.signal, AbortSignal.timeout(900_000)]),
				});

				for await (const part of result.stream) {
					if (part.type === "text-delta") {
						const text = (part as { text?: string }).text ?? "";
						fullText += text;
						if (!isNoStreaming) broadcastToWebview("dashboardPMChunk", { sessionId, messageId, token: text });
					} else if (part.type === "tool-call") {
						const tcInput = (part as Record<string, unknown>).input ?? (part as Record<string, unknown>).args;
						broadcastToWebview("dashboardPMToolCall", { sessionId, callId: part.toolCallId, toolName: part.toolName, args: tcInput });
						if (part.toolName === "read_skill" && (tcInput as Record<string, unknown>)?.name) {
							console.log(`[skills] Dashboard PM loaded skill "${(tcInput as Record<string, unknown>).name}"`);
						}
					} else if (part.type === "tool-result") {
						// Only image tools carry a payload worth broadcasting today — avoid
						// blowing up widget state with every other tool's raw output.
						const trOutput = (part as Record<string, unknown>).output ?? (part as Record<string, unknown>).result;
						const resultStr = typeof trOutput === "string" ? trOutput : JSON.stringify(trOutput);
						if (extractImagePayload(resultStr)) {
							broadcastToWebview("dashboardPMToolResult", { sessionId, messageId, callId: part.toolCallId, toolName: part.toolName, output: resultStr });
						}
					} else if (part.type === "error") {
						const err = (part as { error: unknown }).error;
						throw err instanceof Error ? err : new Error(String(err));
					}
				}

				if (!fullText.trim()) {
					let finalText = "";
					try { finalText = await result.text; } catch { /* not available */ }
					if (finalText.trim()) {
						fullText = finalText;
						if (!isNoStreaming) broadcastToWebview("dashboardPMChunk", { sessionId, messageId, token: fullText });
					}
				}
			}

			if (!fullText.trim()) {
				throw new Error("The AI model returned an empty response. Check your provider quota or switch to a different model.");
			}

			// Append assistant response to history
			if (fullText) {
				const updatedHistory = sessionHistory.get(sessionId) ?? newHistory;
				sessionHistory.set(sessionId, [
					...updatedHistory,
					{ role: "assistant", content: fullText },
				]);
			}

			broadcastToWebview("dashboardPMComplete", { sessionId, messageId, content: fullText });
		} catch (err) {
			// User-initiated stop (or a superseding message) — swallow silently.
			if (err instanceof DOMException && err.name === "AbortError") return;
			if (err instanceof Error && err.name === "AbortError") return;
			// 15-minute wall-clock guard fired — surface a clear message.
			const isTimeout = err instanceof Error && err.name === "TimeoutError";
			const errMsg = isTimeout
				? "This request hit the 15-minute time limit and was stopped. Send a follow-up to continue."
				: err instanceof Error ? err.message : String(err);
			broadcastToWebview("dashboardPMError", { sessionId, error: errMsg });
		} finally {
			activeAborts.delete(sessionId);
		}
	})();

	return { messageId };
}

export function abortDashboardMessage(params: { sessionId: string }): { success: boolean } {
	const ctrl = activeAborts.get(params.sessionId);
	if (ctrl) {
		ctrl.abort();
		activeAborts.delete(params.sessionId);
		return { success: true };
	}
	return { success: false };
}

export function clearDashboardSession(params: { sessionId: string }): { success: boolean } {
	sessionHistory.delete(params.sessionId);
	activeAborts.get(params.sessionId)?.abort();
	activeAborts.delete(params.sessionId);
	return { success: true };
}
