import { eq, like, sql } from "drizzle-orm";
import { mkdirSync, existsSync, readdirSync, statSync, readFileSync, symlinkSync, lstatSync, rmSync, readlinkSync, unlinkSync } from "fs";
import { readdir } from "fs/promises";
import { join, relative, resolve, basename } from "path";
import { isPathAccessible } from "../lib/path-utils";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { projects, settings } from "../db/schema";
import { isUniqueViolation } from "../db/errors";
import { logAudit } from "../db/audit";
import { clearContextLimitCache } from "../providers/models";
import { runGit } from "../lib/git-runner";
import { gitAuthArgs, resolveGitHubToken } from "./github-api";
import { encryptSecret } from "../lib/secret-crypto";

/** Per-project setting keys whose values are secrets and must be encrypted at rest. */
const PROJECT_SECRET_KEYS = new Set(["githubToken"]);

export interface ProjectListItem {
	id: string;
	name: string;
	description: string | null;
	status: string;
	workspacePath: string;
	githubUrl: string | null;
	workingBranch: string | null;
	createdAt: string;
	updatedAt: string;
	workspaceOffline?: boolean;
}

/**
 * Return all projects ordered by name.
 * Projects whose workspace folder is temporarily unreachable (cloud/network paths,
 * OneDrive Files-on-Demand, NAS) are returned with workspaceOffline=true so the
 * dashboard can show a warning — they are NEVER auto-deleted just because a path
 * check fails. Only projects explicitly deleted by the user are removed.
 */
