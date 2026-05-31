// src/bun/rpc/cron.ts
import { db } from "../db";
import { cronJobs, cronJobHistory, settings } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { refreshJob, getNextRuns, triggerJobNow } from "../scheduler";

// ---------------------------------------------------------------------------
// Helper — read global timezone from settings (fallback UTC)
// ---------------------------------------------------------------------------

async function getGlobalTimezone(): Promise<string> {
	try {
		const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "timezone")).limit(1);
		if (rows.length > 0) {
			const raw = rows[0].value;
			try { return JSON.parse(raw) || "UTC"; } catch { return raw || "UTC"; }
		}
	} catch { /* fallthrough */ }
	return "UTC";
}

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

export async function getCronJobs(params?: { projectId?: string }) {
	const jobs = params?.projectId
		? await db.select().from(cronJobs).where(eq(cronJobs.projectId, params.projectId))
		: await db.select().from(cronJobs);

	// Enrich each job with a computed nextRunAt so the UI can display it
	return jobs.map((job) => ({
		...job,
		nextRunAt: getNextRuns(job.cronExpression, job.timezone ?? "UTC", 1)[0] ?? null,
	}));
}

export async function createCronJob(params: {
	projectId?: string;
	name: string;
	cronExpression: string;
	timezone?: string;
	taskType: string;
	taskConfig: string;
	enabled?: boolean;
	oneShot?: boolean;
}) {
	const id = crypto.randomUUID();
	// Fall back to the user's global timezone setting so PM-created jobs are
	// always in the correct timezone even when the PM omits the field.
	const timezone = params.timezone ?? await getGlobalTimezone();
	await db.insert(cronJobs).values({
		id,
		projectId: params.projectId ?? null,
		name: params.name,
		cronExpression: params.cronExpression,
		timezone,
		taskType: params.taskType,
		taskConfig: params.taskConfig,
		enabled: params.enabled !== false ? 1 : 0,
		oneShot: params.oneShot ? 1 : 0,
	});
	await refreshJob(id);
	return { id };
}

export async function updateCronJob(params: {
	id: string;
	name?: string;
	cronExpression?: string;
	timezone?: string;
	taskType?: string;
	taskConfig?: string;
	enabled?: boolean;
	oneShot?: boolean;
}) {
	const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
	if (params.name !== undefined) updates.name = params.name;
	if (params.cronExpression !== undefined) updates.cronExpression = params.cronExpression;
	if (params.timezone !== undefined) updates.timezone = params.timezone;
	if (params.taskType !== undefined) updates.taskType = params.taskType;
	if (params.taskConfig !== undefined) updates.taskConfig = params.taskConfig;
	if (params.enabled !== undefined) updates.enabled = params.enabled ? 1 : 0;
	if (params.oneShot !== undefined) updates.oneShot = params.oneShot ? 1 : 0;

	await db.update(cronJobs).set(updates).where(eq(cronJobs.id, params.id));
	await refreshJob(params.id);
	return { success: true };
}

export async function deleteCronJob(id: string) {
	await db.delete(cronJobHistory).where(eq(cronJobHistory.jobId, id));
	await db.delete(cronJobs).where(eq(cronJobs.id, id));
	await refreshJob(id);
	return { success: true };
}

export async function getCronJobHistory(params: { jobId: string; limit?: number }) {
	return db
		.select()
		.from(cronJobHistory)
		.where(eq(cronJobHistory.jobId, params.jobId))
		.orderBy(desc(cronJobHistory.startedAt))
		.limit(params.limit ?? 10);
}

export async function clearCronJobHistory(params: { jobId?: string }) {
	if (params.jobId) {
		await db.delete(cronJobHistory).where(eq(cronJobHistory.jobId, params.jobId));
	} else {
		await db.delete(cronJobHistory);
	}
	return { success: true };
}

export async function previewCronSchedule(params: { cronExpression: string; timezone?: string; count?: number }) {
	return { runs: getNextRuns(params.cronExpression, params.timezone ?? "UTC", params.count ?? 5) };
}

export async function triggerCronJob(params: { id: string }) {
	const rows = await db.select().from(cronJobs).where(eq(cronJobs.id, params.id)).limit(1);
	if (rows.length === 0) throw new Error("Job not found");
	await triggerJobNow(params.id);
	return { success: true };
}
