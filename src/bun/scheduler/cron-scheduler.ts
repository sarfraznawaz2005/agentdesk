// src/bun/scheduler/cron-scheduler.ts
import { Cron } from "croner";
import { db } from "../db";
import { cronJobs, cronJobHistory } from "../db/schema";
import { eq } from "drizzle-orm";
import { executeTask, type TaskType } from "./task-executor";
import { eventBus } from "./event-bus";
import { sendDesktopNotification } from "../notifications/desktop";

// Task types that have no project conversation or live UI feedback —
// the user needs a desktop notification to know the job ran.
const NOTIFY_ON_COMPLETE = new Set<TaskType>(["shell", "webhook", "send_channel_message"]);

interface ManagedJob {
	cron: Cron;
	jobId: string;
}

const activeJobs = new Map<string, ManagedJob>();

export async function triggerJobNow(jobId: string): Promise<void> {
	return runJob(jobId);
}

async function runJob(jobId: string): Promise<void> {
	const rows = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).limit(1);
	if (rows.length === 0) return;

	const job = rows[0];

	// Write history record
	const historyId = crypto.randomUUID();
	const startedAt = new Date().toISOString();
	await db.insert(cronJobHistory).values({
		id: historyId,
		jobId,
		startedAt,
		status: "running",
	});

	// Execute — inject _jobName and _projectId so task-executor can use them
	const taskConfig = JSON.parse(job.taskConfig);
	taskConfig._jobName = job.name;
	if (job.projectId) taskConfig._projectId = job.projectId;
	const result = await executeTask(job.taskType as TaskType, taskConfig);

	// Update history
	const completedAt = new Date().toISOString();
	await db.update(cronJobHistory).set({
		completedAt,
		status: result.success ? "success" : "error",
		output: result.output || result.error || null,
		durationMs: result.durationMs,
	}).where(eq(cronJobHistory.id, historyId));

	// Update job lastRun
	await db.update(cronJobs).set({
		lastRunAt: startedAt,
		lastRunStatus: result.success ? "success" : "error",
		updatedAt: completedAt,
	}).where(eq(cronJobs.id, jobId));

	// Desktop notification for task types with no other UI feedback
	if (NOTIFY_ON_COMPLETE.has(job.taskType as TaskType)) {
		const title = result.success ? `✓ ${job.name}` : `✗ ${job.name} failed`;
		const body = result.success
			? (result.output?.slice(0, 120) ?? "Completed successfully")
			: (result.error?.slice(0, 120) ?? "An error occurred");
		sendDesktopNotification(title, body).catch(() => {});
	}

	// Auto-delete one-shot jobs after successful run
	if (job.oneShot && result.success) {
		await db.delete(cronJobHistory).where(eq(cronJobHistory.jobId, jobId));
		await db.delete(cronJobs).where(eq(cronJobs.id, jobId));
		stopJob(jobId);
	}

	// Emit event
	eventBus.emit({ type: "cron:fired", jobId, jobName: job.name });
}

function startJob(job: typeof cronJobs.$inferSelect): void {
	if (activeJobs.has(job.id)) return;

	const cron = new Cron(job.cronExpression, { timezone: job.timezone }, () => {
		runJob(job.id).catch((err) => {
			console.error(`[CronScheduler] Error running job ${job.name}:`, err);
		});
	});

	activeJobs.set(job.id, { cron, jobId: job.id });
}

function stopJob(jobId: string): void {
	const managed = activeJobs.get(jobId);
	if (managed) {
		managed.cron.stop();
		activeJobs.delete(jobId);
	}
}

export async function initCronScheduler(): Promise<void> {
	const jobs = await db.select().from(cronJobs).where(eq(cronJobs.enabled, 1));

	for (const job of jobs) {
		// Missed task recovery: if the next scheduled fire after lastRunAt is in
		// the past, at least one run was missed. previousRun() is unreliable on
		// paused instances; using nextRun(lastRan) is always computable.
		if (job.lastRunAt) {
			try {
				const checker = new Cron(job.cronExpression, { timezone: job.timezone, paused: true });
				const lastRan = new Date(job.lastRunAt);
				const nextAfterLast = checker.nextRun(lastRan);
				checker.stop();
				if (nextAfterLast && nextAfterLast < new Date()) {
					console.log(`[CronScheduler] Missed run for "${job.name}", firing now`);
					runJob(job.id).catch((err) => {
						console.error(`[CronScheduler] Error on missed recovery for ${job.name}:`, err);
					});
				}
			} catch {
				// Skip recovery if expression is invalid
			}
		}

		startJob(job);
	}

	console.log(`[CronScheduler] Started ${activeJobs.size} cron jobs`);
}

export function shutdownCronScheduler(): void {
	for (const [, managed] of activeJobs) {
		managed.cron.stop();
	}
	activeJobs.clear();
}

export async function refreshJob(jobId: string): Promise<void> {
	stopJob(jobId);

	const rows = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).limit(1);
	if (rows.length === 0) return;

	const job = rows[0];
	if (job.enabled) {
		startJob(job);
	}
}

export function getNextRuns(cronExpression: string, timezone: string, count: number = 3): string[] {
	try {
		const cron = new Cron(cronExpression, { timezone, paused: true });
		const runs: string[] = [];
		let next = cron.nextRun();
		for (let i = 0; i < count && next; i++) {
			runs.push(next.toISOString());
			next = cron.nextRun(next);
		}
		cron.stop();
		return runs;
	} catch {
		return [];
	}
}