export async function getProjectsList(): Promise<ProjectListItem[]> {
	const rows = await db.select().from(projects);

	// Check all non-deleted project paths concurrently with retry for cloud paths.
	const results = await Promise.all(
		rows.map(async (row) => {
			if (row.status === "deleted") return { row, offline: false };
			const accessible = await isPathAccessible(row.workspacePath);
			if (!accessible) {
				console.warn(`[projects] Workspace temporarily unreachable (marked offline, NOT deleted): ${row.workspacePath}`);
			}
			return { row, offline: !accessible };
		}),
	);

	return results
		.map(({ row, offline }) => ({
			id: row.id,
			name: row.name,
			description: row.description,
			status: row.status,
			workspacePath: row.workspacePath,
			githubUrl: row.githubUrl,
			workingBranch: row.workingBranch,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			workspaceOffline: offline || undefined,
		}))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export interface CreateProjectParams {
	name: string;
	description?: string;
	workspacePath?: string;
	githubUrl?: string;
	workingBranch?: string;
}

// Default values for project-scoped AI/behaviour settings.
// Must stay in sync with AI_FORM_DEFAULTS in the frontend project-settings UI.
const DEFAULT_PROJECT_SETTINGS: Record<string, string> = {
	thinkingBudget: "medium",
	shellApprovalMode: "ask",
	constitutionMode: "inherit",
	maxReviewRounds: "3",
};

/**
 * Insert a new project record and seed its default settings.
 */
export async function createProjectHandler(
	params: CreateProjectParams,
): Promise<{ success: boolean; id: string; error?: string }> {
	// Reject duplicate names — case-insensitive so "AgentDesk" and "agentdesk" are the same
	const existing = await db
		.select({ id: projects.id })
		.from(projects)
		.where(sql`lower(${projects.name}) = lower(${params.name.trim()})`)
		.limit(1);
	if (existing.length > 0) {
		return { success: false, id: "", error: `A project named "${params.name.trim()}" already exists. Please choose a different name.` };
	}

	const id = crypto.randomUUID();

	// Resolve workspace path: use explicit path, or auto-derive from global workspace
	let workspacePath = params.workspacePath?.trim() || "";
	if (!workspacePath) {
		const gwpRows = await db
			.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, "global_workspace_path"))
			.limit(1);
		let globalWorkspace = "";
		if (gwpRows.length > 0) {
			try { globalWorkspace = JSON.parse(gwpRows[0].value) as string; } catch { globalWorkspace = gwpRows[0].value; }
		}
		if (globalWorkspace) {
			const slug = params.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
			workspacePath = join(globalWorkspace, slug);
			// Handle name collisions with numeric suffix
			let suffix = 1;
			let candidate = workspacePath;
			while (existsSync(candidate)) {
				candidate = `${workspacePath}-${suffix}`;
				suffix++;
			}
			workspacePath = candidate;
		}
	}

	if (!workspacePath) {
		return { success: false as never, id: "" } as never;
	}

	// If the chosen path is outside the global workspace, create a symlink
	// inside the workspace pointing to the external path. This keeps all
	// projects discoverable under one root while allowing external folders.
	let globalWorkspacePath = "";
	try {
		const gwpRows = await db.select({ value: settings.value }).from(settings)
			.where(eq(settings.key, "global_workspace_path")).limit(1);
		if (gwpRows.length > 0) {
			try { globalWorkspacePath = JSON.parse(gwpRows[0].value) as string; } catch { globalWorkspacePath = gwpRows[0].value; }
		}
	} catch { /* non-fatal */ }

	if (globalWorkspacePath) {
		const resolvedWorkspace = resolve(globalWorkspacePath);
		const resolvedPath = resolve(workspacePath);
		const rel = relative(resolvedWorkspace, resolvedPath);
		const isOutside = rel.startsWith("..") || resolve(rel) === resolvedPath;

		if (isOutside) {
			// Ensure the external directory exists
			try { mkdirSync(resolvedPath, { recursive: true }); } catch { /* may already exist */ }

			// Create symlink inside workspace: workspace/project-name → external/path
			const linkName = basename(resolvedPath);
			let linkPath = join(resolvedWorkspace, linkName);
			let suffix = 1;
			while (existsSync(linkPath)) {
				// Check if existing path is already a symlink to our target
				try {
					const stat = lstatSync(linkPath);
					if (stat.isSymbolicLink()) break;
				} catch { /* ignore */ }
				linkPath = join(resolvedWorkspace, `${linkName}-${suffix}`);
				suffix++;
			}

			try {
				mkdirSync(resolvedWorkspace, { recursive: true });
				if (!existsSync(linkPath)) {
					symlinkSync(resolvedPath, linkPath, "junction");
					console.log(`[projects] Created symlink: ${linkPath} → ${resolvedPath}`);
				}
			} catch (err) {
				console.warn(`[projects] Failed to create symlink for external project:`, err);
				// Non-fatal — project still works, just won't be visible under workspace root
			}
		}
	}

	if (params.githubUrl?.trim()) {
		// Clone the remote repo into the workspace path so the local history
		// shares a merge base with origin. This prevents the "unrelated histories"
		// problem that breaks PR diffs when a repo is initialized locally then
		// pushed to a pre-existing remote.
		const url = params.githubUrl.trim();
		const branch = params.workingBranch?.trim();

		// git clone requires the target directory to not exist (or be empty).
		// If it already exists and is non-empty, bail with a clear error.
		if (existsSync(workspacePath)) {
			const entries = readdirSync(workspacePath).filter((e) => e !== ".git");
			if (entries.length > 0) {
				return { success: false as never, id: "", error: `Workspace path already exists and is not empty: ${workspacePath}` } as never;
			}
		}

		// Auto-authenticate cloning a GitHub HTTPS repo with the configured token (inline header,
		// credential helper disabled) so a private repo clones without a credential prompt and
		// without storing an `x-access-token` account. No-op for SSH/non-GitHub URLs or no token.
		let cloneAuth: string[] = [];
		if (/^https:\/\/github\.com\//i.test(url)) {
			const token = await resolveGitHubToken({});
			if (token) cloneAuth = gitAuthArgs(token);
		}
		const cloneArgs = [...cloneAuth, "clone", url, workspacePath];
		if (branch) cloneArgs.push("--branch", branch);

		const { exitCode, stderr } = await runGit(cloneArgs, resolve(workspacePath, ".."));
		if (exitCode !== 0) {
			return { success: false as never, id: "", error: `git clone failed: ${stderr}` } as never;
		}

		// If branch was specified and clone didn't check it out (e.g. default branch differs),
		// check it out now. Ignore errors — branch may already be active.
		if (branch) {
			await runGit(["checkout", branch], workspacePath).catch(() => {});
		}
	} else {
		// No GitHub URL — create the directory locally as before.
		try {
			mkdirSync(workspacePath, { recursive: true });
		} catch {
			// Non-fatal — directory may already exist
		}
	}

	try {
		await db.insert(projects).values({
			id,
			name: params.name,
			description: params.description ?? null,
			workspacePath,
			githubUrl: params.githubUrl ?? null,
			workingBranch: params.workingBranch ?? null,
		});
	} catch (err) {
		// Atomic backstop for the name pre-check race (v51 case-insensitive index).
		if (isUniqueViolation(err)) {
			return { success: false, id: "", error: `A project named "${params.name.trim()}" already exists. Please choose a different name.` };
		}
		throw err;
	}

	// Seed default project settings so the backend always has values to read
	// without waiting for the user to open and save the settings UI.
	await db.insert(settings).values(
		Object.entries(DEFAULT_PROJECT_SETTINGS).map(([key, value]) => ({
			id: crypto.randomUUID(),
			key: `project:${id}:${key}`,
			value,
			category: "project",
		})),
	);

	logAudit({ action: "project.create", entityType: "project", entityId: id, details: { name: params.name } });

	// Notify any open webview so a newly created project appears live without a
	// navigation/restart. Matters most for background creators that have no UI
	// round-trip of their own — channel global-mode auto-create and workspace sync.
	try {
		const { broadcastToWebview } = await import("../engine-manager");
		broadcastToWebview("projectsUpdated", { id, name: params.name });
	} catch { /* non-fatal — window may be closed */ }

	return { success: true, id };
}

/**
 * Report whether a project's workspace already contains a `.git` directory.
 * Used by the settings UI to decide whether to offer a "Clone" action next to
 * the GitHub URL. Tolerant — returns { hasGit: false } for missing projects or
 * paths rather than throwing.
 */
