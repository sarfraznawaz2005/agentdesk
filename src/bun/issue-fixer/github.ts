// ---------------------------------------------------------------------------
// Issue Fixer — GitHub API client
//
// Thin wrappers over githubFetch (which authenticates with the resolved token)
// for the operations the Issue Fixer needs: list open issues + issue/PR comments
// since a cursor, fetch a single issue, create a PR, and post comments.
// All calls are OUTBOUND (no inbound webhooks) so they work behind NAT.
// ---------------------------------------------------------------------------

import { githubFetch } from "../rpc/github-api";

export interface GhIssue {
	number: number;
	title: string;
	body: string | null;
	author: string;
	authorAssociation: string; // OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE
	labels: string[];
	htmlUrl: string;
	createdAt: string;
	updatedAt: string;
	isPullRequest: boolean;
}

export interface GhComment {
	id: number;
	issueNumber: number;
	body: string;
	author: string;
	authorAssociation: string;
	htmlUrl: string;
	isPullRequest: boolean; // true when the comment is on a PR conversation
	createdAt: string;
}

interface RawIssue {
	number: number;
	title: string;
	body: string | null;
	user?: { login?: string };
	author_association?: string;
	labels?: Array<{ name?: string } | string>;
	html_url: string;
	created_at: string;
	updated_at: string;
	pull_request?: unknown;
}

interface RawComment {
	id: number;
	body: string;
	user?: { login?: string };
	author_association?: string;
	html_url: string;
	issue_url: string;
	created_at: string;
}

function mapLabels(labels: RawIssue["labels"]): string[] {
	if (!Array.isArray(labels)) return [];
	return labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);
}

function mapIssue(r: RawIssue): GhIssue {
	return {
		number: r.number,
		title: r.title ?? "",
		body: r.body ?? null,
		author: r.user?.login ?? "",
		authorAssociation: r.author_association ?? "NONE",
		labels: mapLabels(r.labels),
		htmlUrl: r.html_url,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		isPullRequest: r.pull_request != null,
	};
}

function issueNumberFromUrl(issueUrl: string): number {
	const m = issueUrl.match(/\/issues\/(\d+)$/);
	return m ? parseInt(m[1], 10) : 0;
}

/**
 * List open issues updated at/after `sinceIso`. NOTE: GitHub's issues endpoint
 * also returns PRs (filtered via isPullRequest by the caller).
 */
export async function listOpenIssuesSince(
	owner: string,
	repo: string,
	sinceIso: string,
	token?: string,
): Promise<GhIssue[]> {
	const q = `?state=open&since=${encodeURIComponent(sinceIso)}&sort=updated&direction=asc&per_page=100`;
	const res = await githubFetch(`/repos/${owner}/${repo}/issues${q}`, {}, token);
	if (!res.ok || !Array.isArray(res.data)) return [];
	return (res.data as RawIssue[]).map(mapIssue);
}

/**
 * List issue AND PR conversation comments created at/after `sinceIso` (one call —
 * PR comments are "issue comments" in the GitHub API). `isPullRequest` distinguishes them.
 */
export async function listIssueCommentsSince(
	owner: string,
	repo: string,
	sinceIso: string,
	token?: string,
): Promise<GhComment[]> {
	const q = `?since=${encodeURIComponent(sinceIso)}&sort=created&direction=asc&per_page=100`;
	const res = await githubFetch(`/repos/${owner}/${repo}/issues/comments${q}`, {}, token);
	if (!res.ok || !Array.isArray(res.data)) return [];
	return (res.data as RawComment[]).map((c) => ({
		id: c.id,
		issueNumber: issueNumberFromUrl(c.issue_url),
		body: c.body ?? "",
		author: c.user?.login ?? "",
		authorAssociation: c.author_association ?? "NONE",
		htmlUrl: c.html_url,
		isPullRequest: c.html_url.includes("/pull/"),
		createdAt: c.created_at,
	}));
}

/** Fetch a single issue (full context). */
export async function getIssue(
	owner: string,
	repo: string,
	number: number,
	token?: string,
): Promise<GhIssue | null> {
	const res = await githubFetch(`/repos/${owner}/${repo}/issues/${number}`, {}, token);
	if (!res.ok || typeof res.data !== "object" || res.data == null) return null;
	return mapIssue(res.data as RawIssue);
}

/** Fetch the PR head branch ref for a PR number (used by the PR-feedback loop). */
export async function getPullHeadBranch(
	owner: string,
	repo: string,
	number: number,
	token?: string,
): Promise<string | null> {
	const res = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`, {}, token);
	if (!res.ok || typeof res.data !== "object" || res.data == null) return null;
	const head = (res.data as { head?: { ref?: string } }).head;
	return head?.ref ?? null;
}

/** Create a pull request. Never merges. */
export async function createPullRequest(
	owner: string,
	repo: string,
	opts: { title: string; body: string; head: string; base: string; draft?: boolean },
	token?: string,
): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> {
	const res = await githubFetch(
		`/repos/${owner}/${repo}/pulls`,
		{
			method: "POST",
			body: JSON.stringify({
				title: opts.title,
				body: opts.body,
				head: opts.head,
				base: opts.base,
				draft: opts.draft ?? false,
			}),
		},
		token,
	);
	const data = res.data as {
		number?: number;
		html_url?: string;
		message?: string;
		errors?: Array<{ message?: string }>;
	};
	if (!res.ok || !data.number) {
		// GitHub's 422 puts the useful text (e.g. "A pull request already exists…") in errors[].message.
		const detail = (data.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
		const msg = `GitHub API ${res.status}: ${data.message ?? ""}${detail ? ` — ${detail}` : ""}`.trim();
		return { ok: false, error: msg || `GitHub API ${res.status}` };
	}
	return { ok: true, number: data.number, url: data.html_url ?? "" };
}

/** Find an open PR whose head is the given branch (used to adopt a pre-existing PR). */
export async function findOpenPullByHead(
	owner: string,
	repo: string,
	headBranch: string,
	token?: string,
): Promise<{ number: number; url: string } | null> {
	const res = await githubFetch(
		`/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(headBranch)}`,
		{},
		token,
	);
	if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return null;
	const pr = res.data[0] as { number?: number; html_url?: string };
	return pr.number ? { number: pr.number, url: pr.html_url ?? "" } : null;
}

/** Post a comment on an issue (or PR conversation — same endpoint). */
export async function postIssueComment(
	owner: string,
	repo: string,
	issueNumber: number,
	body: string,
	token?: string,
): Promise<{ ok: boolean; error?: string }> {
	const res = await githubFetch(
		`/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
		{ method: "POST", body: JSON.stringify({ body }) },
		token,
	);
	if (!res.ok) {
		const data = res.data as { message?: string };
		return { ok: false, error: `GitHub API ${res.status}: ${data.message ?? ""}` };
	}
	return { ok: true };
}
