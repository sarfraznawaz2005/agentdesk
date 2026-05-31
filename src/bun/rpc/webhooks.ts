/**
 * Webhook configuration and event log management.
 *
 * Since AgentDesk is a desktop app without a public URL, we implement
 * GitHub event polling instead of real webhook reception. The UI lets
 * users configure which events to watch, and pollGithubEvents() fetches
 * recent events from the GitHub API and stores them in webhook_events.
 */
import { db } from "../db";
import { webhookConfigs, webhookEvents } from "../db/schema";
import { eq, desc, and } from "drizzle-orm";
import { githubFetch, getProjectGithubRepo } from "./github-api";

// ── Webhook Configs ───────────────────────────────────────────────────────────

export async function getWebhookConfigs(projectId: string) {
	const rows = await db
		.select()
		.from(webhookConfigs)
		.where(eq(webhookConfigs.projectId, projectId))
		.orderBy(webhookConfigs.createdAt);
	return rows.map((r) => ({
		id: r.id,
		projectId: r.projectId,
		name: r.name,
		events: JSON.parse(r.events) as string[],
		enabled: r.enabled === 1,
		lastPollAt: r.lastPollAt,
		createdAt: r.createdAt,
	}));
}

export async function saveWebhookConfig(params: {
	id?: string;
	projectId: string;
	name: string;
	events: string[];
	enabled?: boolean;
}) {
	const id = params.id ?? crypto.randomUUID();
	const eventsJson = JSON.stringify(params.events);

	if (params.id) {
		await db
			.update(webhookConfigs)
			.set({
				name: params.name,
				events: eventsJson,
				enabled: params.enabled !== false ? 1 : 0,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(webhookConfigs.id, params.id));
	} else {
		await db.insert(webhookConfigs).values({
			id,
			projectId: params.projectId,
			name: params.name,
			events: eventsJson,
			enabled: params.enabled !== false ? 1 : 0,
		});
	}
	return { id };
}

export async function deleteWebhookConfig(id: string) {
	await db.delete(webhookConfigs).where(eq(webhookConfigs.id, id));
	return { success: true };
}

// ── Webhook Events ────────────────────────────────────────────────────────────

export async function getWebhookEvents(projectId: string, eventType?: string, limit = 50) {
	const conditions = eventType
		? and(eq(webhookEvents.projectId, projectId), eq(webhookEvents.eventType, eventType))
		: eq(webhookEvents.projectId, projectId);
	const rows = await db
		.select()
		.from(webhookEvents)
		.where(conditions)
		.orderBy(desc(webhookEvents.createdAt))
		.limit(limit);
	return rows.map((r) => ({
		id: r.id,
		projectId: r.projectId,
		eventType: r.eventType,
		title: r.title,
		payload: JSON.parse(r.payload) as Record<string, unknown>,
		status: r.status,
		processedAt: r.processedAt,
		createdAt: r.createdAt,
	}));
}

// ── GitHub Event Polling ──────────────────────────────────────────────────────

export async function pollGithubEvents(projectId: string): Promise<{ fetched: number; error?: string }> {
	const repo = await getProjectGithubRepo(projectId);
	if (!repo) return { fetched: 0, error: "GitHub not configured (missing PAT or repo URL)" };

	// Fetch recent events from GitHub API
	const res = await githubFetch(`/repos/${repo.owner}/${repo.repo}/events?per_page=30`, {}, repo.pat);
	if (!res.ok) {
		return { fetched: 0, error: `GitHub API error: ${(res.data as { message?: string }).message ?? res.status}` };
	}

	const events = res.data as Array<{
		id: string;
		type: string;
		payload: Record<string, unknown>;
		created_at: string;
	}>;

	// Dedup using the github_event_id column with a unique index
	let fetched = 0;
	for (const event of events) {
		const eventType = mapGithubEventType(event.type);
		if (!eventType) continue;

		const ghId = event.id;
		const title = buildEventTitle(event.type, event.payload);
		const payload = { ...event.payload, _github_event_type: event.type };
		const id = crypto.randomUUID();

		// O(1) dedup via unique index on github_event_id — onConflictDoNothing avoids raising a DB error
		await db
			.insert(webhookEvents)
			.values({
				id,
				projectId,
				eventType,
				title,
				payload: JSON.stringify(payload),
				status: "pending",
				githubEventId: ghId,
				createdAt: event.created_at,
			})
			.onConflictDoNothing();
		fetched++;
	}

	// Update lastPollAt on all configs for this project
	await db
		.update(webhookConfigs)
		.set({ lastPollAt: new Date().toISOString() })
		.where(eq(webhookConfigs.projectId, projectId));

	return { fetched };
}

function mapGithubEventType(type: string): string | null {
	const map: Record<string, string> = {
		PushEvent: "push",
		PullRequestEvent: "pull_request",
		IssuesEvent: "issues",
		ReleaseEvent: "release",
		CreateEvent: "push",
		DeleteEvent: "push",
		WorkflowRunEvent: "workflow_run",
		IssueCommentEvent: "issues",
		PullRequestReviewEvent: "pull_request",
	};
	return map[type] ?? null;
}

function buildEventTitle(type: string, payload: Record<string, unknown>): string {
	switch (type) {
		case "PushEvent": {
			const ref = (payload.ref as string | undefined)?.replace("refs/heads/", "") ?? "unknown";
			const commits = (payload.commits as unknown[])?.length ?? 0;
			return `Push to ${ref} (${commits} commit${commits !== 1 ? "s" : ""})`;
		}
		case "PullRequestEvent": {
			const pr = payload.pull_request as { title?: string } | undefined;
			const action = payload.action as string | undefined;
			return `PR ${action}: ${pr?.title ?? "unknown"}`;
		}
		case "IssuesEvent": {
			const issue = payload.issue as { title?: string } | undefined;
			const action = payload.action as string | undefined;
			return `Issue ${action}: ${issue?.title ?? "unknown"}`;
		}
		case "ReleaseEvent": {
			const release = payload.release as { tag_name?: string } | undefined;
			return `Release: ${release?.tag_name ?? "unknown"}`;
		}
		default:
			return type.replace("Event", "");
	}
}