export async function getProjectRepoState(projectId: string): Promise<{ hasGit: boolean }> {
	try {
		const rows = await db.select({ workspacePath: projects.workspacePath })
			.from(projects).where(eq(projects.id, projectId)).limit(1);
		if (rows.length === 0) return { hasGit: false };
		return { hasGit: existsSync(join(rows[0].workspacePath, ".git")) };
	} catch {
		return { hasGit: false };
	}
}

/**
 * Clone a project's configured GitHub URL into its workspace path. Mirrors the
 * clone performed during project creation (auth via inline token header, optional
 * branch), but as a standalone action for projects that gained a URL afterwards.
 * Refuses if the workspace is already a git repo or is non-empty.
 */
export async function cloneProjectRepo(projectId: string): Promise<{ success: boolean; error?: string }> {
	const rows = await db.select({
		workspacePath: projects.workspacePath,
		githubUrl: projects.githubUrl,
		workingBranch: projects.workingBranch,
	}).from(projects).where(eq(projects.id, projectId)).limit(1);
	if (rows.length === 0) return { success: false, error: "Project not found." };

	const { workspacePath, workingBranch } = rows[0];
	const url = rows[0].githubUrl?.trim();
	if (!url) return { success: false, error: "No GitHub repository URL is set for this project." };

	// Already a git repo — nothing to clone.
	if (existsSync(join(workspacePath, ".git"))) {
		return { success: false, error: "This workspace is already a git repository." };
	}

	// git clone needs an empty target dir (a stray .git was excluded above).
	if (existsSync(workspacePath)) {
		const entries = readdirSync(workspacePath).filter((e) => e !== ".git");
		if (entries.length > 0) {
			return { success: false, error: `Workspace is not empty: ${workspacePath}. Cloning requires an empty folder.` };
		}
	}

	// Ensure the parent exists so `git clone` can create/use the target dir.
	try { mkdirSync(resolve(workspacePath, ".."), { recursive: true }); } catch { /* may already exist */ }

	const branch = workingBranch?.trim();

	// Auto-authenticate a GitHub HTTPS clone with the configured token (inline header,
	// credential helper disabled) — no-op for SSH/non-GitHub URLs or when no token is set.
	let cloneAuth: string[] = [];
	if (/^https:\/\/github\.com\//i.test(url)) {
		const token = await resolveGitHubToken({});
		if (token) cloneAuth = gitAuthArgs(token);
	}
	const cloneArgs = [...cloneAuth, "clone", url, workspacePath];
	if (branch) cloneArgs.push("--branch", branch);

	const { exitCode, stderr } = await runGit(cloneArgs, resolve(workspacePath, ".."));
	if (exitCode !== 0) {
		return { success: false, error: `git clone failed: ${stderr}` };
	}

	// If a branch was requested but the clone landed on the remote default, check it out now.
	if (branch) {
		await runGit(["checkout", branch], workspacePath).catch(() => {});
	}

	logAudit({ action: "project.clone", entityType: "project", entityId: projectId, details: { url } });
	return { success: true };
}

/**
 * Delete a project by ID.
 */
export async function deleteProjectHandler(
	id: string,
): Promise<{ success: boolean }> {
	await db.delete(projects).where(eq(projects.id, id));
	return { success: true };
}

/**
 * Permanently hard-delete a project regardless of status.
 * Remove a project's workspace from disk safely.
 * If the workspacePath is inside the global workspace, delete it recursively.
 * If it is outside (symlinked into the workspace), remove only the symlink and
 * leave the original folder untouched.
 */
async function cleanupProjectWorkspaceFolder(workspacePath: string): Promise<void> {
	let globalWorkspace = "";
	try {
		const gwpRows = await db.select({ value: settings.value }).from(settings)
			.where(eq(settings.key, "global_workspace_path")).limit(1);
		if (gwpRows.length > 0) {
			try { globalWorkspace = JSON.parse(gwpRows[0].value) as string; } catch { globalWorkspace = gwpRows[0].value; }
		}
	} catch { /* non-fatal */ }

	if (globalWorkspace) {
		const resolvedWorkspace = resolve(globalWorkspace);
		const resolvedPath = resolve(workspacePath);
		const rel = relative(resolvedWorkspace, resolvedPath);
		const isOutside = rel.startsWith("..") || resolve(rel) === resolvedPath;

		if (isOutside) {
			// Path is outside the workspace — find the symlink(s) pointing to it and
			// remove them, but do NOT touch the original folder.
			try {
				const entries = readdirSync(resolvedWorkspace, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isSymbolicLink()) continue;
					const entryPath = join(resolvedWorkspace, entry.name);
					try {
						const target = readlinkSync(entryPath);
						if (resolve(target) === resolvedPath) {
							unlinkSync(entryPath);
							console.log(`[project] Removed symlink: ${entryPath} → ${target}`);
						}
					} catch { /* skip unreadable entries */ }
				}
			} catch { /* workspace directory may not exist */ }
			return; // original folder is preserved
		}
	}

	// Path is within the workspace (or no workspace configured) — delete recursively
	if (existsSync(workspacePath)) {
		try {
			rmSync(workspacePath, { recursive: true, force: true });
		} catch (err) {
			console.error(`[project] Failed to delete workspace folder ${workspacePath}:`, err);
		}
	}
}

