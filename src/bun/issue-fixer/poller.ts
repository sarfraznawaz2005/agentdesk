// ---------------------------------------------------------------------------
// Issue Fixer — poller
//
// Outbound polling (no inbound webhooks => NAT-safe + private). A 60s tick checks
// each enabled project and polls it when its configured interval has elapsed
// (restart-safe via lastPolledAt). For each new issue/comment it applies the
// trigger + authorization + anti-runaway gates and enqueues runs.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "../db";
import { projects } from "../db/schema";
import { parseGithubUrl, resolveGitHubToken } from "../rpc/github-api";
import { listOpenIssuesSince, listIssueCommentsSince, getIssue, type GhComment } from "./github";
import {
	matchIssue,
	matchComment,
	alreadyProcessed,
	runsInLastHour,
	type TriggerConfig,
	type TriggerMatch,
} from "./triggers";
import { enqueueIssueFix, type IssueFixInput } from "./orchestrator";
import {
	listEnabledConfigs,
	getIssueFixerConfig,
	setCursor,
	setLastPolled,
	createRun,
	failInterruptedRuns,
} from "./config";

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startIssueFixerPolling(): void {
	if (timer) return;
	// Clean up any runs interrupted by a previous shutdown/crash.
	void failInterruptedRuns().catch((e) => console.error("[issue-fixer] failInterruptedRuns:", e));
	timer = setInterval(() => {
		void tick();
	}, 60_000);
	// On startup, poll EVERY enabled project once immediately — regardless of each
	// project's interval gate — so any pending agentdesk-* issues are picked up right
	// away (in addition to the normal interval poll + manual "Poll now"). Fire-and-forget
	// so it never blocks app startup.
	void pollAllEnabledOnce();
}

/**
 * Poll every enabled project exactly once, ignoring the per-project interval gate.
 * Used as the startup kick. Reuses the same overlap guard as the interval tick.
 */
export async function pollAllEnabledOnce(): Promise<void> {
	if (ticking) return;
	ticking = true;
	try {
		const configs = await listEnabledConfigs();
		for (const c of configs) {
			await pollProject(c.projectId).catch((e) =>
				console.error(`[issue-fixer] startup poll ${c.projectId} failed:`, e),
			);
		}
	} catch (e) {
		console.error("[issue-fixer] startup poll failed:", e);
	} finally {
		ticking = false;
	}
}

