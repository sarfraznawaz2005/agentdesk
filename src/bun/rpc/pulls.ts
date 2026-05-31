import { db } from "../db";
import { pullRequests, prComments, projects } from "../db/schema";
import { eq, and, desc } from "drizzle-orm";
import { githubFetch, getProjectGithubRepo } from "./github-api";
import * as gitRpc from "./git";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapPr(row: typeof pullRequests.$inferSelect) {
	return {
		id: row.id,
		projectId: row.projectId,
		prNumber: row.prNumber,
		title: row.title,
		description: row.description,
		sourceBranch: row.sourceBranch,
		targetBranch: row.targetBranch,
		state: row.state,
		authorName: row.authorName,
		linkedTaskId: row.linkedTaskId,
		mergeStrategy: row.mergeStrategy,
		mergedAt: row.mergedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

// ── Pull Requests ─────────────────────────────────────────────────────────────

export async function getPullRequests(projectId: string, state?: string) {
	const conditions = state
		? and(eq(pullRequests.projectId, projectId), eq(pullRequests.state, state))
		: eq(pullRequests.projectId, projectId);
	const rows = await db
		.select()
		.from(pullRequests)
		.where(conditions)
		.orderBy(desc(pullRequests.createdAt));
	return rows.map(mapPr);
}

export async function createPullRequest(params: {
	projectId: string;
	title: string;
	description?: string;
	sourceBranch: string;
	targetBranch: string;
	linkedTaskId?: string;
}) {
	// Reject duplicate titles (open PRs only — closed/merged can share titles)
	const existing = await db
		.select({ id: pullRequests.id })
		.from(pullRequests)
		.where(and(eq(pullRequests.projectId, params.projectId), eq(pullRequests.title, params.title), eq(pullRequests.state, "open")))
		.limit(1);
	if (existing.length > 0) {
		return { id: "", error: "An open pull request with this title already exists." };
	}

	// Optionally push to GitHub if configured
	const repo = await getProjectGithubRepo(params.projectId);
	let prNumber: number | undefined;
	if (repo) {
		const res = await githubFetch(
			`/repos/${repo.owner}/${repo.repo}/pulls`,
			{
				method: "POST",
				body: JSON.stringify({
					title: params.title,
					body: params.description ?? "",
					head: params.sourceBranch,
					base: params.targetBranch,
				}),
			},
			repo.pat,
		);
		if (res.ok && typeof (res.data as { number?: number }).number === "number") {
			prNumber = (res.data as { number: number }).number;
		}
	}

	const id = crypto.randomUUID();
	await db.insert(pullRequests).values({
		id,
		projectId: params.projectId,
		prNumber: prNumber ?? null,
		title: params.title,
		description: params.description ?? null,
		sourceBranch: params.sourceBranch,
		targetBranch: params.targetBranch,
		state: "open",
		linkedTaskId: params.linkedTaskId ?? null,
	});
	return { id };
}

export async function updatePullRequest(params: {
	id: string;
	title?: string;
	description?: string;
	state?: string;
}) {
	const updates: Partial<typeof pullRequests.$inferInsert> = {
		updatedAt: new Date().toISOString(),
	};
	if (params.title !== undefined) updates.title = params.title;
	if (params.description !== undefined) updates.description = params.description;
	if (params.state !== undefined) updates.state = params.state;
	await db.update(pullRequests).set(updates).where(eq(pullRequests.id, params.id));
	return { success: true };
}

export async function mergePullRequest(id: string, strategy: "merge" | "squash" | "rebase", deleteBranch = false) {
	const rows = await db
		.select()
		.from(pullRequests)
		.where(eq(pullRequests.id, id))
		.limit(1);
	const pr = rows[0];
	if (!pr) return { success: false, error: "PR not found" };

	// Checkout the target branch first so the merge goes in the right direction
	const { workspacePath: cwdForCheckout } = (await db
		.select({ workspacePath: projects.workspacePath })
		.from(projects)
		.where(eq(projects.id, pr.projectId))
		.limit(1))[0] ?? {};

	if (cwdForCheckout) {
		const { runGit } = await import("../lib/git-runner");
		const checkoutResult = await runGit(["checkout", pr.targetBranch], cwdForCheckout);
		if (checkoutResult.exitCode !== 0) {
			return { success: false, error: `Could not switch to target branch '${pr.targetBranch}': ${checkoutResult.stderr}` };
		}
	}

	// Perform the local git merge (now on targetBranch, merging sourceBranch into it)
	const mergeResult = await gitRpc.gitMergeBranch(pr.projectId, pr.sourceBranch, strategy);
	if (!mergeResult.success) {
		return { success: false, error: mergeResult.error };
	}

	await db
		.update(pullRequests)
		.set({ state: "merged", mergeStrategy: strategy, mergedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
		.where(eq(pullRequests.id, id));

	// Optionally merge on GitHub too
	const repo = await getProjectGithubRepo(pr.projectId);
	if (repo && pr.prNumber) {
		const ghStrategy = strategy === "squash" ? "squash" : strategy === "rebase" ? "rebase" : "merge";
		await githubFetch(
			`/repos/${repo.owner}/${repo.repo}/pulls/${pr.prNumber}/merge`,
			{ method: "PUT", body: JSON.stringify({ merge_method: ghStrategy }) },
			repo.pat,
		);
	}

	// Delete source branch after merge if requested and branches differ
	if (deleteBranch && pr.sourceBranch !== pr.targetBranch && cwdForCheckout) {
		const { runGit: runGitDel } = await import("../lib/git-runner");
		// We're already on targetBranch from the checkout above — safe to delete
		const localDel = await runGitDel(["branch", "-D", pr.sourceBranch], cwdForCheckout);
		console.log(`[PR] local branch delete '${pr.sourceBranch}': exit=${localDel.exitCode} stdout=${localDel.stdout} stderr=${localDel.stderr}`);
		// Delete remote tracking branch (best-effort, ignore if branch doesn't exist on remote)
		const remoteDel = await runGitDel(["push", "origin", "--delete", pr.sourceBranch], cwdForCheckout);
		console.log(`[PR] remote branch delete '${pr.sourceBranch}': exit=${remoteDel.exitCode} stdout=${remoteDel.stdout} stderr=${remoteDel.stderr}`);
	} else {
		console.log(`[PR] branch deletion skipped: deleteBranch=${deleteBranch} sourceBranch=${pr.sourceBranch} targetBranch=${pr.targetBranch} cwd=${cwdForCheckout}`);
	}

	return { success: true };
}

export async function deletePullRequest(id: string) {
	await db.delete(pullRequests).where(eq(pullRequests.id, id));
	return { success: true };
}

export async function getPrDiff(id: string) {
	const rows = await db
		.select()
		.from(pullRequests)
		.where(eq(pullRequests.id, id))
		.limit(1);
	const pr = rows[0];
	if (!pr) return { diff: "" };
	const result = await gitRpc.getGitDiff(pr.projectId);
	return { diff: result.diff };
}

// ── PR Comments ───────────────────────────────────────────────────────────────

export async function getPrComments(prId: string) {
	const rows = await db
		.select()
		.from(prComments)
		.where(eq(prComments.prId, prId))
		.orderBy(prComments.createdAt);
	return rows.map((r) => ({
		id: r.id,
		prId: r.prId,
		file: r.file,
		lineNumber: r.lineNumber,
		content: r.content,
		authorName: r.authorName,
		authorType: r.authorType,
		createdAt: r.createdAt,
	}));
}

export async function addPrComment(params: {
	prId: string;
	content: string;
	file?: string;
	lineNumber?: number;
	authorName?: string;
	authorType?: string;
}) {
	const id = crypto.randomUUID();
	await db.insert(prComments).values({
		id,
		prId: params.prId,
		content: params.content,
		file: params.file ?? null,
		lineNumber: params.lineNumber ?? null,
		authorName: params.authorName ?? "Human",
		authorType: params.authorType ?? "human",
	});
	return { id };
}

export async function deletePrComment(id: string) {
	await db.delete(prComments).where(eq(prComments.id, id));
	return { success: true };
}

// ── Agent PR Description Generator ───────────────────────────────────────────

export async function generatePrDescription(
	projectId: string,
	sourceBranch: string,
	targetBranch: string,
): Promise<{ description: string }> {
	// Get the diff between branches to generate a description
	const { stdout } = await runGitInProject(projectId, [
		"log",
		`${targetBranch}..${sourceBranch}`,
		"--oneline",
		"--no-merges",
	]);

	const commits = stdout.trim();
	if (!commits) {
		return { description: `Merge \`${sourceBranch}\` into \`${targetBranch}\`\n\nNo new commits.` };
	}

	const description = `## Summary\n\nMerge \`${sourceBranch}\` into \`${targetBranch}\`\n\n## Commits\n\n\`\`\`\n${commits}\n\`\`\`\n\n## Changes\n\n- See diff for full details.`;
	return { description };
}

async function runGitInProject(
	projectId: string,
	args: string[],
): Promise<{ stdout: string; stderr: string }> {
	const rows = await db
		.select({ workspacePath: projects.workspacePath })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	const cwd = rows[0]?.workspacePath;
	if (!cwd) return { stdout: "", stderr: "Project not found" };

	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	return { stdout, stderr };
}
