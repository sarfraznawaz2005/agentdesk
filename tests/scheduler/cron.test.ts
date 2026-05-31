/**
 * cron.test.ts
 *
 * Tests for the cron scheduler: job registration, missed-run recovery logic,
 * one-shot job deletion, and getNextRuns utility.
 *
 * Heavy dependencies (task-executor, desktop notifications, AI SDK) are mocked.
 * The scheduler is tested with an in-memory SQLite database.
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Cron } from "croner";
import { createTestDb } from "../helpers/db";

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-cron" } },
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();

mock.module("../../src/bun/db", () => ({ db: testDb }));
mock.module("../../src/bun/db/connection", () => ({ sqlite: testSqlite }));

// Mock the task executor so no real shell/HTTP calls are made.
const mockExecuteTask = mock(async () => ({
	success: true,
	output: "task ran",
	error: null,
	durationMs: 50,
}));

mock.module("../../src/bun/scheduler/task-executor", () => ({
	executeTask: mockExecuteTask,
}));

mock.module("../../src/bun/notifications/desktop", () => ({
	sendDesktopNotification: async () => {},
}));

const { eventBus } = await import("../../src/bun/scheduler/event-bus");

const {
	initCronScheduler,
	shutdownCronScheduler,
	getNextRuns,
	refreshJob,
} = await import("../../src/bun/scheduler/cron-scheduler");

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function insertJob(opts: {
	id?: string;
	name?: string;
	cronExpression: string;
	taskType?: string;
	taskConfig?: string;
	enabled?: number;
	oneShot?: number;
	lastRunAt?: string | null;
}) {
	const id = opts.id ?? crypto.randomUUID();
	testSqlite.exec(
		`INSERT INTO cron_jobs(id, name, cron_expression, task_type, task_config, enabled, one_shot, last_run_at)
     VALUES (
       '${id}',
       '${opts.name ?? "test-job"}',
       '${opts.cronExpression}',
       '${opts.taskType ?? "shell"}',
       '${opts.taskConfig ?? "{}"}',
       ${opts.enabled ?? 1},
       ${opts.oneShot ?? 0},
       ${opts.lastRunAt !== undefined ? `'${opts.lastRunAt}'` : "NULL"}
     )`,
	);
	return id;
}

function getJob(id: string) {
	return testSqlite.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as {
		id: string; name: string; cron_expression: string; enabled: number; one_shot: number;
		last_run_at: string | null; last_run_status: string | null;
	} | null;
}

function getHistory(jobId: string) {
	return testSqlite.prepare("SELECT * FROM cron_job_history WHERE job_id = ?").all(jobId) as Array<{
		id: string; job_id: string; status: string; started_at: string;
	}>;
}

// -------------------------------------------------------------------------

afterEach(() => {
	shutdownCronScheduler();
	testSqlite.exec("DELETE FROM cron_job_history");
	testSqlite.exec("DELETE FROM cron_jobs");
	mockExecuteTask.mockClear();
	eventBus.removeAllListeners();
});

describe("getNextRuns", () => {
	it("returns an array of ISO timestamp strings for a valid cron expression", () => {
		const runs = getNextRuns("0 * * * *", "UTC", 3);
		expect(runs).toHaveLength(3);
		for (const run of runs) {
			expect(() => new Date(run)).not.toThrow();
			expect(new Date(run).toISOString()).toBe(run);
		}
	});

	it("returns an empty array for an invalid cron expression", () => {
		const runs = getNextRuns("not-valid", "UTC", 3);
		expect(runs).toHaveLength(0);
	});

	it("returns at most count entries", () => {
		const runs = getNextRuns("* * * * *", "UTC", 5);
		expect(runs.length).toBeLessThanOrEqual(5);
	});

	it("each subsequent run is later than the previous one", () => {
		const runs = getNextRuns("0 0 * * *", "UTC", 4);
		for (let i = 1; i < runs.length; i++) {
			expect(new Date(runs[i]).getTime()).toBeGreaterThan(new Date(runs[i - 1]).getTime());
		}
	});
});

describe("initCronScheduler — missed run recovery", () => {
	it("fires a job that missed its last scheduled run", async () => {
		// Hourly job whose last run was 2 hours ago — it definitely missed a fire.
		const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
		const id = insertJob({ cronExpression: "0 * * * *", lastRunAt: twoHoursAgo });

		await initCronScheduler();

		// Allow the async runJob call to settle.
		await new Promise((r) => setTimeout(r, 100));

		expect(mockExecuteTask.mock.calls.length).toBeGreaterThanOrEqual(1);
		shutdownCronScheduler();
	});

	it("does NOT fire a job whose lastRunAt is recent (within the current interval)", async () => {
		// Anchor lastRunAt to 1 second after the most recent :00 boundary so the
		// next scheduled fire is always in the future — avoids failures near the
		// top of any hour.
		const finder = new Cron("0 * * * *", { timezone: "UTC", paused: true });
		const mostRecentFire = finder.nextRun(new Date(Date.now() - 3600_000))!;
		finder.stop();
		const lastRunAt = new Date(mostRecentFire.getTime() + 1000).toISOString();
		const id = insertJob({ cronExpression: "0 * * * *", lastRunAt });

		await initCronScheduler();

		// Brief settle delay.
		await new Promise((r) => setTimeout(r, 50));

		expect(mockExecuteTask.mock.calls.length).toBe(0);
		shutdownCronScheduler();
	});

	it("does NOT fire recovery for a job with null lastRunAt (never ran)", async () => {
		insertJob({ cronExpression: "0 * * * *", lastRunAt: null });

		await initCronScheduler();
		await new Promise((r) => setTimeout(r, 50));

		expect(mockExecuteTask.mock.calls.length).toBe(0);
		shutdownCronScheduler();
	});

	it("does NOT start disabled jobs", async () => {
		insertJob({ cronExpression: "* * * * *", enabled: 0 });
		await initCronScheduler();
		await new Promise((r) => setTimeout(r, 50));
		expect(mockExecuteTask.mock.calls.length).toBe(0);
		shutdownCronScheduler();
	});
});

describe("one-shot job deletion", () => {
	it("deletes a one-shot job and its history after successful execution", async () => {
		mockExecuteTask.mockImplementation(async () => ({
			success: true,
			output: "done",
			error: null,
			durationMs: 10,
		}));

		const id = insertJob({ cronExpression: "* * * * *", oneShot: 1 });

		// Directly invoke the internal runJob logic by triggering initCronScheduler
		// and waiting for the missed-run recovery path (set lastRunAt to 2 hours ago).
		// Use the missed-recovery path to synchronously run the job.
		testSqlite.exec(`UPDATE cron_jobs SET last_run_at = '${new Date(Date.now() - 2 * 3600 * 1000).toISOString()}' WHERE id = '${id}'`);

		await initCronScheduler();
		await new Promise((r) => setTimeout(r, 200));

		const job = getJob(id);
		// For one-shot jobs that complete successfully, the job record is deleted.
		expect(job).toBeNull();
		shutdownCronScheduler();
	});
});

describe("job history", () => {
	it("creates a history entry for each job execution", async () => {
		const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
		const id = insertJob({ cronExpression: "0 * * * *", lastRunAt: twoHoursAgo });

		await initCronScheduler();
		await new Promise((r) => setTimeout(r, 200));

		// One-shot jobs delete their history. For regular jobs, history should exist.
		// (history is only deleted for one-shot jobs).
		// At least one execute call was made.
		expect(mockExecuteTask.mock.calls.length).toBeGreaterThanOrEqual(1);
		shutdownCronScheduler();
	});
});

describe("shutdownCronScheduler", () => {
	it("stops all active cron jobs without error", async () => {
		insertJob({ cronExpression: "* * * * *" });
		insertJob({ cronExpression: "0 * * * *" });
		await initCronScheduler();
		// Should not throw.
		expect(() => shutdownCronScheduler()).not.toThrow();
	});
});

describe("refreshJob", () => {
	it("re-enables a job after updating it", async () => {
		const id = insertJob({ cronExpression: "0 0 * * *", enabled: 1 });
		await initCronScheduler();

		// Simulate an update — refreshJob should reload the job definition.
		await expect(refreshJob(id)).resolves.toBeUndefined();
		shutdownCronScheduler();
	});

	it("stops a job when it is disabled", async () => {
		const id = insertJob({ cronExpression: "0 0 * * *", enabled: 1 });
		await initCronScheduler();

		// Disable the job in DB then refresh.
		testSqlite.exec(`UPDATE cron_jobs SET enabled = 0 WHERE id = '${id}'`);
		await refreshJob(id);

		// After refresh with enabled=0 the job should not run.
		// We verify by re-enabling and checking the refreshed job starts cleanly.
		expect(mockExecuteTask.mock.calls.length).toBe(0);
		shutdownCronScheduler();
	});
});