/**
 * Cascades all dependent records, hard-deletes the project row, then
 * removes the workspace folder from disk if it still exists.
 */
export async function permanentDeleteProjectHandler(
	id: string,
): Promise<{ success: boolean; error?: string }> {
	const rows = await db.select().from(projects).where(eq(projects.id, id));
	const project = rows[0];
	if (!project) return { success: false, error: "Project not found." };

	// Stop any running agents first to avoid FK failures from in-flight writes
	try {
		const { abortAllAgents, engines } = await import("../engine-manager");
		engines.get(id)?.stopAll();
		abortAllAgents(id);
	} catch { /* non-critical */ }

	// Cascade-delete all dependent data + hard-delete the project row in one transaction
	const s = getStmts();
	const txn = sqlite.transaction((pid: string) => {
		s.delMsgPartsByConv.run(pid);
		s.delMsgsByConv.run(pid);
		s.delSummariesByConv.run(pid);
		s.delConversations.run(pid);
		s.delActivityByTask.run(pid);
		s.delKanbanTasks.run(pid);
		s.delNotes.run(pid);
		s.delHistoryByEnv.run(pid);
		s.delDeployEnvs.run(pid);
		s.delCommentsByPr.run(pid);
		s.delPullRequests.run(pid);
		s.delWebhookEvents.run(pid);
		s.delWebhookConfigs.run(pid);
		s.delGithubIssues.run(pid);
		s.delBranchStrategies.run(pid);
		s.delCronHistoryByJob.run(pid);
		s.delCronJobs.run(pid);
		s.delAutomationRules.run(pid);
		s.delInboxMessages.run(pid);
		s.delInboxRules.run(pid);
		s.delNotifPrefs.run(pid);
		s.delCostBudgets.run(pid);
		s.delChannels.run(pid);
		s.delFreelanceListings.run(pid);
		s.delProjectSettings.run(pid);
		s.hardDeleteProject.run(pid);
	});
	txn(id);

	await cleanupProjectWorkspaceFolder(project.workspacePath);

	logAudit({ action: "project.permanent_delete", entityType: "project", entityId: id });
	return { success: true };
}

/**
 * Fetch a single project by ID.
 */
