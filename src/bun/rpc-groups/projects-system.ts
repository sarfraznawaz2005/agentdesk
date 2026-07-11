import * as projectsRpc from "../rpc/projects";
import * as deployRpc from "../rpc/deploy";
import { removeEngine, broadcastToWebview } from "../engine-manager";
import { db } from "../db";
import { settings, projects } from "../db/schema";
import { eq } from "drizzle-orm";
import { Utils } from "electrobun/bun";
import { sendDesktopNotification } from "../notifications/desktop";
import { isNetworkAvailable } from "../lib/network";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (params: any) => any> = {
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
	getProjectRepoState: (params) => projectsRpc.getProjectRepoState(params.projectId),
	cloneProjectRepo: (params) => projectsRpc.cloneProjectRepo(params.projectId),

	// Deploy
	getEnvironments: (params) => deployRpc.getEnvironments(params.projectId),
	saveEnvironment: (params) => deployRpc.saveEnvironment(params),
	deleteEnvironment: (params) => deployRpc.deleteEnvironment(params.id),
	getDeployHistory: (params) => deployRpc.getDeployHistory(params.environmentId, params.limit),
	executeDeploy: (params) => deployRpc.executeDeploy(params.environmentId),

	// File Attachments
	saveAttachment: async (params) => {
		const { projectId, dataBase64, type } = params;
		// fileName can come from arbitrary text (e.g. a Collections note title
		// attached to chat, which has no filesystem-legality constraint) — strip
		// characters Windows/macOS/Linux all forbid in a single path segment
		// before it's ever joined into a real fs path below.
		const fileName = params.fileName.replace(/[\\/:*?"<>|]/g, "_").trim() || "attachment";

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

	// Search Workspace Files (for @ mentions)
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

	// Execute Shell Command (for ! mode)
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

	// System ops
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
	checkInternet: async () => {
		const online = await isNetworkAvailable();
		return { online };
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

	// Open
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
	openExternalUrl: async (params) => {
		const { url } = params;
		if (process.platform === "win32") {
			// Open via PowerShell Start-Process — it invokes the URL's protocol handler
			// (the default browser). Avoids two Windows traps:
			//   • `cmd /c start <url>` splits the URL on `&` (truncating query strings,
			//     e.g. Kanboard's ?controller=...&action=show&task_id=...);
			//   • `explorer.exe <url>` can open File Explorer instead of the browser.
			// Single-quote the URL so `&` is literal; double any embedded single quotes.
			const psUrl = url.replace(/'/g, "''");
			Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", `Start-Process '${psUrl}'`]);
		} else if (process.platform === "darwin") {
			Bun.spawn(["open", url]);
		} else {
			Bun.spawn(["xdg-open", url]);
		}
		return { success: true };
	},
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
	getDataPath: () => ({ path: Utils.paths.userData }),

	// Test OS Notification
	testOsNotification: async () => {
		try {
			await sendDesktopNotification("AgentDesk — Test Notification", "OS-level desktop notifications are working correctly.");
			return { success: true };
		} catch {
			return { success: false };
		}
	},
};