export function stopIssueFixerPolling(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

async function tick(): Promise<void> {
	if (ticking) return; // never let a slow poll overlap with the next interval
	ticking = true;
	try {
		const configs = await listEnabledConfigs();
		const now = Date.now();
		for (const c of configs) {
			const last = c.lastPolledAt ? Date.parse(c.lastPolledAt) : 0;
			const due = !c.lastPolledAt || now - last >= c.pollIntervalMin * 60_000;
			if (due) {
				await pollProject(c.projectId).catch((e) =>
					console.error(`[issue-fixer] poll ${c.projectId} failed:`, e),
				);
			}
		}
	} catch (e) {
		console.error("[issue-fixer] tick failed:", e);
	} finally {
		ticking = false;
	}
}

/** Outcome of a single poll — lets the manual "Poll now" surface an accurate toast. */
export interface PollResult {
	reason: "disabled" | "no-credentials" | "primed" | "polled";
	enqueued: number;
	ignored: number;
}

/** Poll a single project once. Exported so the RPC `pollNow` can trigger it on demand. */
export async function pollProject(projectId: string): Promise<PollResult> {
	const config = await getIssueFixerConfig(projectId);
	if (!config || !config.enabled) return { reason: "disabled", enqueued: 0, ignored: 0 };

	const proj = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
	const parsed = proj?.githubUrl ? parseGithubUrl(proj.githubUrl) : null;
	const token = await resolveGitHubToken({ projectId });
	const nowIso = new Date().toISOString();

	if (!parsed || !token) {
		await setLastPolled(projectId, nowIso);
		return { reason: "no-credentials", enqueued: 0, ignored: 0 };
	}

	// First poll after enabling: just set the cursor so old issues aren't processed.
	if (!config.cursorAt) {
		await setCursor(projectId, nowIso);
		await setLastPolled(projectId, nowIso);
		return { reason: "primed", enqueued: 0, ignored: 0 };
	}

	const triggerConfig: TriggerConfig = {
		keywords: config.keywords,
		labels: config.labels,
		authMode: config.authMode,
	};
	const since = config.cursorAt;
	const { owner, repo } = parsed;

	const [issues, comments] = await Promise.all([
		listOpenIssuesSince(owner, repo, since, token),
		listIssueCommentsSince(owner, repo, since, token),
	]);

	// Per-poll enqueue budget so a single burst can't exceed maxPerHour (DB rows for
	// runs enqueued this poll don't exist yet, so runsInLastHour alone can't see them).
	const budget = {
		remaining: Math.max(0, config.maxPerHour - (await runsInLastHour(projectId, Date.now()))),
	};

	let enqueued = 0;
	let ignored = 0;
	const tally = (o: MatchOutcome) => {
		if (o === "enqueued") enqueued++;
		else if (o === "ignored") ignored++;
	};

	// Issues — title/label triggers.
	for (const issue of issues) {
		const match = matchIssue(issue, triggerConfig);
		if (!match) continue;
		const issueComments = comments.filter((c) => c.issueNumber === issue.number).map((c) => c.body);
		tally(await handleMatch(projectId, match, {
			issueNumber: issue.number,
			issueTitle: issue.title,
			issueBody: issue.body,
			issueUrl: issue.htmlUrl,
			comments: issueComments,
		}, budget));
	}

	// Comments — keyword triggers (issue comments AND PR conversation comments).
	for (const comment of comments) {
		const match = matchComment(comment, triggerConfig);
		if (!match) continue;
		const ctx = await buildCommentContext(owner, repo, comment, token);
		tally(await handleMatch(projectId, match, ctx, budget));
	}

	await setCursor(projectId, nowIso);
	await setLastPolled(projectId, nowIso);
	return { reason: "polled", enqueued, ignored };
}

interface IssueCtx {
	issueNumber: number;
	issueTitle: string;
	issueBody?: string | null;
	issueUrl?: string | null;
	comments?: string[];
}

async function buildCommentContext(
	owner: string,
	repo: string,
	comment: GhComment,
	token: string,
): Promise<IssueCtx> {
	const issue = await getIssue(owner, repo, comment.issueNumber, token);
	return {
		issueNumber: comment.issueNumber,
		issueTitle: issue?.title ?? `#${comment.issueNumber}`,
		issueBody: issue?.body ?? null,
		issueUrl: issue?.htmlUrl ?? comment.htmlUrl,
		comments: [comment.body],
	};
}

type MatchOutcome = "enqueued" | "ignored" | "skipped";

async function handleMatch(
	projectId: string,
	match: TriggerMatch,
	ctx: IssueCtx,
	budget: { remaining: number },
): Promise<MatchOutcome> {
	// Dedup first — never re-process the same trigger.
	if (await alreadyProcessed(projectId, match.issueNumber, match.triggerCommentId)) return "skipped";

	// Unauthorized actor — record as ignored for visibility, then stop.
	if (!match.authorized) {
		await createRun({
			projectId,
			issueNumber: match.issueNumber,
			issueTitle: ctx.issueTitle,
			issueUrl: ctx.issueUrl,
			triggerType: match.triggerType,
			triggerKeyword: match.keyword,
			triggerCommentId: match.triggerCommentId,
			intent: match.intent,
			author: match.author,
			authorized: false,
			status: "ignored",
		});
		return "ignored";
	}

	// Max-per-hour budget only. Cooldown is enforced as a pre-run DELAY in the orchestrator
	// (not a drop here), so a burst of matches in one poll is never silently lost.
	if (budget.remaining <= 0) return "skipped";
	budget.remaining -= 1;
	const input: IssueFixInput = {
		projectId,
		issueNumber: ctx.issueNumber,
		issueTitle: ctx.issueTitle,
		issueBody: ctx.issueBody,
		issueUrl: ctx.issueUrl,
		comments: ctx.comments,
		intent: match.intent,
		triggerType: match.triggerType,
		triggerKeyword: match.keyword,
		triggerCommentId: match.triggerCommentId,
		author: match.author,
		authorized: true,
		// PR-feedback loop: a comment on a PR conversation updates that PR's branch.
		prNumber: match.triggerType === "pr_comment" ? match.issueNumber : null,
	};
	void enqueueIssueFix(input);
	return "enqueued";
}