export async function getProject(id: string): Promise<ProjectListItem | null> {
	const rows = await db.select().from(projects).where(eq(projects.id, id));
	if (!rows[0]) return null;
	const row = rows[0];
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		status: row.status,
		workspacePath: row.workspacePath,
		githubUrl: row.githubUrl,
		workingBranch: row.workingBranch,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Update mutable fields on a project.
 */
export async function updateProject(params: {
	id: string;
	name?: string;
	description?: string;
	status?: string;
	workspacePath?: string;
	githubUrl?: string;
	workingBranch?: string;
}): Promise<{ success: boolean; error?: string }> {
	const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
	if (params.name !== undefined) {
		const trimmedName = params.name.trim();
		const existing = await db
			.select({ id: projects.id })
			.from(projects)
			.where(sql`lower(${projects.name}) = lower(${trimmedName}) AND ${projects.id} != ${params.id}`)
			.limit(1);
		if (existing.length > 0) {
			return { success: false, error: `A project named "${trimmedName}" already exists. Please choose a different name.` };
		}
		updates.name = trimmedName;
	}
	if (params.description !== undefined) updates.description = params.description;
	if (params.status !== undefined) {
		const VALID_STATUSES = ["active", "idle", "paused", "completed", "archived"];
		if (!VALID_STATUSES.includes(params.status)) {
			return { success: false, error: `Invalid status "${params.status}". Must be one of: ${VALID_STATUSES.join(", ")}` };
		}
		updates.status = params.status;
	}
	if (params.workspacePath !== undefined) updates.workspacePath = params.workspacePath;
	if (params.githubUrl !== undefined) updates.githubUrl = params.githubUrl;
	if (params.workingBranch !== undefined) updates.workingBranch = params.workingBranch;
	try {
		await db.update(projects).set(updates).where(eq(projects.id, params.id));
	} catch (err) {
		// Atomic backstop for the rename pre-check race (v51 case-insensitive index).
		if (isUniqueViolation(err) && params.name !== undefined) {
			return { success: false, error: `A project named "${params.name.trim()}" already exists. Please choose a different name.` };
		}
		throw err;
	}
	logAudit({ action: "project.update", entityType: "project", entityId: params.id });
	return { success: true };
}

// ---------------------------------------------------------------------------
// Cached prepared statements for cascade operations (lazily compiled, reused).
// Must be lazy because this module is imported before migrations run on a
// fresh database — eager sqlite.prepare() would fail with "no such table".
// ---------------------------------------------------------------------------
type StmtCache = ReturnType<typeof buildStmts>;
let _stmts: StmtCache | null = null;

function buildStmts() {
	return {
		delMsgPartsByConv: sqlite.prepare("DELETE FROM message_parts WHERE message_id IN (SELECT id FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ?1))"),
		delMsgsByConv: sqlite.prepare("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ?1)"),
		delSummariesByConv: sqlite.prepare("DELETE FROM conversation_summaries WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ?1)"),
		delConversations: sqlite.prepare("DELETE FROM conversations WHERE project_id = ?1"),
		delActivityByTask: sqlite.prepare("DELETE FROM kanban_task_activity WHERE task_id IN (SELECT id FROM kanban_tasks WHERE project_id = ?1)"),
		delKanbanTasks: sqlite.prepare("DELETE FROM kanban_tasks WHERE project_id = ?1"),
		delNotes: sqlite.prepare("DELETE FROM notes WHERE project_id = ?1"),
		delHistoryByEnv: sqlite.prepare("DELETE FROM deploy_history WHERE environment_id IN (SELECT id FROM deploy_environments WHERE project_id = ?1)"),
		delDeployEnvs: sqlite.prepare("DELETE FROM deploy_environments WHERE project_id = ?1"),
		delCommentsByPr: sqlite.prepare("DELETE FROM pr_comments WHERE pr_id IN (SELECT id FROM pull_requests WHERE project_id = ?1)"),
		delPullRequests: sqlite.prepare("DELETE FROM pull_requests WHERE project_id = ?1"),
		delWebhookEvents: sqlite.prepare("DELETE FROM webhook_events WHERE project_id = ?1"),
		delWebhookConfigs: sqlite.prepare("DELETE FROM webhook_configs WHERE project_id = ?1"),
		delGithubIssues: sqlite.prepare("DELETE FROM github_issues WHERE project_id = ?1"),
		delBranchStrategies: sqlite.prepare("DELETE FROM branch_strategies WHERE project_id = ?1"),
		delCronHistoryByJob: sqlite.prepare("DELETE FROM cron_job_history WHERE job_id IN (SELECT id FROM cron_jobs WHERE project_id = ?1)"),
		delCronJobs: sqlite.prepare("DELETE FROM cron_jobs WHERE project_id = ?1"),
		delAutomationRules: sqlite.prepare("DELETE FROM automation_rules WHERE project_id = ?1"),
		delInboxMessages: sqlite.prepare("DELETE FROM inbox_messages WHERE project_id = ?1"),
		delInboxRules: sqlite.prepare("DELETE FROM inbox_rules WHERE project_id = ?1"),
		delNotifPrefs: sqlite.prepare("DELETE FROM notification_preferences WHERE project_id = ?1"),
		delCostBudgets: sqlite.prepare("DELETE FROM cost_budgets WHERE project_id = ?1"),
		delChannels: sqlite.prepare("DELETE FROM channels WHERE project_id = ?1"),
		delFreelanceListings: sqlite.prepare("DELETE FROM freelance_listings WHERE project_id = ?1"),
		delProjectSettings: sqlite.prepare("DELETE FROM settings WHERE key LIKE 'project:' || ?1 || ':%'"),
		softDeleteProject: sqlite.prepare("UPDATE projects SET status = 'deleted', updated_at = datetime('now') WHERE id = ?1"),
		hardDeleteProject: sqlite.prepare("DELETE FROM projects WHERE id = ?1"),
	};
}

function getStmts(): StmtCache {
	if (!_stmts) _stmts = buildStmts();
	return _stmts;
}

/**
 * Cascade-delete a project and all dependent records.
 * Uses cached prepared statements with subquery DELETEs in a single transaction.
 */
export async function deleteProjectCascade(id: string): Promise<{ success: boolean }> {
	// Stop agents before deleting to prevent FK failures from in-flight writes
	try {
		const { abortAllAgents, engines } = await import("../engine-manager");
		engines.get(id)?.stopAll();
		abortAllAgents(id);
	} catch { /* non-critical */ }

	const s = getStmts();
	const txn = sqlite.transaction((pid: string) => {
		s.delMsgPartsByConv.run(pid); // must come before messages (FK)
		s.delMsgsByConv.run(pid);
		s.delSummariesByConv.run(pid);
		s.delConversations.run(pid);
		s.delActivityByTask.run(pid);
		s.delKanbanTasks.run(pid);
		s.delNotes.run(pid);
		s.delHistoryByEnv.run(pid);
		s.delDeployEnvs.run(pid);
		s.delCommentsByPr.run(pid);
		s.delPullRequests.run(pid);
		s.delWebhookEvents.run(pid);
		s.delWebhookConfigs.run(pid);
		s.delGithubIssues.run(pid);
		s.delBranchStrategies.run(pid);
		s.delCronHistoryByJob.run(pid);
		s.delCronJobs.run(pid);
		s.delAutomationRules.run(pid);
		s.delInboxMessages.run(pid);
		s.delInboxRules.run(pid);
		s.delNotifPrefs.run(pid);
		s.delCostBudgets.run(pid);
		s.delChannels.run(pid);
		s.delFreelanceListings.run(pid);
		s.delProjectSettings.run(pid);
		s.softDeleteProject.run(pid);
	});
	txn(id);

	logAudit({ action: "project.delete", entityType: "project", entityId: id });
	return { success: true };
}

/**
 * Reset all project data without deleting the project itself.
 * Uses cached prepared statements with subquery DELETEs in a single transaction.
 * Keeps: project record, project settings, channels, cron job definitions,
 * and automation rule definitions.
 */
export async function resetProjectData(id: string): Promise<{ success: boolean }> {
	const s = getStmts();
	const txn = sqlite.transaction((pid: string) => {
		s.delMsgsByConv.run(pid);
		s.delSummariesByConv.run(pid);
		s.delConversations.run(pid);
		s.delActivityByTask.run(pid);
		s.delKanbanTasks.run(pid);
		s.delNotes.run(pid);
		s.delHistoryByEnv.run(pid);
		s.delDeployEnvs.run(pid);
		s.delCommentsByPr.run(pid);
		s.delPullRequests.run(pid);
		s.delWebhookEvents.run(pid);
		s.delGithubIssues.run(pid);
		s.delBranchStrategies.run(pid);
		s.delCronHistoryByJob.run(pid);
		s.delInboxMessages.run(pid);
	});
	txn(id);

	// Clear in-memory planning state so stale define_tasks results from the
	// previous session don't trigger a premature approval card on the next plan.
	const { drainTaskDefinitions } = await import("../agents/tools/planning");
	drainTaskDefinitions(id);

	logAudit({ action: "project.reset", entityType: "project", entityId: id });
	return { success: true };
}

/**
 * Persist a single project-scoped setting.
 */
export async function saveProjectSetting(
	projectId: string,
	key: string,
	value: string,
): Promise<{ success: boolean }> {
	const fullKey = `project:${projectId}:${key}`;
	// Encrypt secret values (e.g. the per-project GitHub token) before they touch the DB.
	const storedValue = PROJECT_SECRET_KEYS.has(key) && value ? encryptSecret(value) : value;
	const existing = await db
		.select()
		.from(settings)
		.where(eq(settings.key, fullKey));
	if (existing.length > 0) {
		await db
			.update(settings)
			.set({ value: storedValue, updatedAt: new Date().toISOString() })
			.where(eq(settings.key, fullKey));
	} else {
		await db.insert(settings).values({
			id: crypto.randomUUID(),
			key: fullKey,
			value: storedValue,
			category: "project",
		});
	}
	if (key === "contextWindowLimit") clearContextLimitCache();
	return { success: true };
}

/**
 * Whether the PM may automatically dispatch the NEXT kanban task after one
 * completes. Stored per-project as a raw "true"/"false" string under
 * `project:<id>:autoExecuteNextTask` (default: true when unset).
 *
 * Read live on every auto-continue decision (engine `onAgentDone` and the review
 * cycle's `triggerPMAutoContinue`) so toggling it in Project Settings takes
 * effect immediately — no restart. When false, the PM finishes the current task
 * but does NOT auto-pick the next one; the user drives progress with "continue".
 */
export async function isAutoExecuteEnabled(projectId: string): Promise<boolean> {
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, `project:${projectId}:autoExecuteNextTask`))
		.limit(1);
	return rows.length === 0 || rows[0].value !== "false";
}

