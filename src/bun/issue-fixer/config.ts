// ---------------------------------------------------------------------------
// Issue Fixer — shared persistence layer (config + run history)
// Used by the RPC handlers, the poller, and the orchestrator.
// ---------------------------------------------------------------------------

import { db } from "../db";
import { issueFixerConfig, issueFixRuns, settings } from "../db/schema";
import { eq, desc, inArray, and, ne } from "drizzle-orm";
import type { AuthMode } from "./triggers";

/** Keep only valid, lower-cased, de-duped `agentdesk-` prefixed keywords/labels. */
function sanitizeAgentdesk(list: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of list ?? []) {
		const k = String(raw).trim().toLowerCase();
		if (k.startsWith("agentdesk-") && k.length > "agentdesk-".length && !seen.has(k)) {
			seen.add(k);
			out.push(k);
		}
	}
	return out;
}

export interface IssueFixerConfigDto {
	projectId: string;
	enabled: boolean;
	keywords: string[];
	labels: string[];
	authMode: AuthMode;
	pollIntervalMin: number;
	autonomy: "branch_pr" | "draft";
	testCommand: string | null;
	customInstructions: string | null;
	tokenSource: "global" | "custom";
	cooldownSec: number;
	maxPerHour: number;
	notifyChannels: string[];
	notifyEnabled: boolean;
	cursorAt: string | null;
	lastPolledAt: string | null;
	/** True when a per-project custom GitHub token is already stored. */
	hasCustomToken?: boolean;
}

/** Whether a per-project custom GitHub token is saved (key: project:<id>:githubToken). */
async function hasCustomGitHubToken(projectId: string): Promise<boolean> {
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, `project:${projectId}:githubToken`))
		.limit(1);
	return Boolean(rows[0]?.value && rows[0].value.trim());
}

