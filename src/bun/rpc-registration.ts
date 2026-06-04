import { BrowserView } from "electrobun/bun";
import type { AgentDeskRPC } from "../shared/rpc";
import { db } from "./db";
import { sqlite } from "./db/connection";
import { aiProviders, projects, settings } from "./db/schema";
import { eq } from "drizzle-orm";
import { Utils } from "electrobun/bun";
import { sendDesktopNotification } from "./notifications/desktop";
import * as settingsRpc from "./rpc/settings";
import * as providersRpc from "./rpc/providers";
import * as projectsRpc from "./rpc/projects";
import * as conversationsRpc from "./rpc/conversations";
import * as agentsRpc from "./rpc/agents";
import * as kanbanRpc from "./rpc/kanban";
import * as notesRpc from "./rpc/notes";
import * as discordRpc from "./rpc/discord";
import * as gitRpc from "./rpc/git";
import * as pluginsRpc from "./rpc/plugins";
import * as deployRpc from "./rpc/deploy";
import * as promptsRpc from "./rpc/prompts";
import * as inboxRpc from "./rpc/inbox";
import * as searchRpc from "./rpc/search";
import * as whatsappRpc from "./rpc/whatsapp";
import * as emailRpc from "./rpc/email";
import * as notificationsRpc from "./rpc/notifications";
import * as inboxRulesRpc from "./rpc/inbox-rules";
import * as cronRpc from "./rpc/cron";
import * as automationRpc from "./rpc/automation";
import * as pullsRpc from "./rpc/pulls";
import * as githubIssuesRpc from "./rpc/github-issues";
import { validateGithubToken } from "./rpc/github-api";
import * as branchStrategyRpc from "./rpc/branch-strategy";
import { invalidatePromptLogCache, clearPromptLog, openPromptLog, getPromptLogStats, getPromptLogEntry } from "./agents/prompt-logger";
import * as analyticsRpc from "./rpc/analytics";
import * as mcpRpc from "./rpc/mcp";
import * as pluginExtensionsRpc from "./rpc/plugin-extensions";
import * as lspRpc from "./rpc/lsp";
import * as dbViewerRpc from "./rpc/db-viewer";
import * as maintenanceRpc from "./rpc/maintenance";
import * as auditRpc from "./rpc/audit";
import * as backupRpc from "./rpc/backup";
import * as exportImportRpc from "./rpc/export-import";
import * as settingsExportRpc from "./rpc/settings-export";

import * as skillsRpc from "./rpc/skills";
import * as freelanceRpc from "./rpc/freelance";
import * as playgroundRpc from "./rpc/playground";
import * as issueFixerRpc from "./rpc/issue-fixer";
import * as remoteSyncRpc from "./rpc/remote-sync";
import * as activityRpc from "./rpc/activity";
import * as freelanceChatRpc from "./rpc/freelance-chat";
import * as freelanceWizardRpc from "./rpc/freelance-wizard";
import * as resetRpc from "./rpc/reset";
import * as updaterRpc from "./rpc/updater";
import * as healthRpc from "./rpc/health";
import * as dashboardRpc from "./rpc/dashboard";
import * as dashboardAgentRpc from "./rpc/dashboard-agent";
import { engines, getOrCreateEngine, broadcastToWebview, removeEngine, resolveShellApproval, resolveUserQuestion, setAppFocused, abortAllAgents, abortAgentByName, getRunningAgentCount, getRunningAgentNames, getAllRunningAgents } from "./engine-manager";
import { logError } from "./db/error-logger";

// Callbacks for settings that need in-memory sync when changed via RPC.
const settingChangeCallbacks = new Map<string, (value: unknown) => void>();
export function onSettingChange(key: string, cb: (value: unknown) => void): void {
	settingChangeCallbacks.set(key, cb);
}

