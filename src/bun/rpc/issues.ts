/**
 * Multi-source issue tracker engine.
 *
 * Orchestrates the per-source adapters (src/bun/issue-sources/) over the unified
 * `external_issues` table: config CRUD, connection tests, sync (fetch → diff →
 * upsert), issue↔task linking, push-task-as-issue, and auto-close on task done.
 */
import { db } from "../db";
import { externalIssues, kanbanTasks } from "../db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { IssueSource, ExternalIssue, IssueSourceStatus } from "../../shared/rpc/issues";
import { getAdapter, allSources, validateRequiredFields } from "../issue-sources/registry";
import { getSavedConfig, saveConfig, deleteConfig, cleanConfig } from "../issue-sources/config-store";
import type { NormalisedIssue, BucketGroup } from "../issue-sources/types";

// ── helpers ───────────────────────────────────────────────────────────────────

function rowToDto(r: typeof externalIssues.$inferSelect): ExternalIssue {
	return {
		id: r.id,
		projectId: r.projectId,
		source: r.source as IssueSource,
		sourceId: r.sourceId,
		taskId: r.taskId,
		title: r.title,
		body: r.body,
		state: r.state,
		url: r.url,
		labels: safeJsonArray(r.labels),
		assignee: r.assignee,
		priority: r.priority,
		dueDate: r.dueDate,
		sourceCreatedAt: r.sourceCreatedAt,
		syncedAt: r.syncedAt,
	};
}

function safeJsonArray(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function safeJsonObject(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

// ── source status + config ─────────────────────────────────────────────────────

export async function listIssueSources(projectId: string): Promise<IssueSourceStatus[]> {
	const result: IssueSourceStatus[] = [];
	for (const source of allSources()) {
		let configured = false;
		try {
			const config = await getAdapter(source).resolveConfig(projectId);
			configured = config !== null;
		} catch {
			/* leave configured = false */
		}
		result.push({ source, configured });
	}
	return result;
}

export async function getIssueSourceConfig(
	projectId: string,
	source: IssueSource,
): Promise<{ config: Record<string, string> }> {
	// GitHub has no editable per-source config (uses global settings).
	if (source === "github") return { config: {} };
	const config = await getSavedConfig(projectId, source);
	return { config: config ?? {} };
}

export async function saveIssueSourceConfig(
	projectId: string,
	source: IssueSource,
	config: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
	if (source === "github") {
		return { success: false, error: "GitHub is configured via Project Settings and Settings › GitHub." };
	}
	const cleaned = cleanConfig(config);
	const missing = validateRequiredFields(source, cleaned);
	if (missing) return { success: false, error: missing };
	await saveConfig(projectId, source, cleaned);
	return { success: true };
}

export async function deleteIssueSourceConfig(
	projectId: string,
	source: IssueSource,
): Promise<{ success: boolean }> {
	if (source !== "github") await deleteConfig(projectId, source);
	return { success: true };
}

export async function testIssueSource(
	projectId: string,
	source: IssueSource,
	config?: Record<string, string>,
): Promise<{ ok: boolean; error?: string; detail?: string }> {
	const adapter = getAdapter(source);
	try {
		// Prefer the supplied (unsaved) config; fall back to the resolved one.
		let resolved = config ? cleanConfig(config) : null;
		if (resolved) {
			const missing = validateRequiredFields(source, resolved);
			if (missing) return { ok: false, error: missing };
		} else {
			resolved = await adapter.resolveConfig(projectId);
		}
		if (!resolved) return { ok: false, error: "Not configured." };
		return await adapter.testConnection(resolved);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "Connection failed." };
	}
}

// ── Bucket discovery (powers the configure dialog's column/list/status picker) ──

export async function getSourceBuckets(
	source: IssueSource,
	config: Record<string, string>,
): Promise<{ ok: boolean; error?: string; groups?: BucketGroup[] }> {
	const adapter = getAdapter(source);
	if (!adapter.fetchBuckets) return { ok: false, error: `${source} does not support bucket selection.` };
	const cleaned = cleanConfig(config);
	const missing = validateRequiredFields(source, cleaned);
	if (missing) return { ok: false, error: missing };
	try {
		const groups = await adapter.fetchBuckets(cleaned);
		return { ok: true, groups };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "Connection failed." };
	}
}