function parseJsonArray(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

type ConfigRow = typeof issueFixerConfig.$inferSelect;

function mapConfig(row: ConfigRow): IssueFixerConfigDto {
	return {
		projectId: row.projectId,
		enabled: row.enabled === 1,
		keywords: parseJsonArray(row.keywords),
		labels: parseJsonArray(row.labels),
		authMode: (row.authMode as AuthMode) ?? "both",
		pollIntervalMin: row.pollIntervalMin ?? 60,
		autonomy: (row.autonomy as "branch_pr" | "draft") ?? "branch_pr",
		testCommand: row.testCommand ?? null,
		customInstructions: row.customInstructions ?? null,
		tokenSource: (row.tokenSource as "global" | "custom") ?? "global",
		cooldownSec: row.cooldownSec ?? 0,
		maxPerHour: row.maxPerHour ?? 5,
		notifyChannels: parseJsonArray(row.notifyChannels),
		notifyEnabled: (row.notifyEnabled ?? 0) !== 0,
		cursorAt: row.cursorAt ?? null,
		lastPolledAt: row.lastPolledAt ?? null,
	};
}

export async function getIssueFixerConfig(projectId: string): Promise<IssueFixerConfigDto | null> {
	const rows = await db.select().from(issueFixerConfig).where(eq(issueFixerConfig.projectId, projectId)).limit(1);
	if (!rows[0]) return null;
	const dto = mapConfig(rows[0]);
	dto.hasCustomToken = await hasCustomGitHubToken(projectId);
	return dto;
}

export async function listEnabledConfigs(): Promise<IssueFixerConfigDto[]> {
	const rows = await db.select().from(issueFixerConfig).where(eq(issueFixerConfig.enabled, 1));
	return rows.map(mapConfig);
}

/** Upsert (full replace of provided fields) the per-project config. */
export async function saveIssueFixerConfig(
	projectId: string,
	patch: Partial<Omit<IssueFixerConfigDto, "projectId">>,
): Promise<IssueFixerConfigDto> {
	const now = new Date().toISOString();
	const existing = await getIssueFixerConfig(projectId);
	const merged: IssueFixerConfigDto = {
		projectId,
		enabled: patch.enabled ?? existing?.enabled ?? false,
		keywords: patch.keywords ?? existing?.keywords ?? [],
		labels: patch.labels ?? existing?.labels ?? [],
		authMode: patch.authMode ?? existing?.authMode ?? "both",
		pollIntervalMin: patch.pollIntervalMin ?? existing?.pollIntervalMin ?? 60,
		autonomy: patch.autonomy ?? existing?.autonomy ?? "branch_pr",
		testCommand: patch.testCommand ?? existing?.testCommand ?? null,
		customInstructions: patch.customInstructions ?? existing?.customInstructions ?? null,
		tokenSource: patch.tokenSource ?? existing?.tokenSource ?? "global",
		cooldownSec: patch.cooldownSec ?? existing?.cooldownSec ?? 0,
		maxPerHour: patch.maxPerHour ?? existing?.maxPerHour ?? 5,
		notifyChannels: patch.notifyChannels ?? existing?.notifyChannels ?? [],
		notifyEnabled: patch.notifyEnabled ?? existing?.notifyEnabled ?? false,
		// When enabling for the first time, set the cursor to "now" so old issues
		// are not retroactively processed.
		cursorAt:
			patch.cursorAt ??
			existing?.cursorAt ??
			(patch.enabled && !existing?.enabled ? now : null),
		lastPolledAt: existing?.lastPolledAt ?? null,
	};

	// Enforce the agentdesk- prefix server-side too (the UI also validates).
	merged.keywords = sanitizeAgentdesk(merged.keywords);
	merged.labels = sanitizeAgentdesk(merged.labels);

	const values = {
		enabled: merged.enabled ? 1 : 0,
		keywords: JSON.stringify(merged.keywords),
		labels: JSON.stringify(merged.labels),
		authMode: merged.authMode,
		pollIntervalMin: merged.pollIntervalMin,
		autonomy: merged.autonomy,
		testCommand: merged.testCommand,
		customInstructions: merged.customInstructions,
		tokenSource: merged.tokenSource,
		cooldownSec: merged.cooldownSec,
		maxPerHour: merged.maxPerHour,
		notifyChannels: JSON.stringify(merged.notifyChannels),
		notifyEnabled: merged.notifyEnabled ? 1 : 0,
		cursorAt: merged.cursorAt,
		updatedAt: now,
	};

	if (existing) {
		await db.update(issueFixerConfig).set(values).where(eq(issueFixerConfig.projectId, projectId));
	} else {
		await db.insert(issueFixerConfig).values({ projectId, ...values, createdAt: now });
	}
	// The frontend persists the custom token (saveProjectSetting) before calling this,
	// so this reflects the just-saved state.
	merged.hasCustomToken = await hasCustomGitHubToken(projectId);
	return merged;
}

export async function setCursor(projectId: string, cursorAt: string): Promise<void> {
	await db.update(issueFixerConfig).set({ cursorAt }).where(eq(issueFixerConfig.projectId, projectId));
}

export async function setLastPolled(projectId: string, ts: string): Promise<void> {
	await db.update(issueFixerConfig).set({ lastPolledAt: ts }).where(eq(issueFixerConfig.projectId, projectId));
}

// --- runs -------------------------------------------------------------------

export type IssueFixRunRow = typeof issueFixRuns.$inferSelect;

export async function createRun(row: {
	projectId: string;
	issueNumber: number;
	issueTitle: string;
	issueUrl?: string | null;
	triggerType: string;
	triggerKeyword?: string | null;
	triggerCommentId?: string | null;
	intent: string;
	author?: string | null;
	authorized: boolean;
	status: string;
	conversationId?: string | null;
}): Promise<string> {
	const id = crypto.randomUUID();
	await db.insert(issueFixRuns).values({
		id,
		projectId: row.projectId,
		issueNumber: row.issueNumber,
		issueTitle: row.issueTitle,
		issueUrl: row.issueUrl ?? null,
		triggerType: row.triggerType,
		triggerKeyword: row.triggerKeyword ?? null,
		triggerCommentId: row.triggerCommentId ?? null,
		intent: row.intent,
		author: row.author ?? null,
		authorized: row.authorized ? 1 : 0,
		status: row.status,
		conversationId: row.conversationId ?? null,
		startedAt: new Date().toISOString(),
	});
	return id;
}

export async function updateRun(
	id: string,
	patch: Partial<{
		status: string;
		branchName: string | null;
		prNumber: number | null;
		prUrl: string | null;
		testPassed: number | null;
		summary: string | null;
		error: string | null;
		finishedAt: string | null;
	}>,
): Promise<void> {
	await db.update(issueFixRuns).set(patch).where(eq(issueFixRuns.id, id));
}

export async function listRuns(projectId: string, limit = 100): Promise<IssueFixRunRow[]> {
	return db
		.select()
		.from(issueFixRuns)
		.where(eq(issueFixRuns.projectId, projectId))
		.orderBy(desc(issueFixRuns.startedAt))
		.limit(limit);
}

export async function getRun(id: string): Promise<IssueFixRunRow | null> {
	const rows = await db.select().from(issueFixRuns).where(eq(issueFixRuns.id, id)).limit(1);
	return rows[0] ?? null;
}

/** Epoch ms of the most recently finished OTHER run for this project (0 if none). */
export async function mostRecentFinishedAt(projectId: string, excludeRunId: string): Promise<number> {
	const rows = await db
		.select({ finishedAt: issueFixRuns.finishedAt })
		.from(issueFixRuns)
		.where(and(eq(issueFixRuns.projectId, projectId), ne(issueFixRuns.id, excludeRunId)));
	let latest = 0;
	for (const r of rows) {
		const t = r.finishedAt ? Date.parse(r.finishedAt) : 0;
		if (!Number.isNaN(t) && t > latest) latest = t;
	}
	return latest;
}

/**
 * Mark any runs left in a non-terminal state (e.g. by an app crash/restart) as failed,
 * so they don't appear permanently "fixing" in the History. Called once on startup.
 */
export async function failInterruptedRuns(): Promise<void> {
	await db
		.update(issueFixRuns)
		.set({ status: "failed", error: "Interrupted by app restart", finishedAt: new Date().toISOString() })
		.where(inArray(issueFixRuns.status, ["queued", "fixing", "testing", "pushing"]));
}
