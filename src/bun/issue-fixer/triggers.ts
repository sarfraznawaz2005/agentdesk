// ---------------------------------------------------------------------------
// Issue Fixer — trigger gate (keyword/label/author matching) + intent + anti-runaway
//
// A run fires only when (keyword/label matches) AND (actor is authorized).
// Keywords match the issue TITLE or an authorized COMMENT — never the issue body.
// Labels (agentdesk-*) are inherently permission-gated (only write-access users
// can add them), so a label match is authorized by definition.
// ---------------------------------------------------------------------------

import { db } from "../db";
import { issueFixRuns } from "../db/schema";
import { and, eq, ne } from "drizzle-orm";
import { intentForKeyword, type IssueIntent } from "./prompts";
import type { GhIssue, GhComment } from "./github";

export type AuthMode = "collab" | "label" | "both";

export interface TriggerConfig {
	keywords: string[]; // agentdesk-* (compared case-insensitively)
	labels: string[]; // agentdesk-* label names
	authMode: AuthMode;
}

export interface TriggerMatch {
	issueNumber: number;
	intent: IssueIntent;
	keyword: string;
	triggerType: "title" | "comment" | "pr_comment" | "label";
	triggerCommentId: string | null;
	author: string;
	authorized: boolean;
	isPullRequest: boolean;
}

/** Author associations that count as "authorized" for keyword triggers. */
export function isAuthorizedActor(association: string): boolean {
	return ["OWNER", "MEMBER", "COLLABORATOR"].includes((association ?? "").toUpperCase());
}

/** Keyword sources are active unless authMode is label-only. */
function keywordsActive(authMode: AuthMode): boolean {
	return authMode === "collab" || authMode === "both";
}

/** Label source is active unless authMode is collab-only. */
function labelsActive(authMode: AuthMode): boolean {
	return authMode === "label" || authMode === "both";
}

/** First config keyword that appears (case-insensitive) in `text`, or null. */
function findKeyword(text: string, keywords: string[]): string | null {
	const hay = (text ?? "").toLowerCase();
	for (const kw of keywords) {
		if (kw && hay.includes(kw.toLowerCase())) return kw.toLowerCase();
	}
	return null;
}

function intentOf(keyword: string): IssueIntent {
	return intentForKeyword(keyword) ?? "fix"; // custom agentdesk-* keywords default to fix
}

/**
 * Match an issue by TITLE keyword (collaborator-gated) or by an agentdesk-* LABEL.
 * Never inspects the issue body. PRs are skipped here (handled via comments only).
 */
export function matchIssue(issue: GhIssue, config: TriggerConfig): TriggerMatch | null {
	if (issue.isPullRequest) return null;

	// Label trigger — permission-gated, so authorized by definition.
	if (labelsActive(config.authMode) && config.labels.length) {
		const labelSet = new Set(config.labels.map((l) => l.toLowerCase()));
		const hit = issue.labels.find((l) => labelSet.has(l.toLowerCase()));
		if (hit) {
			return {
				issueNumber: issue.number,
				intent: intentOf(hit),
				keyword: hit.toLowerCase(),
				triggerType: "label",
				triggerCommentId: null,
				author: issue.author,
				authorized: true,
				isPullRequest: false,
			};
		}
	}

	// Title keyword trigger — gated on collaborator authorship.
	if (keywordsActive(config.authMode)) {
		const kw = findKeyword(issue.title, config.keywords);
		if (kw) {
			const authorized = isAuthorizedActor(issue.authorAssociation);
			return {
				issueNumber: issue.number,
				intent: intentOf(kw),
				keyword: kw,
				triggerType: "title",
				triggerCommentId: null,
				author: issue.author,
				authorized,
				isPullRequest: false,
			};
		}
	}

	return null;
}

/**
 * Match a comment (issue comment or PR conversation comment) by keyword, gated on
 * collaborator authorship. Only relevant when keyword triggers are active.
 */
export function matchComment(comment: GhComment, config: TriggerConfig): TriggerMatch | null {
	if (!keywordsActive(config.authMode)) return null;
	const kw = findKeyword(comment.body, config.keywords);
	if (!kw) return null;
	return {
		issueNumber: comment.issueNumber,
		intent: intentOf(kw),
		keyword: kw,
		triggerType: comment.isPullRequest ? "pr_comment" : "comment",
		triggerCommentId: String(comment.id),
		author: comment.author,
		authorized: isAuthorizedActor(comment.authorAssociation),
		isPullRequest: comment.isPullRequest,
	};
}

// --- Anti-runaway DB-backed gates ------------------------------------------

/**
 * Dedup. For comment triggers, a given comment id is processed once. For
 * title/label triggers (no comment id), the issue is processed once unless its
 * prior run was "ignored" (so we don't re-run on every poll).
 */
export async function alreadyProcessed(
	projectId: string,
	issueNumber: number,
	triggerCommentId: string | null,
): Promise<boolean> {
	if (triggerCommentId) {
		const rows = await db
			.select({ id: issueFixRuns.id })
			.from(issueFixRuns)
			.where(
				and(
					eq(issueFixRuns.projectId, projectId),
					eq(issueFixRuns.issueNumber, issueNumber),
					eq(issueFixRuns.triggerCommentId, triggerCommentId),
				),
			)
			.limit(1);
		return rows.length > 0;
	}
	// title/label: any prior non-ignored run for this issue counts as processed
	const rows = await db
		.select({ id: issueFixRuns.id })
		.from(issueFixRuns)
		.where(
			and(
				eq(issueFixRuns.projectId, projectId),
				eq(issueFixRuns.issueNumber, issueNumber),
				ne(issueFixRuns.status, "ignored"),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** True if a run started within the last `cooldownSec` seconds for this project. */
export async function withinCooldown(projectId: string, cooldownSec: number, nowMs: number): Promise<boolean> {
	if (cooldownSec <= 0) return false;
	const rows = await db
		.select({ startedAt: issueFixRuns.startedAt })
		.from(issueFixRuns)
		.where(eq(issueFixRuns.projectId, projectId));
	let latest = 0;
	for (const r of rows) {
		const t = Date.parse(r.startedAt);
		if (!Number.isNaN(t) && t > latest) latest = t;
	}
	return latest > 0 && nowMs - latest < cooldownSec * 1000;
}

/** Count runs started in the last hour for this project (for max-per-hour). */
export async function runsInLastHour(projectId: string, nowMs: number): Promise<number> {
	const rows = await db
		.select({ startedAt: issueFixRuns.startedAt })
		.from(issueFixRuns)
		.where(eq(issueFixRuns.projectId, projectId));
	const cutoff = nowMs - 3_600_000;
	return rows.filter((r) => {
		const t = Date.parse(r.startedAt);
		return !Number.isNaN(t) && t >= cutoff;
	}).length;
}