// ── read ────────────────────────────────────────────────────────────────────

export async function getExternalIssues(
	projectId: string,
	source?: IssueSource,
	state?: string,
): Promise<ExternalIssue[]> {
	const conditions = [eq(externalIssues.projectId, projectId)];
	if (source) conditions.push(eq(externalIssues.source, source));
	if (state) conditions.push(eq(externalIssues.state, state));
	const rows = await db
		.select()
		.from(externalIssues)
		.where(and(...conditions))
		.orderBy(desc(externalIssues.syncedAt));
	return rows.map(rowToDto);
}

// ── sync ──────────────────────────────────────────────────────────────────────

export async function syncIssueSource(
	projectId: string,
	source: IssueSource,
): Promise<{ synced: number; created: number; closed: number; error?: string }> {
	const adapter = getAdapter(source);

	let config: Record<string, string> | null;
	try {
		config = await adapter.resolveConfig(projectId);
	} catch (err) {
		return { synced: 0, created: 0, closed: 0, error: err instanceof Error ? err.message : "Config error" };
	}
	if (!config) {
		return { synced: 0, created: 0, closed: 0, error: `${source} is not configured for this project.` };
	}

	let fetched: NormalisedIssue[];
	try {
		fetched = await adapter.fetchIssues(config);
	} catch (err) {
		return { synced: 0, created: 0, closed: 0, error: err instanceof Error ? err.message : "Fetch failed" };
	}

	// Batch-load existing rows for this project+source for an in-memory diff.
	const existingRows = await db
		.select()
		.from(externalIssues)
		.where(and(eq(externalIssues.projectId, projectId), eq(externalIssues.source, source)));
	const existingBySourceId = new Map(existingRows.map((r) => [r.sourceId, r]));

	let synced = 0;
	let created = 0;
	let closed = 0;
	const now = new Date().toISOString();

	for (const issue of fetched) {
		const labelsJson = JSON.stringify(issue.labels);
		const metadataJson = JSON.stringify(issue.metadata ?? {});
		const existing = existingBySourceId.get(issue.sourceId);

		if (existing) {
			await db
				.update(externalIssues)
				.set({
					title: issue.title,
					body: issue.body,
					state: issue.state,
					url: issue.url,
					labels: labelsJson,
					assignee: issue.assignee,
					priority: issue.priority,
					dueDate: issue.dueDate,
					syncedAt: now,
					metadata: metadataJson,
				})
				.where(eq(externalIssues.id, existing.id));
			if (issue.state === "closed" && existing.state === "open") closed++;
		} else {
			await db.insert(externalIssues).values({
				id: crypto.randomUUID(),
				projectId,
				source,
				sourceId: issue.sourceId,
				taskId: null,
				title: issue.title,
				body: issue.body,
				state: issue.state,
				url: issue.url,
				labels: labelsJson,
				assignee: issue.assignee,
				priority: issue.priority,
				dueDate: issue.dueDate,
				sourceCreatedAt: issue.sourceCreatedAt,
				syncedAt: now,
				metadata: metadataJson,
			});
			created++;
		}
		synced++;
	}

	// Reconcile: adapters only fetch OPEN issues, so any locally-tracked issue
	// still marked "open" but absent from this fetch has been closed/removed
	// remotely — flip it to "closed" so the Open view stays accurate.
	//
	// Guard: only reconcile when the fetch clearly returned the complete open set
	// (fewer than the page cap). At exactly the cap the result may be truncated,
	// and we can't tell "closed remotely" from "didn't fit on the page" — so we
	// skip reconciliation to avoid wrongly closing overflow issues.
	const PAGE_CAP = 100;
	if (fetched.length < PAGE_CAP) {
		const fetchedIds = new Set(fetched.map((i) => i.sourceId));
		for (const row of existingRows) {
			if (row.state === "open" && !fetchedIds.has(row.sourceId)) {
				await db
					.update(externalIssues)
					.set({ state: "closed", syncedAt: now })
					.where(eq(externalIssues.id, row.id));
				closed++;
			}
		}
	}

	return { synced, created, closed };
}

