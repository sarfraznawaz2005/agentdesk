// ---------------------------------------------------------------------------
// Auto-Earn — freelance-expert RPC (jobs, audit log, escalations, earnings)
// ---------------------------------------------------------------------------

import { sqlite } from "../db/connection";
import { listEscalations, resolveEscalation as resolveEscalationImpl, type EscalationDto } from "../freelance/expert/notify";
import { listJobs, getJobLog, type FreelanceJob } from "../freelance/expert/jobs";

export async function getEscalations(params: { status?: "open" | "resolved" | "all" }): Promise<{ items: EscalationDto[] }> {
	return { items: listEscalations(params.status ?? "open") };
}

export async function resolveEscalation(params: { id: string }): Promise<{ success: boolean }> {
	resolveEscalationImpl(params.id);
	return { success: true };
}

export async function getJobs(params: { state?: string }): Promise<{ jobs: FreelanceJob[] }> {
	return { jobs: listJobs(params.state as FreelanceJob["state"] | undefined) };
}

export async function getJobTimeline(params: { jobId: string }): Promise<{
	entries: Array<{ action: string; detail: string | null; outcome: string; createdAt: string }>;
}> {
	return { entries: getJobLog(params.jobId) };
}

export interface EarningsSummary {
	bidsSent: number;
	jobsWon: number;
	delivered: number;
	openEscalations: number;
	earned: number;
}

export async function getEarningsSummary(): Promise<EarningsSummary> {
	const bidsSent =
		(sqlite.prepare(`SELECT COUNT(*) AS c FROM freelance_action_log WHERE action = 'submit_bid' AND outcome = 'ok'`).get() as { c: number } | undefined)
			?.c ?? 0;
	const jobsWon =
		(sqlite.prepare(`SELECT COUNT(*) AS c FROM freelance_jobs WHERE awarded_at IS NOT NULL`).get() as { c: number } | undefined)?.c ?? 0;
	const delivered =
		(sqlite.prepare(`SELECT COUNT(*) AS c FROM freelance_jobs WHERE state IN ('delivered','complete')`).get() as { c: number } | undefined)?.c ?? 0;
	const openEscalations =
		(sqlite.prepare(`SELECT COUNT(*) AS c FROM freelance_escalations WHERE status = 'open'`).get() as { c: number } | undefined)?.c ?? 0;
	const earned =
		(sqlite.prepare(`SELECT COALESCE(SUM(earned),0) AS s FROM freelance_jobs`).get() as { s: number } | undefined)?.s ?? 0;
	return { bidsSent, jobsWon, delivered, openEscalations, earned };
}
