// ---------------------------------------------------------------------------
// Auto-Earn — job state machine + per-job audit log
//
// One freelance_jobs row per opportunity, idempotent on (platform, thread_id).
// The state drives what the freelance-expert does next:
//   lead → negotiating → awarded → in_progress → delivered → revisions → complete
//                                              ↘ parked (blocked, escalated)
// ---------------------------------------------------------------------------

import { sqlite } from "../../db/connection";

export type JobState =
	| "lead"
	| "negotiating"
	| "awarded"
	| "in_progress"
	| "delivered"
	| "revisions"
	| "complete"
	| "parked";

export interface FreelanceJob {
	id: string;
	platform: string;
	threadId: string | null;
	listingId: string | null;
	listingExternalId: string | null;
	projectId: string | null;
	clientUserId: string | null;
	title: string | null;
	state: JobState;
	bidAmount: number | null;
	currency: string | null;
	earned: number;
	awardedAt: string | null;
	deliveredAt: string | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}

function rowToJob(r: Record<string, unknown>): FreelanceJob {
	return {
		id: String(r.id),
		platform: String(r.platform),
		threadId: (r.thread_id as string | null) ?? null,
		listingId: (r.listing_id as string | null) ?? null,
		listingExternalId: (r.listing_external_id as string | null) ?? null,
		projectId: (r.project_id as string | null) ?? null,
		clientUserId: (r.client_user_id as string | null) ?? null,
		title: (r.title as string | null) ?? null,
		state: String(r.state) as JobState,
		bidAmount: (r.bid_amount as number | null) ?? null,
		currency: (r.currency as string | null) ?? null,
		earned: (r.earned as number | null) ?? 0,
		awardedAt: (r.awarded_at as string | null) ?? null,
		deliveredAt: (r.delivered_at as string | null) ?? null,
		lastError: (r.last_error as string | null) ?? null,
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
	};
}

export function getJobById(id: string): FreelanceJob | null {
	const r = sqlite.prepare(`SELECT * FROM freelance_jobs WHERE id = ?`).get(id) as
		| Record<string, unknown>
		| undefined;
	return r ? rowToJob(r) : null;
}

export function getJobByThread(platform: string, threadId: string): FreelanceJob | null {
	const r = sqlite
		.prepare(`SELECT * FROM freelance_jobs WHERE platform = ? AND thread_id = ?`)
		.get(platform, threadId) as Record<string, unknown> | undefined;
	return r ? rowToJob(r) : null;
}