/**
 * Fetch all settings for a project, returned as a flat key/value map.
 */
export async function getProjectSettings(
	projectId: string,
): Promise<Record<string, string>> {
	const prefix = `project:${projectId}:`;
	const rows = await db
		.select()
		.from(settings)
		.where(like(settings.key, `${prefix}%`));
	const result: Record<string, string> = {};
	for (const row of rows) {
		result[row.key.slice(prefix.length)] = row.value;
	}
	return result;
}

/**
 * Auto-detect a verify/lint command for a project by inspecting workspace files.
 * Uses simple heuristics — checks for common project manifests and config files.
 */
export async function detectVerifyCommand(
	projectId: string,
): Promise<{ command: string | null; reason?: string }> {
	const projectRows = await db
		.select({ workspacePath: projects.workspacePath })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	const workspacePath = projectRows[0]?.workspacePath;
	if (!workspacePath) {
		return { command: null, reason: "No workspace path configured for this project." };
	}

	const { existsSync, readFileSync } = await import("node:fs");
	const { join } = await import("node:path");

	const exists = (f: string) => existsSync(join(workspacePath, f));
	const readJson = (f: string) => {
		try { return JSON.parse(readFileSync(join(workspacePath, f), "utf-8")); }
		catch { return null; }
	};

	// TypeScript / JavaScript projects
	if (exists("tsconfig.json")) {
		const pkg = readJson("package.json");
		// Check for common scripts
		if (pkg?.scripts?.typecheck) return { command: "npm run typecheck" };
		if (pkg?.scripts?.["type-check"]) return { command: "npm run type-check" };
		if (pkg?.scripts?.lint) return { command: "npm run lint" };
		// Check if bun is used
		if (exists("bun.lockb") || exists("bunfig.toml")) return { command: "bun run tsc --noEmit" };
		return { command: "npx tsc --noEmit" };
	}

	if (exists("package.json")) {
		const pkg = readJson("package.json");
		if (pkg?.scripts?.lint) return { command: "npm run lint" };
		if (pkg?.scripts?.check) return { command: "npm run check" };
		if (exists("eslint.config.js") || exists(".eslintrc.json") || exists(".eslintrc.js")) {
			return { command: "npx eslint ." };
		}
		return { command: null, reason: "JavaScript project detected but no lint/check script found. Add a 'lint' script to package.json." };
	}

	// Rust
	if (exists("Cargo.toml")) return { command: "cargo check" };

	// Go
	if (exists("go.mod")) return { command: "go vet ./..." };

	// Python
	if (exists("pyproject.toml") || exists("setup.py")) {
		if (exists("mypy.ini") || exists(".mypy.ini")) return { command: "mypy ." };
		if (exists("pyrightconfig.json")) return { command: "pyright" };
		if (exists(".flake8") || exists("setup.cfg")) return { command: "flake8" };
		return { command: "python -m py_compile" };
	}

	// .NET — glob for *.csproj / *.sln since filenames vary
	{
		const { readdirSync } = await import("node:fs");
		try {
			const entries = readdirSync(workspacePath);
			if (entries.some((e: string) => e.endsWith(".csproj") || e.endsWith(".sln"))) {
				return { command: "dotnet build --no-restore" };
			}
		} catch { /* skip */ }
	}

	// Java / Kotlin
	if (exists("build.gradle") || exists("build.gradle.kts")) return { command: "gradle check" };
	if (exists("pom.xml")) return { command: "mvn compile" };

	// PHP
	if (exists("composer.json")) {
		if (exists("phpstan.neon") || exists("phpstan.neon.dist")) return { command: "vendor/bin/phpstan analyse" };
		return { command: "php -l" };
	}

	// Ruby
	if (exists("Gemfile")) {
		if (exists(".rubocop.yml")) return { command: "bundle exec rubocop" };
	}

	// Elixir
	if (exists("mix.exs")) return { command: "mix compile --warnings-as-errors" };

	// Dart / Flutter
	if (exists("pubspec.yaml")) return { command: "dart analyze" };

	// Swift
	if (exists("Package.swift")) return { command: "swift build" };

	// Zig
	if (exists("build.zig")) return { command: "zig build" };

	// C/C++ (CMake)
	if (exists("CMakeLists.txt")) return { command: "cmake --build build" };

	// Haskell
	if (exists("stack.yaml")) return { command: "stack build --fast" };
	{
		const { readdirSync } = await import("node:fs");
		try {
			if (readdirSync(workspacePath).some((e: string) => e.endsWith(".cabal"))) {
				return { command: "cabal build" };
			}
		} catch { /* skip */ }
	}

	return { command: null, reason: "Could not detect project type. Set a verify command manually." };
}

