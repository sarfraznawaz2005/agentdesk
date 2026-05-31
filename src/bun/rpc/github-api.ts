/**
 * Minimal GitHub REST API client using fetch + stored PAT.
 * No external dependencies — uses the github_pat from settings.
 */
import { db } from "../db";
import { settings, projects } from "../db/schema";
import { eq, and } from "drizzle-orm";

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