/** Idempotent upsert keyed on (platform, thread_id). Patches provided fields only. */
export function upsertJobForThread(
	platform: string,
	threadId: string,
	patch: Partial<Omit<FreelanceJob, "id" | "platform" | "threadId" | "createdAt" | "updatedAt">> = {},
): FreelanceJob {
	const existing = getJobByThread(platform, threadId);
	const now = new Date().toISOString();
	if (existing) {
		const sets: string[] = [];
		const vals: unknown[] = [];
		const map: Record<string, unknown> = {
			listing_id: patch.listingId,
			listing_external_id: patch.listingExternalId,
			project_id: patch.projectId,
			client_user_id: patch.clientUserId,
			title: patch.title,
			state: patch.state,
			bid_amount: patch.bidAmount,
			currency: patch.currency,
			earned: patch.earned,
			awarded_at: patch.awardedAt,
			delivered_at: patch.deliveredAt,
			last_error: patch.lastError,
		};
		for (const [col, v] of Object.entries(map)) {
			if (v !== undefined) {
				sets.push(`${col} = ?`);
				vals.push(v);
			}
		}
		if (sets.length > 0) {
			sets.push("updated_at = ?");
			vals.push(now, existing.id);
			sqlite.prepare(`UPDATE freelance_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as (string | number | null)[]));
		}
		return getJobById(existing.id) as FreelanceJob;
	}
	const id = crypto.randomUUID();
	sqlite
		.prepare(
			`INSERT INTO freelance_jobs (id, platform, thread_id, listing_id, listing_external_id, project_id, client_user_id, title, state, bid_amount, currency, earned, awarded_at, delivered_at, created_at, updated_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			id,
			platform,
			threadId,
			patch.listingId ?? null,
			patch.listingExternalId ?? null,
			patch.projectId ?? null,
			patch.clientUserId ?? null,
			patch.title ?? null,
			patch.state ?? "lead",
			patch.bidAmount ?? null,
			patch.currency ?? null,
			patch.earned ?? 0,
			patch.awardedAt ?? null,
			patch.deliveredAt ?? null,
			now,
			now,
		);
	logJobAction(id, "state", `created in state ${patch.state ?? "lead"}`);
	return getJobById(id) as FreelanceJob;
}

export function setJobState(jobId: string, state: JobState, detail?: string): void {
	const now = new Date().toISOString();
	const extra: string[] = [];
	const vals: unknown[] = [state, now];
	if (state === "awarded") {
		extra.push("awarded_at = COALESCE(awarded_at, ?)");
		vals.push(now);
	}
	if (state === "delivered") {
		extra.push("delivered_at = COALESCE(delivered_at, ?)");
		vals.push(now);
	}
	vals.push(jobId);
	sqlite
		.prepare(`UPDATE freelance_jobs SET state = ?, updated_at = ?${extra.length ? ", " + extra.join(", ") : ""} WHERE id = ?`)
		.run(...(vals as (string | number | null)[]));
	logJobAction(jobId, "state", detail ? `→ ${state}: ${detail}` : `→ ${state}`);
}

export function logJobAction(
	jobId: string,
	action: string,
	detail?: string,
	outcome: "ok" | "error" | "info" = "ok",
): void {
	try {
		sqlite
			.prepare(
				`INSERT INTO freelance_job_log (id, job_id, action, detail, outcome, created_at) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`,
			)
			.run(crypto.randomUUID(), jobId, action, detail ?? null, outcome);
	} catch (err) {
		console.error("[freelance/jobs] logJobAction failed:", err);
	}
}

export function getJobLog(jobId: string): Array<{ action: string; detail: string | null; outcome: string; createdAt: string }> {
	const rows = sqlite
		.prepare(`SELECT action, detail, outcome, created_at FROM freelance_job_log WHERE job_id = ? ORDER BY created_at ASC`)
		.all(jobId) as Array<Record<string, unknown>>;
	return rows.map((r) => ({
		action: String(r.action),
		detail: (r.detail as string | null) ?? null,
		outcome: String(r.outcome),
		createdAt: String(r.created_at),
	}));
}

// ── Important client/project facts (non-secret) ──────────────────────────────

export type FactCategory = "rule" | "contact" | "access" | "preference" | "requirement" | "other";

export function saveJobFact(jobId: string, category: FactCategory, detail: string): string {
	// De-dupe identical facts so repeated runs don't pile up.
	const existing = sqlite
		.prepare(`SELECT id FROM freelance_job_facts WHERE job_id = ? AND detail = ? LIMIT 1`)
		.get(jobId, detail) as { id: string } | undefined;
	if (existing) return existing.id;
	const id = crypto.randomUUID();
	sqlite
		.prepare(`INSERT INTO freelance_job_facts (id, job_id, category, detail, created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)`)
		.run(id, jobId, category, detail);
	logJobAction(jobId, "fact", `${category}: ${detail.slice(0, 120)}`, "info");
	return id;
}

export function listJobFacts(jobId: string): Array<{ category: string; detail: string }> {
	const rows = sqlite
		.prepare(`SELECT category, detail FROM freelance_job_facts WHERE job_id = ? ORDER BY created_at ASC`)
		.all(jobId) as Array<{ category: string; detail: string }>;
	return rows;
}

export function listJobs(state?: JobState): FreelanceJob[] {
	const rows = state
		? (sqlite.prepare(`SELECT * FROM freelance_jobs WHERE state = ? ORDER BY updated_at DESC`).all(state) as Array<Record<string, unknown>>)
		: (sqlite.prepare(`SELECT * FROM freelance_jobs ORDER BY updated_at DESC LIMIT 500`).all() as Array<Record<string, unknown>>);
	return rows.map(rowToJob);
}
