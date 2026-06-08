// ---------------------------------------------------------------------------
// Auto-Earn — freelance-expert orchestrator
//
// Runs the freelance-expert agent (runInlineAgent) for a job, with FULL context:
// the complete job/listing description, the entire thread conversation, the user
// persona + Additional Notes, the job state, and the redacted credential list.
// Modeled on the Issue Fixer orchestrator. One run per event; deduped per job.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Utils } from "electrobun/bun";
import { db } from "../../db";
import { sqlite } from "../../db/connection";
import { aiProviders } from "../../db/schema";
import { getDefaultModel } from "../../providers/models";
import type { ProviderConfig } from "../../providers/types";
import { runInlineAgent, type InlineAgentCallbacks } from "../../agents/agent-loop";
import { getFreelanceSettings } from "../settings";
import { getAutoEarnSettings } from "../auto-earn-settings";
import { isAutoEarnFeatureAvailable } from "../feature-flag";
import { upsertJobForThread, getJobByThread, logJobAction, listJobFacts, type FreelanceJob } from "./jobs";
import { listCredentialSummaries } from "./vault";
import { buildFreelanceExpertTools } from "./tools";
import { escalateToHuman } from "./notify";
import { HUMANIZER_WRITING_RULES } from "../humanizer-prompt";

const DEFAULT_PLATFORM = "freelancer";
const EXCLUDE_TOOLS = [
	"request_human_input",
	"request_plan_approval",
	"create_tasks_from_plan",
	"verify_implementation",
	"submit_review",
	"git_reset",
	"git_cherry_pick",
	"set_feature_branch",
	"clear_feature_branch",
];

// One run per job at a time.
const running = new Set<string>();

async function resolveProviderConfig(): Promise<{ config: ProviderConfig; modelId: string }> {
	let row = (await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1))[0];
	if (!row) row = (await db.select().from(aiProviders).limit(1))[0];
	if (!row) throw new Error("No AI provider configured");
	return {
		config: {
			id: row.id,
			name: row.name,
			providerType: row.providerType,
			apiKey: row.apiKey ?? "",
			baseUrl: row.baseUrl ?? null,
			defaultModel: row.defaultModel ?? null,
		},
		modelId: row.defaultModel || getDefaultModel(row.providerType),
	};
}

function getPersona(): string {
	try {
		const rows = sqlite.prepare(`SELECT key, value FROM settings WHERE category = 'user'`).all() as Array<{ key: string; value: string }>;
		const map = new Map(rows.map((r) => [r.key, r.value]));
		const name = map.get("user_name") ?? "";
		const email = map.get("user_email") ?? "";
		const parts: string[] = [];
		if (name) parts.push(`Name: ${name}`);
		if (email) parts.push(`Email (do NOT share unless Additional Notes allow): ${email}`);
		return parts.join("\n");
	} catch {
		return "";
	}
}

function buildThreadTranscript(threadId: string, selfUserId: string | null): string {
	const rows = sqlite
		.prepare(
			`SELECT m.from_user, m.body, u.display_name AS from_name
			 FROM freelance_inbox_messages m LEFT JOIN freelance_inbox_users u ON u.id = m.from_user
			 WHERE m.thread_id = ? ORDER BY m.sent_at ASC LIMIT 60`,
		)
		.all(threadId) as Array<{ from_user: string | null; body: string; from_name: string | null }>;
	return rows
		.map((r) => `${selfUserId && r.from_user === selfUserId ? "Me" : r.from_name || "Client"}: ${r.body}`)
		.join("\n");
}

function getSelfUserId(platform: string): string | null {
	const r = sqlite.prepare(`SELECT self_user_id FROM freelance_accounts WHERE platform = ?`).get(platform) as
		| { self_user_id: string | null }
		| undefined;
	return r?.self_user_id ?? null;
}

function getListingFullDescription(listingId: string | null): { title: string; body: string } | null {
	if (!listingId) return null;
	const r = sqlite.prepare(`SELECT title, description, full_description, skills, url FROM freelance_listings WHERE id = ?`).get(listingId) as
		| { title: string; description: string; full_description: string | null; skills: string; url: string }
		| undefined;
	if (!r) return null;
	let skills = "";
	try {
		skills = (JSON.parse(r.skills) as string[]).join(", ");
	} catch {
		/* ignore */
	}
	return {
		title: r.title,
		body: `Title: ${r.title}\nSkills: ${skills}\nURL: ${r.url}\n\n${r.full_description || r.description || ""}`,
	};
}

export interface RunExpertInput {
	platform?: string;
	threadId?: string;
	listingId?: string;
	/** What triggered this run, woven into the task. */
	trigger: "new_message" | "awarded" | "manual" | "bid_request";
	note?: string;
}

/**
 * Run the freelance-expert for a thread/listing. Idempotent-ish: one concurrent
 * run per job. Returns the job id.
 */