/**
 * Wrap every handler in the requests map so that unhandled errors are
 * broadcast to the webview as an error toast before being re-thrown.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withErrorToast<T extends Record<string, (p: any) => any>>(handlers: T): T {
	const wrapped: Record<string, (p: unknown) => unknown> = {};
	for (const [key, fn] of Object.entries(handlers)) {
		wrapped[key] = async (params: unknown) => {
			try {
				return await fn(params);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				broadcastToWebview("showToast", { type: "error", message });
				throw err;
			}
		};
	}
	return wrapped as T;
}

// Define RPC handlers for Bun side
export const rpc = BrowserView.defineRPC<AgentDeskRPC>({
	// Agent operations can take several minutes — disable the 1 s default timeout.
	maxRequestTime: Infinity,
	handlers: {
		requests: withErrorToast({
			// Settings
			getSettings: (params) => settingsRpc.getSettings(params.category),
			getSetting: (params) => settingsRpc.getSetting(params.key, params.category),
			saveSetting: async (params) => {
				const result = await settingsRpc.saveSetting(params.key, params.value, params.category);
				if (params.key === "debug_prompts") invalidatePromptLogCache();
				settingChangeCallbacks.get(params.key)?.(params.value);
				return result;
			},

			// AI Providers
			getProviders: () => providersRpc.getProvidersList(),
			saveProvider: (params) => providersRpc.saveProviderHandler(params),
			testProvider: (params) => {
				// Fire-and-forget: run the test async (can exceed 10 s RPC timeout)
				// and push the result back via a webview message.
				providersRpc.testProviderHandler(params.id).then((result) => {
					broadcastToWebview("providerTestResult", { id: params.id, ...result });
				}).catch((err: unknown) => {
					broadcastToWebview("providerTestResult", {
						id: params.id,
						success: false,
						error: err instanceof Error ? err.message : String(err),
					});
				});
				return { queued: true };
			},
			listProviderModels: (params) => providersRpc.listProviderModelsHandler(params),
			listProviderModelsById: (params) => providersRpc.listProviderModelsByIdHandler(params.providerId),
			getProviderApiKey: (params) => providersRpc.getProviderApiKeyHandler(params.id),
			testProviderWithCredentials: (params) => providersRpc.testProviderWithCredentialsHandler(params),
			deleteProvider: (params) => providersRpc.deleteProviderHandler(params.id),
			getConnectedProviderModels: () => providersRpc.getConnectedProviderModelsHandler(),
			checkModelToolSupport: (params) => providersRpc.checkModelToolSupportHandler(params),
			getClaudeSubscriptionEnabled: () => providersRpc.getClaudeSubscriptionEnabledHandler(),

			// Projects
			getProjects: () => projectsRpc.getProjectsList(),
			createProject: (params) => projectsRpc.createProjectHandler(params),
			deleteProject: async (params) => {
				const result = await projectsRpc.deleteProjectHandler(params.id);
				removeEngine(params.id);
				return result;
			},
			getProject: (params) => projectsRpc.getProject(params.id),
			updateProject: (params) => projectsRpc.updateProject(params),
			deleteProjectCascade: async (params) => {
				const result = await projectsRpc.deleteProjectCascade(params.id);
				removeEngine(params.id);
				return result;
			},
			permanentDeleteProject: async (params) => {
				const result = await projectsRpc.permanentDeleteProjectHandler(params.id);
				if (result.success) removeEngine(params.id);
				return result;
			},
			resetProjectData: async (params) => {
				const result = await projectsRpc.resetProjectData(params.id);
				removeEngine(params.id);
				return result;
			},
			saveProjectSetting: (params) =>
				projectsRpc.saveProjectSetting(params.projectId, params.key, params.value),
			getProjectSettings: (params) => projectsRpc.getProjectSettings(params.projectId),
			listWorkspaceFiles: (params) =>
				projectsRpc.listWorkspaceFiles(params.projectId, params.subPath),
			readWorkspaceFile: (params) =>
				projectsRpc.readWorkspaceFile(params.projectId, params.filePath),
			readWorkspaceImageFile: (params) =>
				projectsRpc.readWorkspaceImageFile(params.projectId, params.filePath),
			syncWorkspaceFolders: () => projectsRpc.syncWorkspaceFolders(),

			// Conversations
			getConversations: (params) =>
				conversationsRpc.getConversations(params.projectId),
			createConversation: (params) =>
				conversationsRpc.createConversation(params.projectId, params.title),
			deleteConversation: (params) =>
				conversationsRpc.deleteConversation(params.id),
			clearConversationMessages: (params) =>
				conversationsRpc.clearConversationMessages(params.id),
			getMessageParts: (params) =>
				conversationsRpc.getMessageParts(params.messageId),
			deleteMessage: (params) =>
				conversationsRpc.deleteMessage(params.id),
			branchConversation: (params) =>
				conversationsRpc.branchConversation(params.conversationId, params.upToMessageId),
			renameConversation: (params) =>
				conversationsRpc.renameConversation(params.id, params.title),
			pinConversation: (params) =>
				conversationsRpc.pinConversation(params.id, params.pinned),

			// Messages
			getMessages: (params) =>
				conversationsRpc.getMessages(
					params.conversationId,
					params.limit,
					params.before,
				),
			// Delegate to the per-project AgentEngine
			sendMessage: (params) =>
				getOrCreateEngine(params.projectId).sendMessage(
					params.conversationId,
					params.content,
					params.metadata,
				),
			stopGeneration: (params) => {
				engines.get(params.projectId)?.stopAll();
				abortAllAgents(params.projectId);
				return { success: true };
			},
				setAppFocused: (params) => {
				setAppFocused(params.focused);
				return { success: true };
			},

			// Agents
			getAgents: () => agentsRpc.getAgentsList(),
			updateAgent: (params) => agentsRpc.updateAgent(params),
			resetAgent: (params) => agentsRpc.resetAgent(params.id),
			createAgent: (params) => agentsRpc.createAgent(params),
			deleteAgent: (params) => agentsRpc.deleteAgent(params.id),
			getAgentTools: (params) => agentsRpc.getAgentToolsList(params.agentId),
			setAgentTools: (params) => agentsRpc.setAgentToolsList(params.agentId, params.tools),
			getAllToolDefinitions: () => agentsRpc.getAllToolDefinitions(),
			resetAgentTools: (params) => agentsRpc.resetAgentToolsToDefaults(params.agentId),

			// Kanban
			getKanbanTasks: (params) => kanbanRpc.getKanbanTasks(params.projectId),
			getKanbanTask: (params) => kanbanRpc.getKanbanTask(params.id),
			createKanbanTask: async (params) => {
				const result = await kanbanRpc.createKanbanTask(params);
				broadcastToWebview("kanbanTaskUpdated", {
					projectId: params.projectId,
					taskId: result.id,
					action: "created",
				});
				return result;
			},
			updateKanbanTask: async (params) => {
				const result = await kanbanRpc.updateKanbanTask(params);
				// We need the projectId for the broadcast — get it from the task
				const task = await kanbanRpc.getKanbanTask(params.id);
				if (task) {
					broadcastToWebview("kanbanTaskUpdated", {
						projectId: task.projectId,
						taskId: params.id,
						action: "updated",
					});
				}
				return result;
			},
			moveKanbanTask: async (params) => {
				const task = await kanbanRpc.getKanbanTask(params.id);
				const result = await kanbanRpc.moveKanbanTask(
					params.id,
					params.column,
					params.position,
				);
				if (task) {
					broadcastToWebview("kanbanTaskUpdated", {
						projectId: task.projectId,
						taskId: params.id,
						action: "moved",
					});
				}
				return result;
			},
			deleteKanbanTask: async (params) => {
				const task = await kanbanRpc.getKanbanTask(params.id);
				const result = await kanbanRpc.deleteKanbanTask(params.id);
				if (task) {
					broadcastToWebview("kanbanTaskUpdated", {
						projectId: task.projectId,
						taskId: params.id,
						action: "deleted",
					});
				}
				return result;
			},

			getProjectTaskStats: () => kanbanRpc.getProjectTaskStats(),

			// Notes
			getProjectNotes: (params) => notesRpc.getProjectNotes(params.projectId),
			getNote: (params) => notesRpc.getNote(params.id),
			createNote: (params) => notesRpc.createNote(params),
			updateNote: (params) => notesRpc.updateNote(params),
			deleteNote: (params) => notesRpc.deleteNote(params.id),
			searchNotes: (params) => notesRpc.searchNotes(params.projectId, params.query),
			getWorkspacePlans: (params) => notesRpc.getWorkspacePlans(params.projectId),
			deleteWorkspacePlan: (params) => notesRpc.deleteWorkspacePlan(params.path),

			// Discord
			getDiscordConfigs: () => discordRpc.getDiscordConfigs(),
			saveDiscordConfig: (params) => discordRpc.saveDiscordConfig(params),
			deleteDiscordConfig: (params) => discordRpc.deleteDiscordConfig(params.id),
			testDiscordConnection: (params) => discordRpc.testDiscordConnection(params.token),
			getDiscordStatus: () => discordRpc.getDiscordStatus(),

			// Git
			getGitStatus: (params) => gitRpc.getGitStatus(params.projectId),
			getGitBranches: (params) => gitRpc.getGitBranches(params.projectId),
			getCurrentBranch: (params) => gitRpc.getCurrentBranch(params.projectId),
			getGitLog: (params) => gitRpc.getGitLog(params.projectId, params.limit),
			getGitDiff: (params) => gitRpc.getGitDiff(params.projectId, params.file),
			getCommitFiles: (params) => gitRpc.getCommitFiles(params.projectId, params.hash),
			gitCheckout: (params) => gitRpc.gitCheckout(params.projectId, params.branch),
			gitCreateBranch: (params) => gitRpc.gitCreateBranch(params.projectId, params.name),
			gitStageFiles: (params) => gitRpc.gitStageFiles(params.projectId, params.files),
			gitCommit: (params) => gitRpc.gitCommit(params.projectId, params.message),
			gitPush: (params) => gitRpc.gitPush(params.projectId),
			gitPull: (params) => gitRpc.gitPull(params.projectId, params.remoteBranch),
			getConflicts: (params) => gitRpc.getConflicts(params.projectId),
			getConflictDiff: (params) => gitRpc.getConflictDiff(params.projectId, params.file),
			gitDeleteBranch: (params) => gitRpc.gitDeleteBranch(params.projectId, params.name),
			gitMergeBranch: (params) => gitRpc.gitMergeBranch(params.projectId, params.branch, params.strategy),
			gitRebaseBranch: (params) => gitRpc.gitRebaseBranch(params.projectId, params.onto),
			gitAbortMerge: (params) => gitRpc.gitAbortMerge(params.projectId),
			// ── Pull Requests ──
			getPullRequests: (params) => pullsRpc.getPullRequests(params.projectId, params.state),
			createPullRequest: (params) => pullsRpc.createPullRequest(params),
			updatePullRequest: (params) => pullsRpc.updatePullRequest(params),
			mergePullRequest: (params) => pullsRpc.mergePullRequest(params.id, params.strategy, params.deleteBranch),
			deletePullRequest: (params) => pullsRpc.deletePullRequest(params.id),
			getPrDiff: (params) => pullsRpc.getPrDiff(params.id),
			getPrComments: (params) => pullsRpc.getPrComments(params.prId),
			addPrComment: (params) => pullsRpc.addPrComment(params),
			deletePrComment: (params) => pullsRpc.deletePrComment(params.id),
			generatePrDescription: (params) => pullsRpc.generatePrDescription(params.projectId, params.sourceBranch, params.targetBranch),
			// ── GitHub Issues ──
			getGithubIssues: (params) => githubIssuesRpc.getGithubIssues(params.projectId, params.state),
			syncGithubIssues: (params) => githubIssuesRpc.syncGithubIssues(params.projectId),
			createGithubIssueFromTask: (params) => githubIssuesRpc.createGithubIssueFromTask(params.taskId, params.projectId),
			linkIssueToTask: (params) => githubIssuesRpc.linkIssueToTask(params.issueId, params.taskId),
			validateGithubToken: (params) => validateGithubToken(params.token),
			// ── Branch Strategy ──
			getBranchStrategy: (params) => branchStrategyRpc.getBranchStrategy(params.projectId),
			saveBranchStrategy: (params) => branchStrategyRpc.saveBranchStrategy(params),
			createFeatureBranch: (params) => branchStrategyRpc.createFeatureBranch(params.projectId, params.taskId, params.taskTitle),
			getMergedBranches: (params) => branchStrategyRpc.getMergedBranches(params.projectId),
			cleanupMergedBranches: (params) => branchStrategyRpc.cleanupMergedBranches(params.projectId),
			// ── Analytics ──
			getProjectStats: (params) => analyticsRpc.getProjectStats(params.projectId, params.days),
			getAnalyticsSummary: (params) => analyticsRpc.getAnalyticsSummary(params.projectId),

			// Plugins
			getPlugins: () => pluginsRpc.getPluginsList(),
			togglePlugin: (params) => pluginsRpc.togglePlugin(params.name, params.enabled),
			getPluginSettings: (params) => pluginsRpc.getPluginSettings(params.name),
			savePluginSettings: (params) => pluginsRpc.savePluginSettings(params.name, params.settings),
			savePluginPrompt: (params) => pluginsRpc.savePluginPrompt(params.name, params.prompt),
			getPluginExtensions: () => pluginExtensionsRpc.getPluginExtensions(),

			// Skills
			getSkills: () => skillsRpc.getSkills(),
			getSkill: (params) => skillsRpc.getSkill(params.name),
			refreshSkills: () => skillsRpc.refreshSkills(),
			getSkillsDirectory: () => skillsRpc.getSkillsDirectory(),
			openSkillInEditor: (params) => skillsRpc.openSkillInEditor(params.name),
			openSkillsFolder: () => skillsRpc.openSkillsFolder(),
			getAvailableTools: () => skillsRpc.getAvailableTools(),
			deleteSkill: (params) => skillsRpc.deleteSkill(params.name),

			// LSP
			getLspStatus: () => lspRpc.getLspStatus(),
			installLspServer: (params) => lspRpc.installLspServerHandler(params.serverId),
			uninstallLspServer: (params) => lspRpc.uninstallLspServerHandler(params.serverId),

			// Database Viewer
			dbViewerGetTables: () => dbViewerRpc.dbViewerGetTables(),
			dbViewerGetRows: (p) => dbViewerRpc.dbViewerGetRows(p.table, p.page, p.pageSize ?? 20),
			dbViewerDeleteRow: (p) => dbViewerRpc.dbViewerDeleteRow(p.table, p.id),

			// MCP
			getMcpConfig: () => mcpRpc.getMcpConfig(),
			saveMcpConfig: (params) => mcpRpc.saveMcpConfig(params.configJson),
			getMcpStatus: () => mcpRpc.getMcpStatusRpc(),
			reconnectMcpServer: (p) => mcpRpc.reconnectMcpServerRpc(p.name),
			disconnectMcpServer: (p) => mcpRpc.disconnectMcpServerRpc(p.name),

			// Database Maintenance
			optimizeDatabase: () => maintenanceRpc.optimizeDatabase(),
			vacuumDatabase: () => maintenanceRpc.vacuumDatabase(),
			pruneDatabase: (params) => maintenanceRpc.pruneDatabase(params.days),

			// ── Phase 13: Audit Log ──
			getAuditLog: (params) => auditRpc.getAuditLog(params),
			clearAuditLog: (params) => auditRpc.clearAuditLog(params),

			// ── Phase 13: Backup/Restore ──
			createBackup: () => backupRpc.createBackup(),
			listBackups: () => backupRpc.listBackups(),
			deleteBackup: (params) => backupRpc.deleteBackup(params.filename),
			restoreBackup: (params) => backupRpc.restoreBackup(params.filename),

			// ── Phase 13: Export/Import ──
			exportProjectData: (params) => exportImportRpc.exportProjectData(params.projectId),
			importProjectData: (params) => exportImportRpc.importProjectData(params.projectId, params.data, params.mode),

			// ── Settings Export/Import ──
			exportSettings: () => settingsExportRpc.exportSettings(),
			importSettings: (params) => settingsExportRpc.importSettings(params.data),

			// ── Prompt Debug Log ──
			clearPromptLog: () => clearPromptLog(),
			openPromptLog: () => openPromptLog(),
			getPromptLogStats: (params) => getPromptLogStats(params.limit),
			getPromptLogEntry: (params) => getPromptLogEntry(params.timestamp),

			// ── File Attachments ──
			saveAttachment: async (params) => {
				const { projectId, fileName, dataBase64, type } = params;

				// Save to global workspace .attachments/ (not per-project)
				const gwpRows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "global_workspace_path")).limit(1);
				let globalWorkspace = "";
				if (gwpRows.length > 0) {
					try { globalWorkspace = JSON.parse(gwpRows[0].value) as string; } catch { globalWorkspace = gwpRows[0].value; }
				}
				if (!globalWorkspace) {
					// Fallback to project workspace
					const projRows = await db.select({ workspacePath: projects.workspacePath }).from(projects).where(eq(projects.id, projectId)).limit(1);
					globalWorkspace = projRows[0]?.workspacePath ?? "";
				}
				if (!globalWorkspace) throw new Error("No workspace path configured");

				const { mkdirSync, writeFileSync } = await import("fs");
				const { join } = await import("path");
				const attachDir = join(globalWorkspace, ".attachments");
				mkdirSync(attachDir, { recursive: true });

				const filePath = join(attachDir, fileName);
				const buffer = Buffer.from(dataBase64, "base64");
				writeFileSync(filePath, buffer);
				return { success: true, path: filePath, name: fileName, type, size: buffer.length };
			},

			// ── Prompt Enhancer ──
			enhancePrompt: async (params) => {
				const { generateText } = await import("ai");
				const { createProviderAdapter } = await import("./providers");
				const { getDefaultModel } = await import("./providers/models");

				// Resolve provider: explicit param > project setting > default
				let providerRow;
				const pid = params.providerId;
				if (pid) {
					const rows = await db.select().from(aiProviders).where(eq(aiProviders.id, pid)).limit(1);
					providerRow = rows[0];
				}
				if (!providerRow) {
					const rows = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
					providerRow = rows[0] ?? (await db.select().from(aiProviders).limit(1))[0];
				}
				if (!providerRow) throw new Error("No AI provider configured");

				const modelId = params.modelId || providerRow.defaultModel || getDefaultModel(providerRow.providerType);
				const adapter = createProviderAdapter({
					id: providerRow.id,
					name: providerRow.name,
					providerType: providerRow.providerType,
					apiKey: providerRow.apiKey ?? "",
					baseUrl: providerRow.baseUrl ?? null,
					defaultModel: providerRow.defaultModel ?? null,
				});
				const model = adapter.createModel(modelId);

				const result = await generateText({
					model,
					system: `You are an expert prompt engineer specializing in AI coding assistants. Your job is to transform vague or brief user prompts into clear, detailed, well-structured prompts that will get significantly better results from an AI agent.

When enhancing a prompt:
- Expand vague requirements into specific, actionable details
- Add technical depth: mention architecture patterns, edge cases, error handling, performance considerations where relevant
- Clarify ambiguous terms and make implicit assumptions explicit
- Add acceptance criteria or success conditions where they are missing
- Preserve the user's original intent, constraints, and any explicit instructions (e.g. "create a plan first" must be kept)
- Structure multi-part requests with clear sections or bullet points
- For coding tasks: specify expected behavior, file structure, key technical decisions, and any constraints
- Do NOT pad with filler or repeat the same points in different words
- Output ONLY the enhanced prompt — no preamble, no explanation, no meta-commentary`,
					messages: [
						{
							role: "user",
							content: "Enhance this prompt: add dark mode to the app",
						},
						{
							role: "assistant",
							content: `Add dark mode support to the application with the following requirements:

- Implement a light/dark/system theme toggle, persisting the user's preference to localStorage
- Use CSS custom properties (variables) for all colors so switching themes requires only a class change on the root element
- Respect the user's OS preference by default via \`prefers-color-scheme\` media query
- Ensure all UI components — buttons, modals, inputs, tables, sidebar, and charts — are fully themed with no hardcoded colors remaining
- Maintain WCAG AA contrast ratios in both themes
- The toggle should be accessible (keyboard navigable, aria-label set)`,
						},
						{
							role: "user",
							content: "Enhance this prompt: fix the login bug",
						},
						{
							role: "assistant",
							content: `Investigate and fix the bug on the login page with the following approach:

- Reproduce the issue first: describe the exact steps, inputs, and observed vs. expected behavior
- Check form validation logic — ensure all fields are validated before submission and errors surface clearly to the user
- Inspect the form submit handler for unhandled promise rejections, missing await, or incorrect error propagation
- Verify API error responses are caught and displayed as user-facing messages rather than silent failures
- Check for race conditions if the submit button can be clicked multiple times in quick succession (add loading/disabled state)
- Write a regression test that covers the failing scenario so it cannot silently rebreak`,
						},
						{
							role: "user",
							content: `Enhance this prompt: ${params.text}`,
						},
					],
				});

				return { enhanced: result.text.trim() };
			},

			// ── Search Workspace Files (for @ mentions) ──
			searchWorkspaceFiles: async (params) => {
				const rows = await db.select({ workspacePath: projects.workspacePath }).from(projects).where(eq(projects.id, params.projectId)).limit(1);
				const wsPath = rows[0]?.workspacePath;
				if (!wsPath) return [];

				// Try git ls-files first (fast, respects .gitignore)
				try {
					const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
						cwd: wsPath, stdout: "pipe", stderr: "pipe",
					});
					await proc.exited;
					if (proc.exitCode === 0) {
						const text = await new Response(proc.stdout).text();
						let files = text.split("\n").filter(Boolean);
						if (params.query) {
							const q = params.query.toLowerCase();
							files = files.filter((f) => f.toLowerCase().includes(q));
						}
						return files.slice(0, 200);
					}
				} catch { /* not a git repo, fallback */ }

				// Fallback: recursive readdir
				const { readdirSync, statSync } = await import("fs");
				const { join, relative } = await import("path");
				const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "vendor", "coverage", ".turbo", ".cache"]);
				const results: string[] = [];
				const q = params.query?.toLowerCase();
				const walk = (dir: string, depth: number) => {
					if (depth > 8 || results.length >= 200) return;
					try {
						for (const entry of readdirSync(dir)) {
							if (entry.startsWith(".") && entry !== ".env") continue;
							const full = join(dir, entry);
							try {
								const st = statSync(full);
								if (st.isDirectory()) {
									if (!IGNORE.has(entry)) walk(full, depth + 1);
								} else {
									const rel = relative(wsPath, full);
									if (!q || rel.toLowerCase().includes(q)) results.push(rel);
								}
							} catch { /* permission error */ }
						}
					} catch { /* readdir error */ }
				};
				walk(wsPath, 0);
				return results;
			},

			// ── Execute Shell Command (for ! mode) ──
			executeShellCommand: async (params) => {
				const rows = await db.select({ workspacePath: projects.workspacePath }).from(projects).where(eq(projects.id, params.projectId)).limit(1);
				const wsPath = rows[0]?.workspacePath;
				if (!wsPath) return { stdout: "", stderr: "No workspace configured", exitCode: 1 };

				const timeout = Math.min(params.timeout || 30_000, 60_000);
				const shellArgs: string[] = process.platform === "win32"
					? ["cmd", "/c", params.command]
					: [process.env.SHELL || "/bin/bash", "-c", params.command];

				const proc = Bun.spawn(shellArgs, { cwd: wsPath, stdout: "pipe", stderr: "pipe" });

				let timedOut = false;
				const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* empty */ } }, timeout);
				await proc.exited;
				clearTimeout(timer);

				if (timedOut) return { stdout: "", stderr: `Command timed out after ${timeout}ms`, exitCode: null };

				const [stdout, stderr] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				return { stdout, stderr, exitCode: proc.exitCode ?? null };
			},

			// ── Compact Conversation (for /compact) ──
			compactConversation: async (params) => {
				const { summarizeConversation } = await import("./agents/summarizer");
				const { getDefaultModel } = await import("./providers/models");
				const { messages: messagesTable } = await import("./db/schema");

				// Check if there are enough messages to compact (summarizer keeps last 10)
				const msgCount = await db.select({ id: messagesTable.id }).from(messagesTable)
					.where(eq(messagesTable.conversationId, params.conversationId));
				if (msgCount.length <= 10) {
					return { success: false, message: "Not enough messages to compact (need more than 10)" };
				}

				const provRows = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
				const providerRow = provRows[0] ?? (await db.select().from(aiProviders).limit(1))[0];
				if (!providerRow) return { success: false, message: "No AI provider configured" };

				await summarizeConversation({
					conversationId: params.conversationId,
					providerConfig: {
						id: providerRow.id,
						name: providerRow.name,
						providerType: providerRow.providerType,
						apiKey: providerRow.apiKey ?? "",
						baseUrl: providerRow.baseUrl ?? null,
						defaultModel: providerRow.defaultModel ?? null,
					},
					modelId: providerRow.defaultModel || getDefaultModel(providerRow.providerType),
				});

				// Notify frontend to reload messages
				broadcastToWebview("conversationCompacted", {
					conversationId: params.conversationId,
				});

				return { success: true };
			},

			// ── Open Terminal (for /terminal) ──
			openTerminal: async (params) => {
				const rows = await db.select({ workspacePath: projects.workspacePath }).from(projects).where(eq(projects.id, params.projectId)).limit(1);
				const wsPath = rows[0]?.workspacePath;
				if (!wsPath) return { success: false };

				if (process.platform === "win32") {
					Bun.spawn(["cmd", "/c", "start", "cmd", "/k", `cd /d "${wsPath}"`], { cwd: wsPath });
				} else if (process.platform === "darwin") {
					Bun.spawn(["open", "-a", "Terminal", wsPath]);
				} else {
					// Linux: try common terminals
					for (const term of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
						try { Bun.spawn([term], { cwd: wsPath }); break; } catch { continue; }
					}
				}
				return { success: true };
			},

			// ── Open External URL in default browser ──
			openExternalUrl: async (params) => {
				const { url } = params;
				if (process.platform === "win32") {
					Bun.spawn(["cmd", "/c", "start", url]);
				} else if (process.platform === "darwin") {
					Bun.spawn(["open", url]);
				} else {
					Bun.spawn(["xdg-open", url]);
				}
				return { success: true };
			},

			// ── Open local folder in OS file explorer ──
			openInExplorer: async (params) => {
				const { path } = params;
				if (process.platform === "win32") {
					Bun.spawn(["explorer", path]);
				} else if (process.platform === "darwin") {
					Bun.spawn(["open", path]);
				} else {
					Bun.spawn(["xdg-open", path]);
				}
				return { success: true };
			},

			// ── Get the app's data directory (userData: DB, logs, backups) ──
			getDataPath: () => ({ path: Utils.paths.userData }),

			// ── Shell Approval ──
			respondShellApproval: (params) => ({
				success: resolveShellApproval(params.requestId, params.decision),
			}),

			// ── User Question Response ──
			respondUserQuestion: (params) => ({
				success: resolveUserQuestion(params.requestId, params.answer),
			}),

			// ── Test OS Notification ──
			testOsNotification: async () => {
				try {
					await sendDesktopNotification("AgentDesk — Test Notification", "OS-level desktop notifications are working correctly.");
					return { success: true };
				} catch {
					return { success: false };
				}
			},

			// ── Reset Application ──
			resetApplication: () => resetRpc.resetApplication(),

			// ── System Health ──
			getHealthStatus: () => healthRpc.getHealthStatus(),
			checkDatabase: () => healthRpc.checkDatabase(),
			restartScheduler: () => healthRpc.restartScheduler(),
			cleanupEngines: () => healthRpc.cleanupEngines(),

			// Conversation Archive
			archiveConversation: (params) => conversationsRpc.archiveConversation(params.id),
			restoreConversation: (params) => conversationsRpc.restoreConversation(params.id),
			archiveOldConversations: (params) => conversationsRpc.archiveOldConversations(params.projectId, params.daysOld),
			getArchivedConversations: (params) => conversationsRpc.getArchivedConversations(params.projectId),

			// Deploy
			getEnvironments: (params) => deployRpc.getEnvironments(params.projectId),
			saveEnvironment: (params) => deployRpc.saveEnvironment(params),
			deleteEnvironment: (params) => deployRpc.deleteEnvironment(params.id),
			getDeployHistory: (params) => deployRpc.getDeployHistory(params.environmentId, params.limit),
			executeDeploy: (params) => deployRpc.executeDeploy(params.environmentId),

			// Prompts
			getPrompts: () => promptsRpc.getPrompts(),
			savePrompt: (params) => promptsRpc.savePrompt(params),
			deletePrompt: (params) => promptsRpc.deletePrompt(params.id),
			searchPrompts: (params) => promptsRpc.searchPrompts(params.query),

			// Search
			globalSearch: (params) => searchRpc.globalSearch(params.query),

			// Inbox
			getInboxMessages: (params) => inboxRpc.getInboxMessages(params),
			markAsRead: (params) => inboxRpc.markAsRead(params.id),
			markAsUnread: (params) => inboxRpc.markAsUnread(params.id),
			markAllAsRead: (params) => inboxRpc.markAllAsRead(params.projectId),
			getUnreadCount: (params) => inboxRpc.getUnreadCount(params.projectId),
			deleteInboxMessage: (params) => inboxRpc.deleteInboxMessage(params.id),
			searchInboxMessages: (params) => inboxRpc.searchInboxMessages(params.query, params.projectId),
			archiveInboxMessage: (params) => inboxRpc.archiveInboxMessage(params.id),
			unarchiveInboxMessage: (params) => inboxRpc.unarchiveInboxMessage(params.id),
			bulkArchiveInboxMessages: (params) => inboxRpc.bulkArchiveInboxMessages(params.ids),
			bulkDeleteInboxMessages: (params) => inboxRpc.bulkDeleteInboxMessages(params.ids),
			bulkMarkAsReadInboxMessages: (params) => inboxRpc.bulkMarkAsReadInboxMessages(params.ids),
			replyToInboxMessage: (params) => inboxRpc.replyToInboxMessage(params.id, params.content),

			// WhatsApp
			getWhatsAppConfigs: () => whatsappRpc.getWhatsAppConfigs(),
			saveWhatsAppConfig: (params) => whatsappRpc.saveWhatsAppConfig(params),
			deleteWhatsAppConfig: (params) => whatsappRpc.deleteWhatsAppConfig(params.id),
			getWhatsAppStatus: (params) => whatsappRpc.getWhatsAppStatus(params.id),
			connectWhatsApp: (params) => whatsappRpc.connectWhatsApp(params.id),
			getDefaultChannelProject: () => whatsappRpc.getDefaultChannelProject(),
			setDefaultChannelProject: (params) => whatsappRpc.setDefaultChannelProject(params.projectId),

			// Email
			getEmailConfigs: () => emailRpc.getEmailConfigs(),
			saveEmailConfig: (params) => emailRpc.saveEmailConfig(params),
			deleteEmailConfig: (params) => emailRpc.deleteEmailConfig(params.id),
			testEmailConnection: (params) => emailRpc.testEmailConnection(params),

			// Notifications
			getNotificationPreferences: (params) => notificationsRpc.getNotificationPreferences(params),
			saveNotificationPreference: (params) => notificationsRpc.saveNotificationPreference(params),

			// Inbox Rules
			getInboxRules: (params) => inboxRulesRpc.getInboxRulesList(params.projectId),
			createInboxRule: (params) => inboxRulesRpc.createInboxRule(params),
			updateInboxRule: (params) => inboxRulesRpc.updateInboxRule(params),
			deleteInboxRule: (params) => inboxRulesRpc.deleteInboxRule(params.id),

			// ── Cron Jobs ──
			getCronJobs: (params) => cronRpc.getCronJobs(params),
			createCronJob: (params) => cronRpc.createCronJob(params),
			updateCronJob: (params) => cronRpc.updateCronJob(params),
			deleteCronJob: (params) => cronRpc.deleteCronJob(params.id),
			getCronJobHistory: (params) => cronRpc.getCronJobHistory(params),
			clearCronJobHistory: (params) => cronRpc.clearCronJobHistory(params),
			previewCronSchedule: (params) => cronRpc.previewCronSchedule(params),
			triggerCronJob: (params) => cronRpc.triggerCronJob(params),
			// ── Automation Rules ──
			getAutomationRules: (params) => automationRpc.getAutomationRules(params),
			createAutomationRule: (params) => automationRpc.createAutomationRule(params),
			updateAutomationRule: (params) => automationRpc.updateAutomationRule(params),
			deleteAutomationRule: (params) => automationRpc.deleteAutomationRule(params.id),
			getAutomationTemplates: () => automationRpc.getAutomationTemplates(),
			// Agent control — inline model: no pause/resume/redirect, just stop
			resumeAgent: async (_params) => ({ success: false }),
			redirectAgent: async (_params) => ({ success: false }),
			stopAgent: (params) => {
				const aborted = abortAgentByName(params.projectId, params.agentName);
				return { success: aborted };
			},

			stopAllAgents: (params) => {
				const count = getRunningAgentCount(params.projectId);
				engines.get(params.projectId)?.stopAll();
				abortAllAgents(params.projectId);
				return { success: true, stoppedCount: count };
			},

			getRunningAgents: (params) => {
				const names = getRunningAgentNames(params.projectId);
				if (names.length === 0) return [];
				// Look up display names from the agents table in one query
				const placeholders = names.map(() => "?").join(", ");
				const rows = sqlite
					.prepare(`SELECT name, display_name FROM agents WHERE name IN (${placeholders})`)
					.all(...names) as Array<{ name: string; display_name: string }>;
				const displayNameMap = new Map(rows.map((r) => [r.name, r.display_name]));
				return names.map((name, i) => ({
					id: `agent-${i}-${name}`,
					name,
					displayName: displayNameMap.get(name) ?? name,
					taskDescription: "",
					status: "running" as const,
				}));
			},

			getPmStatus: (params) => {
				const engine = engines.get(params.projectId);
				if (!engine) return { isStreaming: false, conversationId: null };
				return {
					isStreaming: engine.isProcessing(),
					conversationId: engine.getActiveConversationId(),
				};
			},

			getActiveProjectAgents: () => {
				const result: Array<{ projectId: string; agentCount: number }> = [];
				const seen = new Set<string>();

				// Engine-based projects (PM streaming or PM-dispatched sub-agents)
				for (const [projectId, engine] of engines) {
					seen.add(projectId);
					const subAgentCount = getRunningAgentCount(projectId);
					// If sub-agents are running, show their count.
					// If only the PM itself is processing (planning phase or writing summary),
					// count it as 1 so the dashboard reflects any active work.
					const total = subAgentCount > 0 ? subAgentCount : (engine.isProcessing() ? 1 : 0);
					if (total > 0) result.push({ projectId, agentCount: total });
				}

				// Projects with registered running agents that have no engine (e.g. direct
				// runInlineAgent calls from the scheduler for non-PM agent_task jobs).
				const allRunning = getAllRunningAgents();
				for (const [projectId, agentNames] of Object.entries(allRunning)) {
					if (!seen.has(projectId) && agentNames.length > 0) {
						result.push({ projectId, agentCount: agentNames.length });
					}
				}

				return result;
			},

			// System
			selectDirectory: () => {
				// Defer the dialog to the next tick so RPC response is sent first
				// (native dialog blocks the event loop)
				setTimeout(() => {
					Utils.openFileDialog({
						canChooseFiles: false,
						canChooseDirectory: true,
						allowsMultipleSelection: false,
					}).then((paths) => {
						const selectedPath = Array.isArray(paths) && paths.length > 0 ? String(paths[0]) : null;
						broadcastToWebview("directorySelected", { path: selectedPath });
					}).catch(() => {
						broadcastToWebview("directorySelected", { path: null });
					});
				}, 0);
				return { queued: true };
			},
			getAppInfo: () => {
				return {
					version: "0.1.0",
					platform: process.platform,
					dataDir: Utils.paths.userData,
				};
			},
			isFirstLaunch: async () => {
				const { join } = await import("path");
				const flagPath = join(Utils.paths.userData, "first_launch");
				const exists = await Bun.file(flagPath).exists();
				if (exists) return false;

				// Backwards-compat: existing installs that already have a user_name set
				// have completed onboarding before this file-based check was introduced.
				// Create the file so future checks are a fast fs lookup.
				const userName = await db.select({ value: settings.value }).from(settings)
					.where(eq(settings.key, "user_name"));
				if (userName.length > 0) {
					const { mkdirSync, writeFileSync } = await import("fs");
					mkdirSync(Utils.paths.userData, { recursive: true });
					writeFileSync(flagPath, "");
					return false;
				}

				return true;
			},
			markOnboardingComplete: async () => {
				const { join } = await import("path");
				const { mkdirSync, writeFileSync } = await import("fs");
				const flagPath = join(Utils.paths.userData, "first_launch");
				mkdirSync(Utils.paths.userData, { recursive: true });
				writeFileSync(flagPath, "");
				return { success: true };
			},

			// Dashboard PM Chat
			sendDashboardMessage: (params) => dashboardRpc.sendDashboardMessage(params),
			abortDashboardMessage: (params) => dashboardRpc.abortDashboardMessage(params),
			clearDashboardSession: (params) => dashboardRpc.clearDashboardSession(params),

			// Dashboard Custom-Agent Chat
			getChatEnabledAgents:       ()       => dashboardAgentRpc.getChatEnabledAgents(),
			sendDashboardAgentMessage:  (params) => dashboardAgentRpc.sendDashboardAgentMessage(params),
			abortDashboardAgentMessage: (params) => dashboardAgentRpc.abortDashboardAgentMessage(params),
			clearDashboardAgentSession: (params) => dashboardAgentRpc.clearDashboardAgentSession(params),

			// ── Council ──
			startCouncil: async (params) => {
				const { startCouncilSession } = await import("./rpc/council");
				return startCouncilSession(params.query, params.context);
			},
			stopCouncil: async (params) => {
				const { stopCouncilSession } = await import("./rpc/council");
				stopCouncilSession(params.sessionId);
				return { success: true };
			},
			answerCouncilQuestion: async (params) => {
				const { answerCouncilQuestion } = await import("./rpc/council");
				answerCouncilQuestion(params.sessionId, params.questionId, params.answer);
				return { success: true };
			},

			// ── Playground ──
			playgroundSend: (params) => playgroundRpc.playgroundSend(params),
			playgroundStop: () => playgroundRpc.playgroundStop(),
			newPlayground: () => playgroundRpc.newPlayground(),
			getPlaygroundState: () => playgroundRpc.getPlaygroundState(),
			createProjectFromPlayground: () => playgroundRpc.createProjectFromPlayground(),
			exportPlaygroundZip: () => playgroundRpc.exportPlaygroundZip(),
			getPlaygroundSource: () => playgroundRpc.getPlaygroundSource(),
			savePlaygroundFile: (params) => playgroundRpc.savePlaygroundFile(params),
			setPlaygroundPreviewUrl: (params) => playgroundRpc.setPlaygroundPreviewUrl(params),
			getPlaygroundDevServers: () => playgroundRpc.getPlaygroundDevServers(),
			stopPlaygroundDevServer: (params) => playgroundRpc.stopPlaygroundDevServer(params),
			startPlaygroundDevServer: (params) => playgroundRpc.startPlaygroundDevServer(params),
			deployPlayground: () => playgroundRpc.deployPlayground(),

			// ── Issue Fixer ──
			getIssueFixerConfig: (params) => issueFixerRpc.getIssueFixerConfig(params),
			saveIssueFixerConfig: (params) => issueFixerRpc.saveIssueFixerConfig(params),
			listIssueFixRuns: (params) => issueFixerRpc.listIssueFixRuns(params),
			getIssueFixRun: (params) => issueFixerRpc.getIssueFixRun(params),
			getActiveIssueFixRun: (params) => issueFixerRpc.getActiveIssueFixRun(params),
			pollIssueFixerNow: (params) => issueFixerRpc.pollIssueFixerNow(params),
			cancelIssueFixRun: (params) => issueFixerRpc.cancelIssueFixRun(params),
			triggerIssueFixManually: (params) => issueFixerRpc.triggerIssueFixManually(params),
			getIssueFixerKeywordCatalog: () => issueFixerRpc.getIssueFixerKeywordCatalog(),
			getRemoteSyncConfig: (params) => remoteSyncRpc.getRemoteSyncConfig(params),
			saveRemoteSyncConfig: (params) => remoteSyncRpc.saveRemoteSyncConfig(params),
			revealRemoteSyncSecret: (params) => remoteSyncRpc.revealRemoteSyncSecret(params),
			testRemoteConnection: (params) => remoteSyncRpc.testRemoteConnection(params),
			browseRemoteDir: (params) => remoteSyncRpc.browseRemoteDir(params),
			computeRemotePullConflicts: (params) => remoteSyncRpc.computeRemotePullConflicts(params),
			startRemotePull: (params) => remoteSyncRpc.startRemotePull(params),
			computeRemotePushDiff: (params) => remoteSyncRpc.computeRemotePushDiff(params),
			getRemotePushFileDiff: (params) => remoteSyncRpc.getRemotePushFileDiff(params),
			startRemotePush: (params) => remoteSyncRpc.startRemotePush(params),
			listRemoteSyncRuns: (params) => remoteSyncRpc.listRemoteSyncRuns(params),
			cancelRemoteSync: (params) => remoteSyncRpc.cancelRemoteSync(params),
			// ── Unread activity ──
			getUnreadActivity: () => activityRpc.getUnreadActivity(),
			markActivitySeen: (params) => activityRpc.markActivitySeen(params),

			// ── Freelance ──
			"freelance.getFeatureEnabled": () => freelanceRpc.getFeatureEnabled(),
			"freelance.getSettings": () => freelanceRpc.getSettings(),
			"freelance.saveSettings": (params) => freelanceRpc.saveSettings(params),
			"freelance.getListings": (params) => freelanceRpc.getListings(params),
			"freelance.getListingCounts": () => freelanceRpc.getListingCounts(),
			"freelance.approveListing": (params) => freelanceRpc.approveListing(params),
			"freelance.deleteListing": (params) => freelanceRpc.deleteListing(params),
			"freelance.triggerFetch": () => freelanceRpc.triggerFetch(),
			"freelance.deleteAllListings": () => freelanceRpc.deleteAllListings(),
			"freelance.chat.getMessages": (params) => freelanceChatRpc.getMessages(params),
			"freelance.chat.sendMessage": (params) => freelanceChatRpc.sendMessage(params),
			"freelance.chat.regenerate": (params) => freelanceChatRpc.regenerate(params),
			"freelance.chat.clearMessages": (params) => freelanceChatRpc.clearMessages(params),
			"freelance.chat.stop": (params) => freelanceChatRpc.stopChat(params),
			"freelance.wizard.start": (params) => freelanceWizardRpc.startWizard(params),
			"freelance.wizard.stop": (params) => freelanceWizardRpc.stopWizard(params),
			"freelance.wizard.analyzeListing": (params) => freelanceWizardRpc.analyzeListing(params),
			"freelance.shortlistListings": (params) => freelanceWizardRpc.shortlistListings(params),
			"freelance.markListingDone": (params) => freelanceRpc.markListingDone(params),

			// ── Updater ──
			checkForUpdate: () => updaterRpc.checkForUpdate(),
			downloadUpdate: () => updaterRpc.downloadUpdate(),
			applyUpdate: () => updaterRpc.applyUpdate(),
		}),
		messages: {
			log: ({ level, message }) => {
				const fn =
					level === "error"
						? console.error
						: level === "warn"
							? console.warn
							: console.log;
				fn(`[renderer] ${message}`);
			},
			logClientError: ({ type, message, stack }) => {
				console.error(`[renderer:${type}] ${message}`);
				logError("renderer", type, message, stack);
			},
		},
	},
});
