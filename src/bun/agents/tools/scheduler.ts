// src/bun/agents/tools/scheduler.ts
// PM-only tools for managing cron jobs via natural language.
import { tool } from "ai";
import { z } from "zod";
import {
	getCronJobs,
	createCronJob,
	updateCronJob,
	deleteCronJob,
	getCronJobHistory,
} from "../../rpc/cron";

// ---------------------------------------------------------------------------
// Shared schema pieces
// ---------------------------------------------------------------------------

const taskTypeSchema = z.enum(["pm_prompt", "reminder", "shell", "webhook", "agent_task"]);

const taskConfigSchema = z
	.object({
		// pm_prompt / agent_task
		projectId: z.string().optional().describe("Project ID (required for pm_prompt and agent_task)"),
		prompt: z.string().optional().describe("Prompt text (pm_prompt)"),
		instructions: z.string().optional().describe("Agent instructions (agent_task)"),
		// reminder
		message: z.string().optional().describe("Reminder message text"),
		// shell
		command: z.string().optional().describe("Shell command to run"),
		timeout: z.number().optional().describe("Timeout in milliseconds (default 60000)"),
		// webhook
		url: z.string().optional().describe("Webhook URL"),
		method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().describe("HTTP method (default GET)"),
		headers: z.string().optional().describe("JSON string of request headers"),
		body: z.string().optional().describe("Request body"),
	})
	.describe("Task-type-specific configuration. Include only the fields relevant to the chosen taskType.");

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export const schedulerTools = {
	create_cron_job: tool({
		description: `Create a new scheduled cron job. Supports five task types:
- pm_prompt: Send a prompt to the PM agent in a project (requires projectId + prompt)
- reminder: Create an inbox notification with a message
- shell: Run a shell command
- webhook: Make an HTTP request to a URL
- agent_task: Dispatch instructions to an agent in a project (requires projectId + instructions)

Cron expression examples: "0 9 * * *" = daily at 09:00, "0 9 * * 1" = every Monday at 09:00, "*/30 * * * *" = every 30 minutes, "0 0 1 * *" = first day of each month.

For one-shot time-of-day reminders ("in X minutes", "at 3pm today"): use "minute hour * * *" with oneShot=true. Never pin day-of-month or month — croner calculates the next run at creation time and a pinned past date results in no scheduled execution.`,
		inputSchema: z.object({
			name: z.string().describe("Human-readable job name, e.g. 'Daily standup reminder'"),
			cronExpression: z.string().describe("Standard 5-part cron expression (minute hour dom month dow)"),
			timezone: z.string().optional().describe("IANA timezone, e.g. 'America/New_York'. Defaults to UTC."),
			taskType: taskTypeSchema,
			taskConfig: taskConfigSchema,
			oneShot: z.boolean().optional().describe("If true, job is permanently deleted after its first successful run"),
			projectId: z.string().optional().describe("Scope this job to a specific project (optional)"),
		}),
		execute: async ({ name, cronExpression, timezone, taskType, taskConfig, oneShot, projectId }) => {
			try {
				const config = buildConfig(taskType, taskConfig);
				const result = await createCronJob({
					name,
					cronExpression,
					timezone,
					taskType,
					taskConfig: JSON.stringify(config),
					enabled: true,
					oneShot: oneShot ?? false,
					projectId,
				});
				return JSON.stringify({ success: true, jobId: result.id, message: `Cron job "${name}" created and enabled.` });
			} catch (err) {
				return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
			}
		},
	}),

	list_cron_jobs: tool({
		description: "List all cron jobs, optionally filtered by project. Returns name, schedule, task type, enabled status, last run status, and next/last run times.",
		inputSchema: z.object({
			projectId: z.string().optional().describe("Filter to a specific project. Omit to list all jobs."),
		}),
		execute: async ({ projectId }) => {
			try {
				const jobs = await getCronJobs(projectId ? { projectId } : undefined);
				if (jobs.length === 0) return JSON.stringify({ jobs: [], message: "No cron jobs found." });
				return JSON.stringify({
					jobs: jobs.map((j) => ({
						id: j.id,
						name: j.name,
						cronExpression: j.cronExpression,
						timezone: j.timezone,
						taskType: j.taskType,
						enabled: j.enabled === 1,
						oneShot: j.oneShot === 1,
						lastRunAt: j.lastRunAt,
						lastRunStatus: j.lastRunStatus,
					})),
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	}),

	update_cron_job: tool({
		description: "Edit an existing cron job. Only provide the fields you want to change. Use list_cron_jobs first to get the job ID.",
		inputSchema: z.object({
			jobId: z.string().describe("ID of the cron job to update"),
			name: z.string().optional(),
			cronExpression: z.string().optional(),
			timezone: z.string().optional(),
			taskType: taskTypeSchema.optional(),
			taskConfig: taskConfigSchema.optional(),
			enabled: z.boolean().optional().describe("Enable or disable the job"),
			oneShot: z.boolean().optional().describe("If true, job is permanently deleted after its first successful run"),
		}),
		execute: async ({ jobId, name, cronExpression, timezone, taskType, taskConfig, enabled, oneShot }) => {
			try {
				const updates: Parameters<typeof updateCronJob>[0] = { id: jobId };
				if (name !== undefined) updates.name = name;
				if (cronExpression !== undefined) updates.cronExpression = cronExpression;
				if (timezone !== undefined) updates.timezone = timezone;
				if (enabled !== undefined) updates.enabled = enabled;
				if (oneShot !== undefined) updates.oneShot = oneShot;
				if (taskType !== undefined) updates.taskType = taskType;
				if (taskConfig !== undefined && taskType !== undefined) {
					updates.taskConfig = JSON.stringify(buildConfig(taskType, taskConfig));
				}
				await updateCronJob(updates);
				return JSON.stringify({ success: true, message: `Job ${jobId} updated.` });
			} catch (err) {
				return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
			}
		},
	}),

	delete_cron_job: tool({
		description: "Permanently delete a cron job and all its history. Use list_cron_jobs first to get the job ID.",
		inputSchema: z.object({
			jobId: z.string().describe("ID of the cron job to delete"),
		}),
		execute: async ({ jobId }) => {
			try {
				await deleteCronJob(jobId);
				return JSON.stringify({ success: true, message: `Job ${jobId} deleted.` });
			} catch (err) {
				return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
			}
		},
	}),

	get_cron_job_history: tool({
		description: "Get recent execution history for a cron job — start time, status (success/error/running), output, error message, and duration. Use list_cron_jobs first to get the job ID.",
		inputSchema: z.object({
			jobId: z.string().describe("ID of the cron job"),
			limit: z.number().optional().describe("Number of recent runs to return (default 10, max 50)"),
		}),
		execute: async ({ jobId, limit }) => {
			try {
				const history = await getCronJobHistory({ jobId, limit: Math.min(limit ?? 10, 50) });
				if (history.length === 0) return JSON.stringify({ history: [], message: "No runs recorded yet." });
				return JSON.stringify({ history });
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	}),
};

// ---------------------------------------------------------------------------
// Helper — build validated task config object
// ---------------------------------------------------------------------------

function buildConfig(taskType: string, config: Record<string, unknown>): Record<string, unknown> {
	switch (taskType) {
		case "pm_prompt":
			return { projectId: config.projectId ?? "", prompt: config.prompt ?? "" };
		case "reminder":
			return { message: config.message ?? "" };
		case "shell":
			return { command: config.command ?? "", timeout: config.timeout ?? 60000 };
		case "webhook":
			return { url: config.url ?? "", method: config.method ?? "GET", headers: config.headers ?? "", body: config.body ?? "" };
		case "agent_task":
			return { projectId: config.projectId ?? "", instructions: config.instructions ?? "" };
		default:
			return {};
	}
}