// ── link ──────────────────────────────────────────────────────────────────────

export async function linkExternalIssueToTask(
	issueId: string,
	taskId: string | null,
): Promise<{ success: boolean }> {
	await db.update(externalIssues).set({ taskId }).where(eq(externalIssues.id, issueId));
	return { success: true };
}

// ── create issue from task ──────────────────────────────────────────────────────

export async function createExternalIssueFromTask(
	taskId: string,
	projectId: string,
	source: IssueSource,
): Promise<{ success: boolean; url?: string; error?: string }> {
	const adapter = getAdapter(source);
	if (!adapter.createIssue) {
		return { success: false, error: `Creating issues is not supported for ${source}.` };
	}

	let config: Record<string, string> | null;
	try {
		config = await adapter.resolveConfig(projectId);
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : "Config error" };
	}
	if (!config) return { success: false, error: `${source} is not configured for this project.` };

	const task = (await db.select().from(kanbanTasks).where(eq(kanbanTasks.id, taskId)).limit(1))[0];
	if (!task) return { success: false, error: "Task not found." };

	// Guard duplicates: if this task already has a linked issue in this source, reuse it.
	const alreadyLinked = (
		await db
			.select()
			.from(externalIssues)
			.where(and(eq(externalIssues.taskId, taskId), eq(externalIssues.source, source)))
			.limit(1)
	)[0];
	if (alreadyLinked) return { success: true, url: alreadyLinked.url ?? undefined };

	let created: NormalisedIssue;
	try {
		created = await adapter.createIssue(config, {
			title: task.title,
			body: task.description ?? "",
			priority: task.priority ?? null,
		});
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : "Create failed" };
	}

	await db.insert(externalIssues).values({
		id: crypto.randomUUID(),
		projectId,
		source,
		sourceId: created.sourceId,
		taskId, // link immediately
		title: created.title,
		body: created.body,
		state: created.state,
		url: created.url,
		labels: JSON.stringify(created.labels),
		assignee: created.assignee,
		priority: created.priority,
		sourceCreatedAt: created.sourceCreatedAt,
		metadata: JSON.stringify(created.metadata ?? {}),
	});

	return { success: true, url: created.url ?? undefined };
}

// ── auto-close on task done ─────────────────────────────────────────────────────

/**
 * Close every open external issue linked to a task, across all sources.
 * Called when a kanban task moves to "done". Best-effort: a failure on one
 * source never blocks the others or the task move.
 */
export async function closeExternalIssueForTask(taskId: string, projectId: string): Promise<void> {
	const linked = await db
		.select()
		.from(externalIssues)
		.where(and(eq(externalIssues.taskId, taskId), eq(externalIssues.state, "open")));

	for (const issue of linked) {
		const source = issue.source as IssueSource;
		const adapter = getAdapter(source);
		if (!adapter.closeIssue) continue;
		try {
			const config = await adapter.resolveConfig(projectId);
			if (!config) continue;
			await adapter.closeIssue(config, { sourceId: issue.sourceId, metadata: safeJsonObject(issue.metadata) });
			await db.update(externalIssues).set({ state: "closed" }).where(eq(externalIssues.id, issue.id));
		} catch {
			// Best-effort — leave the local state as-is so a later sync can reconcile.
		}
	}
}
