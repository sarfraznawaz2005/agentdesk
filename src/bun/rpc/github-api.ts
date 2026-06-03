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

/**
 * `git -c ...` args that authenticate GitHub HTTPS remote operations with a token
 * WITHOUT invoking any credential helper. This prevents Git Credential Manager from
 * popping its interactive "Select an account" GUI during autonomous fetch/pull/ls-remote.
 *   - `credential.helper=` (empty) clears the configured helper list (no GCM) for this command.
 *   - the per-host extraheader supplies Basic auth from the token.
 * Use by prefixing git args: runGit([...gitAuthArgs(token), "fetch", "origin"], cwd).
 */
export function gitAuthArgs(token: string): string[] {
	const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
	return [
		"-c",
		"credential.helper=",
		"-c",
		`http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
	];
}

/**
 * Prefix for a network git op (push/fetch/pull) that authenticates a GitHub HTTPS remote
 * automatically — via an inline header with the credential helper DISABLED — so the op never
 * prompts (no Git Credential Manager "Select an account") and never stores a credential.
 *
 * Returns `[]` (i.e. unchanged behaviour) when: origin isn't an HTTPS github.com remote (SSH
 * uses keys and won't prompt; non-GitHub remotes can't use our token), or no token is configured.
 * Use by prefixing: runGit([...(await githubAuthPrefix({ workspacePath, projectId })), "push", …]).
 */
export async function githubAuthPrefix(opts: {
	workspacePath: string;
	projectId?: string;
	abortSignal?: AbortSignal;
}): Promise<string[]> {
	try {
		const remote = await runGit(["remote", "get-url", "origin"], opts.workspacePath, opts.abortSignal);
		if (remote.exitCode !== 0 || !/^https:\/\/github\.com\//i.test(remote.stdout.trim())) return [];
		const token = await resolveGitHubToken({ projectId: opts.projectId, workspacePath: opts.workspacePath });
		return token ? gitAuthArgs(token) : [];
	} catch {
		return [];
	}
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
 *  - The token is supplied via an ephemeral inline auth header (`gitAuthArgs`) with the
 *    credential helper DISABLED — never embedded in the push URL and never written via
 *    `git remote set-url`/`git config`. An embedded-credential URL with an active helper makes
 *    git store an `x-access-token` account in the user's credential manager (causing
 *    "Select an account" prompts on their own pushes). Error text is redacted.
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

	// Authenticate the push WITHOUT embedding credentials in the URL and WITH the credential
	// helper disabled (gitAuthArgs). Embedding `x-access-token:<token>@github.com` while Git
	// Credential Manager is active makes git STORE an `x-access-token` account in the user's
	// credential store — which then pollutes their GCM and triggers a "Select an account"
	// prompt on their OWN pushes. Supplying auth via an inline header (and disabling the
	// helper) leaves no stored credential behind.
	const pushUrl = `https://github.com/${owner}/${repo}.git`;
	const res = await runGit(
		[...gitAuthArgs(token), "push", pushUrl, `${branch}:${branch}`],
		workspacePath,
		abortSignal,
	);
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