// Directories to skip when listing workspace files
const IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	".next",
	".nuxt",
	"dist",
	"build",
	".cache",
	".turbo",
	".yarn",
	"coverage",
	".nyc_output",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".mypy_cache",
	".pytest_cache",
	"target",
	".gradle",
]);

/**
 * List the immediate contents of a workspace directory (lazy — one level at a time).
 * The caller passes an optional subPath to navigate into subdirectories.
 * Paths in the response are relative to the workspace root for security.
 */
export async function listWorkspaceFiles(
	projectId: string,
	subPath?: string,
): Promise<Array<{ name: string; path: string; isDirectory: boolean; size: number; updatedAt: string }>> {
	const rows = await db
		.select({ workspacePath: projects.workspacePath })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	if (!rows[0]?.workspacePath) return [];

	const workspaceRoot = rows[0].workspacePath;

	// Resolve the target directory and guard against path traversal
	const targetDir = subPath
		? resolve(workspaceRoot, subPath)
		: workspaceRoot;

	// Ensure the resolved path is within the workspace root
	if (!targetDir.startsWith(workspaceRoot)) return [];

	let entries: string[];
	try {
		entries = readdirSync(targetDir);
	} catch {
		return [];
	}

	const results: Array<{ name: string; path: string; isDirectory: boolean; size: number; updatedAt: string }> = [];

	for (const name of entries) {
		// Skip hidden files/dirs and ignored directories
		if (name.startsWith(".") && name !== ".env") continue;

		const fullPath = join(targetDir, name);
		try {
			const stat = statSync(fullPath);
			const isDirectory = stat.isDirectory();

			// Skip known large/irrelevant directories
			if (isDirectory && IGNORED_DIRS.has(name)) continue;

			// Relative path from workspace root — safe to expose to the frontend
			const relativePath = relative(workspaceRoot, fullPath);

			results.push({
				name,
				path: relativePath,
				isDirectory,
				size: isDirectory ? 0 : stat.size,
				updatedAt: stat.mtime.toISOString(),
			});
		} catch {
			// Skip unreadable entries
		}
	}

	// Directories first, then files, both sorted alphabetically
	results.sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return results;
}

