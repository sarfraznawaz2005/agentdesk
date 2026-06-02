/**
 * Minimal GitHub REST API client using fetch + stored PAT.
 * No external dependencies — uses the github_pat from settings.
 */
import { db } from "../db";
import { settings, projects } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { runGit } from "../lib/git-runner";

async function getGitHubPAT(): Promise<string | null> {
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(and(eq(settings.key, "github_pat"), eq(settings.category, "github")))
		.limit(1);
	const raw = rows[0]?.value;
	if (!raw) return null;
	try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Per-project custom GitHub token, stored via saveProjectSetting under
 * `project:<projectId>:githubToken` (category "project"). Used when a project
 * opts into a custom token instead of the global default.
 */
async function getProjectGitHubToken(projectId: string): Promise<string | null> {
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, `project:${projectId}:githubToken`))
		.limit(1);
	const raw = rows[0]?.value;
	if (!raw) return null;
	try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Legacy fallback — the token the old git_pr tool used to read
 * (key "githubToken", category "git"). Kept so existing users who configured it
 * there keep working after the key was unified onto github_pat.
 */
async function getLegacyGitToken(): Promise<string | null> {
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(and(eq(settings.key, "githubToken"), eq(settings.category, "git")))
		.limit(1);
	const raw = rows[0]?.value;
	if (!raw) return null;
	try { return JSON.parse(raw); } catch { return raw; }
}

/** Resolve the project that owns a given workspace path (exact match). */
async function getProjectIdByWorkspace(workspacePath: string): Promise<string | null> {
	const rows = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.workspacePath, workspacePath))
		.limit(1);
	return rows[0]?.id ?? null;
}

/**
 * Resolve a GitHub token using a single, consistent order so every caller
 * authenticates the same way:
 *   1. per-project custom token (if the project opted into one),
 *   2. the global `github_pat` (what Settings → GitHub saves),
 *   3. the legacy `githubToken`/`git` setting (back-compat).
 *
 * Pass `projectId` directly when known, or `workspacePath` to resolve it.
 */
export async function resolveGitHubToken(
	opts?: { projectId?: string; workspacePath?: string },
): Promise<string | null> {
	let projectId = opts?.projectId ?? null;
	if (!projectId && opts?.workspacePath) {
		projectId = await getProjectIdByWorkspace(opts.workspacePath);
	}
	if (projectId) {
		const projectToken = await getProjectGitHubToken(projectId);
		if (projectToken) return projectToken;
	}
	const globalToken = await getGitHubPAT();
	if (globalToken) return globalToken;
	return await getLegacyGitToken();
}

/** Replace every occurrence of a secret with *** so it never appears in output/logs. */
function redactToken(text: string, token: string): string {
	if (!token) return text;
	return text.split(token).join("***");
}

/**
 * Push a single branch to origin authenticated with a resolved GitHub token,
 * WITHOUT persisting the token to git config or logging it. Built for autonomous
 * flows (e.g. Issue Fixer) where no human is present to approve a push.
 *
 * Safety contract:
 *  - Pushes ONLY the explicitly-named branch (refspec `branch:branch`). There is
 *    no "default to current branch", so it cannot accidentally push a checked-out
 *    base branch. Callers MUST pass a dedicated feature branch, never the
 *    base/working branch (also enforced by the Issue Fixer shell guard + orchestrator).
 *  - The token is passed only in an ephemeral push URL argument; it is never
 *    written via `git remote set-url`/`git config`, and any error text is redacted.
 */
export async function pushBranchAuthenticated(opts: {
	workspacePath: string;
	branch: string;
	projectId?: string;
	abortSignal?: AbortSignal;
}): Promise<{ ok: boolean; error?: string }> {
	const { workspacePath, branch, projectId, abortSignal } = opts;
	if (!branch || !branch.trim()) return { ok: false, error: "No branch specified" };

	const token = await resolveGitHubToken({ projectId, workspacePath });
	if (!token) return { ok: false, error: "GitHub token not configured" };

	const remote = await runGit(["remote", "get-url", "origin"], workspacePath, abortSignal);
	if (remote.exitCode !== 0 || !remote.stdout.trim()) {
		return { ok: false, error: "Could not read origin remote URL" };
	}
	// Accept both https and ssh (scp-like) GitHub remotes.
	const m = remote.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
	if (!m) return { ok: false, error: `origin is not a GitHub URL: ${remote.stdout.trim()}` };
	const [, owner, repo] = m;

	const authUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
	const res = await runGit(["push", authUrl, `${branch}:${branch}`], workspacePath, abortSignal);
	if (res.exitCode !== 0) {
		return { ok: false, error: redactToken(res.stderr || res.stdout || "git push failed", token) };
	}
	return { ok: true };
}

export async function githubFetch(
	path: string,
	options: RequestInit = {},
	pat?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
	const token = pat ?? (await getGitHubPAT());
	if (!token) return { ok: false, status: 401, data: { message: "GitHub PAT not configured" } };

	const res = await fetch(`https://api.github.com${path}`, {
		...options,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"Content-Type": "application/json",
			...(options.headers ?? {}),
		},
	});

	let data: unknown;
	try {
		data = await res.json();
	} catch {
		data = {};
	}
	return { ok: res.ok, status: res.status, data };
}

/** Extract owner/repo from a GitHub URL stored in projects.github_url */
export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
	try {
		const u = new URL(url);
		const parts = u.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
		if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
	} catch { /* empty */ }
	return null;
}

export async function getProjectGithubRepo(
	projectId: string,
): Promise<{ owner: string; repo: string; pat: string } | null> {
	const rows = await db
		.select({ githubUrl: projects.githubUrl })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	const url = rows[0]?.githubUrl;
	if (!url) return null;
	const parsed = parseGithubUrl(url);
	if (!parsed) return null;
	const pat = await getGitHubPAT();
	if (!pat) return null;
	return { ...parsed, pat };
}

/** Validates a GitHub PAT by calling the /user endpoint. Returns username on success. */
export async function validateGithubToken(token: string): Promise<{ valid: boolean; username?: string; error?: string }> {
	const res = await fetch("https://api.github.com/user", {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (res.ok) {
		const data = (await res.json()) as { login?: string };
		return { valid: true, username: data.login };
	}
	const data = (await res.json()) as { message?: string };
	return { valid: false, error: data.message ?? `HTTP ${res.status}` };
}

/** Returns a specific error string describing what's missing, or null if fully configured. */
export async function getGithubConfigError(projectId: string): Promise<string | null> {
	const rows = await db
		.select({ githubUrl: projects.githubUrl })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	const url = rows[0]?.githubUrl;
	if (!url) return "GitHub Repository URL not set — add it in Project Settings > General";
	if (!parseGithubUrl(url)) return "Invalid GitHub Repository URL — expected https://github.com/owner/repo";
	const pat = await getGitHubPAT();
	if (!pat) return "GitHub Personal Access Token not configured — add it in Settings > GitHub";
	return null;
}