export async function runFreelanceExpert(input: RunExpertInput): Promise<{ jobId: string } | null> {
	const platform = input.platform ?? DEFAULT_PLATFORM;

	// Hard gate: the whole Auto-Earn feature requires the `autoearn` flag file.
	if (!isAutoEarnFeatureAvailable()) return null;

	// The freelance-expert only runs AUTONOMOUSLY when Auto-Earn is enabled AND the
	// account is in full-auto AND the risk acknowledgment is set. In assisted mode
	// the user drives the inbox manually and the expert stays out of the way.
	const ae = await getAutoEarnSettings();
	if (!ae.enabled || !ae.fullautoAck) return null;
	const acct = (sqlite.prepare(`SELECT autonomy_mode FROM freelance_accounts WHERE platform = ?`).get(platform) as { autonomy_mode: string } | undefined)?.autonomy_mode;
	const fullAuto = acct === "full_auto" || (acct == null && ae.autonomyMode === "full_auto");
	if (!fullAuto) return null;

	const threadId = input.threadId ?? null;
	let job: FreelanceJob;
	if (threadId) {
		job = upsertJobForThread(platform, threadId, { listingId: input.listingId ?? null });
	} else if (input.listingId) {
		// listing-only (cold bid) — synthesize a job keyed on a pseudo thread.
		job = upsertJobForThread(platform, `listing:${input.listingId}`, { listingId: input.listingId, state: "lead" });
	} else {
		return null;
	}

	if (running.has(job.id)) return { jobId: job.id };
	running.add(job.id);
	try {
		const { config: providerConfig, modelId } = await resolveProviderConfig();
		const fl = await getFreelanceSettings();
		const selfUserId = threadId ? getSelfUserId(platform) : null;
		const listing = getListingFullDescription(job.listingId);
		const transcript = threadId ? buildThreadTranscript(threadId, selfUserId) : "";
		const creds = listCredentialSummaries(job.id);
		const facts = listJobFacts(job.id);

		const workspacePath = job.projectId
			? (sqlite.prepare(`SELECT workspace_path FROM projects WHERE id = ?`).get(job.projectId) as { workspace_path: string } | undefined)?.workspace_path ??
				join(Utils.paths.userData, "freelance-jobs", job.id)
			: join(Utils.paths.userData, "freelance-jobs", job.id);
		try {
			mkdirSync(workspacePath, { recursive: true });
		} catch {
			/* exists */
		}

		const projectContext = [
			`## Persona (act as this person)`,
			getPersona() || "(no persona set)",
			``,
			`## Additional Notes (the user's rules — follow strictly)`,
			fl.additionalNotes?.trim() || "(none)",
			``,
			`## Job`,
			`State: ${job.state}`,
			job.listingExternalId ? `Platform project id: ${job.listingExternalId}` : "",
			``,
			`## Full job description`,
			listing ? listing.body : "(no linked listing)",
			``,
			`## Conversation so far (most recent last)`,
			transcript || "(no messages yet)",
			``,
			`## Important client/job facts (remembered — honor these)`,
			facts.length ? facts.map((f) => `- [${f.category}] ${f.detail}`).join("\n") : "(none yet — save new ones with save_important_client_detail)",
			``,
			`## Stored credentials (redacted — use the credentialId with the tools)`,
			creds.length ? JSON.stringify(creds) : "(none)",
			``,
			`## How to write to clients`,
			HUMANIZER_WRITING_RULES,
		]
			.filter((s) => s !== "")
			.join("\n");

		const task = [
			`Trigger: ${input.trigger}.`,
			input.note ? `Note: ${input.note}` : "",
			``,
			`Decide the right next action for this job and take it using your tools (reply, bid, store credentials, clone/download, create project, deliver, mark state, or escalate). Stay within the guardrails. If you cannot proceed confidently, call notify_human and stop.`,
		]
			.filter(Boolean)
			.join("\n");

		const callbacks: InlineAgentCallbacks = {
			onPartCreated: () => {},
			onPartUpdated: () => {},
			onTextDelta: () => {},
			onAgentStart: () => {},
			onAgentComplete: () => {},
		};

		const extraTools = buildFreelanceExpertTools({
			jobId: job.id,
			platform,
			threadId,
			listingId: job.listingId,
			workspacePath,
		});

		logJobAction(job.id, "expert_run", `trigger=${input.trigger}`);
		const result = await runInlineAgent({
			conversationId: `fx-${job.id}`,
			agentName: "freelance-expert",
			agentDisplayName: "Freelance Expert",
			task,
			projectContext,
			providerConfig,
			modelId,
			callbacks,
			workspacePath,
			projectId: job.projectId ?? `fx-${job.id}`,
			persistToDb: false,
			extraTools,
			excludeTools: EXCLUDE_TOOLS,
		});
		logJobAction(job.id, "expert_done", String(result?.status ?? "done"));
		return { jobId: job.id };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logJobAction(job.id, "expert_error", msg, "error");
		await escalateToHuman({
			jobId: job.id,
			platform,
			threadId: threadId ?? undefined,
			reason: "Freelance expert run failed",
			detail: msg,
			severity: "blocker",
		});
		return { jobId: job.id };
	} finally {
		running.delete(job.id);
	}
}

export { getJobByThread };