/**
 * Read the text content of a single workspace file.
 * The filePath must be relative to the workspace root.
 * Returns an error string instead of throwing if the file cannot be read.
 */
export async function readWorkspaceFile(
	projectId: string,
	filePath: string,
): Promise<{ content: string; error?: string }> {
	const rows = await db
		.select({ workspacePath: projects.workspacePath })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	if (!rows[0]?.workspacePath) return { content: "", error: "Project not found" };

	const workspaceRoot = rows[0].workspacePath;
	const absolutePath = resolve(workspaceRoot, filePath);

	// Guard against path traversal
	if (!absolutePath.startsWith(workspaceRoot)) {
		return { content: "", error: "Access denied" };
	}

	try {
		const stat = statSync(absolutePath);
		// Refuse to read files larger than 1 MB to avoid memory issues
		if (stat.size > 1_048_576) {
			return { content: "", error: "File too large to preview (> 1 MB)" };
		}
		const content = readFileSync(absolutePath, "utf8");
		return { content };
	} catch (err) {
		return { content: "", error: err instanceof Error ? err.message : "Could not read file" };
	}
}

const IMAGE_MIME: Record<string, string> = {
	jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
	gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
	bmp: "image/bmp", ico: "image/x-icon",
};

export async function readWorkspaceImageFile(
	projectId: string,
	filePath: string,
): Promise<{ data: string; mimeType: string; error?: string }> {
	const rows = await db
		.select({ workspacePath: projects.workspacePath })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	if (!rows[0]?.workspacePath) return { data: "", mimeType: "", error: "Project not found" };

	const workspaceRoot = rows[0].workspacePath;
	const absolutePath = resolve(workspaceRoot, filePath);

	if (!absolutePath.startsWith(workspaceRoot)) {
		return { data: "", mimeType: "", error: "Access denied" };
	}

	try {
		const stat = statSync(absolutePath);
		if (stat.size > 10_485_760) return { data: "", mimeType: "", error: "File too large to preview (> 10 MB)" };
		const ext = absolutePath.split(".").pop()?.toLowerCase() ?? "";
		const mimeType = IMAGE_MIME[ext] ?? "application/octet-stream";
		const buffer = readFileSync(absolutePath);
		return { data: buffer.toString("base64"), mimeType };
	} catch (err) {
		return { data: "", mimeType: "", error: err instanceof Error ? err.message : "Could not read file" };
	}
}

/**
 * On startup: scan the global workspace directory and auto-register any
 * subdirectories that are not yet tracked as projects.
 *
 * - Skips hidden folders (starting with ".")
 * - Uses the folder name as the project name
 * - Sets the workspacePath explicitly so no new directory is created
 * - Safe to call multiple times — only imports unregistered folders
 */
export async function syncWorkspaceFolders(): Promise<{ synced: number }> {
	try {
		const gwpRows = await db
			.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, "global_workspace_path"))
			.limit(1);

		if (gwpRows.length === 0) return { synced: 0 };

		let globalWorkspace = "";
		try { globalWorkspace = JSON.parse(gwpRows[0].value) as string; } catch { globalWorkspace = gwpRows[0].value; }

		if (!globalWorkspace) return { synced: 0 };
		const gwpAccessible = await isPathAccessible(globalWorkspace);
		if (!gwpAccessible) {
			console.warn(`[workspace-sync] Global workspace path temporarily unreachable, skipping sync: ${globalWorkspace}`);
			return { synced: 0 };
		}

		// Get all folders in the global workspace (async so a large workspace never blocks).
		const entries = await readdir(globalWorkspace, { withFileTypes: true });
		const folders = entries
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => ({ name: e.name, path: join(globalWorkspace, e.name) }));

		if (folders.length === 0) return { synced: 0 };

		// Get already-registered workspace paths
		const existing = await db.select({ workspacePath: projects.workspacePath }).from(projects);
		const registeredPaths = new Set(existing.map((r) => resolve(r.workspacePath ?? "")));

		let imported = 0;
		for (const folder of folders) {
			if (registeredPaths.has(resolve(folder.path))) continue;

			await createProjectHandler({
				name: folder.name,
				workspacePath: folder.path,
			});
			imported++;
			console.log(`[workspace-sync] Auto-registered: ${folder.name}`);
		}

		if (imported > 0) {
			console.log(`[workspace-sync] Imported ${imported} folder(s) as projects.`);
		}
		return { synced: imported };
	} catch (err) {
		console.warn("[workspace-sync] Failed:", err instanceof Error ? err.message : String(err));
		return { synced: 0 };
	}
}
