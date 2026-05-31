import { db } from "../db";
import { projects } from "../db/schema";
import { eq } from "drizzle-orm";
import { runGit } from "../lib/git-runner";

async function getProject(projectId: string) {
	const rows = await db.select({ workspacePath: projects.workspacePath, githubUrl: projects.githubUrl }).from(projects).where(eq(projects.id, projectId)).limit(1);
	if (rows.length === 0) throw new Error(`Project not found: ${projectId}`);
	return rows[0];
}

async function getWorkspacePath(projectId: string): Promise<string> {
	return (await getProject(projectId)).workspacePath;
}

/** Ensures `origin` remote exists. If not, adds it from the project's githubUrl. */
async function ensureRemote(projectId: string, cwd: string): Promise<string | undefined> {
	const { stdout } = await runGit(["remote", "get-url", "origin"], cwd);
	if (stdout.trim()) return undefined; // already configured
	const { githubUrl } = await getProject(projectId);
	if (!githubUrl) return "No remote configured and no GitHub URL set in project settings.";
	await runGit(["remote", "add", "origin", githubUrl.trim()], cwd);
	return undefined;
}

export async function getGitStatus(projectId: string) {
	const cwd = await getWorkspacePath(projectId);
	const { stdout } = await runGit(["status", "--porcelain"], cwd);
	const files = stdout.trim().split("\n").filter(Boolean).map((line) => ({
		status: line.slice(0, 2).trim(),
		file: line.slice(2).trimStart(),
	}));
	return { files };
}

export async function getGitBranches(projectId: string) {
	const cwd = await getWorkspacePath(projectId);
	const { stdout } = await runGit(["branch", "-a"], cwd);
	const branches = stdout.trim().split("\n").filter(Boolean).map((line) => ({
		name: line.replace(/^\*?\s+/, "").trim(),
		isCurrent: line.startsWith("*"),
		isRemote: line.trim().startsWith("remotes/"),
	}));
	return { branches };
}

export async function getGitLog(projectId: string, limit = 20) {
	const cwd = await getWorkspacePath(projectId);
	const { stdout } = await runGit(["log", `--format=%H|%an|%s|%ai`, `-n`, String(limit)], cwd);
	const commits = stdout.trim().split("\n").filter(Boolean).map((line) => {
		const [hash, author, message, date] = line.split("|");
		return { hash: hash?.slice(0, 8) ?? "", author: author ?? "", message: message ?? "", date: date ?? "" };
	});
	return { commits };
}

export async function getGitDiff(projectId: string, file?: string) {
	const cwd = await getWorkspacePath(projectId);
	const args = file ? ["diff", file] : ["diff"];
	const { stdout } = await runGit(args, cwd);
	return { diff: stdout.slice(0, 50000) };
}

export async function getCommitFiles(projectId: string, hash: string) {
	const cwd = await getWorkspacePath(projectId);
	const { stdout } = await runGit(["diff-tree", "--no-commit-id", "-r", "--name-status", hash], cwd);
	const files = stdout.trim().split("\n").filter(Boolean).map((line) => {
		const tab = line.indexOf("\t");
		return { status: line.slice(0, tab).trim(), file: line.slice(tab + 1).trim() };
	});
	return { files };
}

export async function gitCheckout(projectId: string, branch: string) {
	const cwd = await getWorkspacePath(projectId);
	const { exitCode, stderr } = await runGit(["checkout", branch], cwd);
	return { success: exitCode === 0, error: exitCode !== 0 ? stderr : undefined };
}

export async function gitCreateBranch(projectId: string, name: string) {
	const cwd = await getWorkspacePath(projectId);
	const { exitCode, stderr } = await runGit(["checkout", "-b", name], cwd);
	return { success: exitCode === 0, error: exitCode !== 0 ? stderr : undefined };
}

export async function gitStageFiles(projectId: string, files: string[]) {
	const cwd = await getWorkspacePath(projectId);
	const { exitCode, stderr } = await runGit(["add", ...files], cwd);
	return { success: exitCode === 0, error: exitCode !== 0 ? stderr : undefined };
}

export async function gitCommit(projectId: string, message: string) {
	const cwd = await getWorkspacePath(projectId);
	const { exitCode, stderr } = await runGit(["commit", "-m", message], cwd);
	return { success: exitCode === 0, error: exitCode !== 0 ? stderr : undefined };
}

export async function gitPush(projectId: string) {
	const cwd = await getWorkspacePath(projectId);
	const remoteErr = await ensureRemote(projectId, cwd);
	if (remoteErr) return { success: false, error: remoteErr };
	const { exitCode, stdout, stderr } = await runGit(["push", "--set-upstream", "origin", "HEAD"], cwd);
	// git push writes progress to stderr even on success; combine both for display
	const output = [stdout, stderr].filter(Boolean).join("\n").trim() || "Push complete.";
	return { success: exitCode === 0, output: exitCode === 0 ? output : undefined, error: exitCode !== 0 ? output : undefined };
}

export async function gitPull(projectId: string, remoteBranch?: string) {
	const cwd = await getWorkspacePath(projectId);
	const remoteErr = await ensureRemote(projectId, cwd);
	if (remoteErr) return { success: false, error: remoteErr };

	// Explicit remote branch supplied (user answered the branch prompt)
	if (remoteBranch) {
		const { exitCode, stdout, stderr } = await runGit(["pull", "origin", remoteBranch], cwd);
		if (exitCode === 0) {
			// Persist the tracking relationship so future pulls work without prompting
			await runGit(["branch", `--set-upstream-to=origin/${remoteBranch}`], cwd);
		}
		const output = [stdout, stderr].filter(Boolean).join("\n").trim() || "Already up to date.";
		return { success: exitCode === 0, output: exitCode === 0 ? output : undefined, error: exitCode !== 0 ? output : undefined };
	}

	const { exitCode, stdout, stderr } = await runGit(["pull"], cwd);

	// No upstream tracking — ask the user which remote branch to pull from
	if (exitCode !== 0 && stderr.includes("no tracking information")) {
		return { success: false, noTracking: true };
	}

	const output = [stdout, stderr].filter(Boolean).join("\n").trim() || "Already up to date.";
	return { success: exitCode === 0, output: exitCode === 0 ? output : undefined, error: exitCode !== 0 ? output : undefined };
}

// ── Phase 9: Branch management & conflict resolution ─────────────────────────

export async function getConflicts(projectId: string) {
	const cwd = await getWorkspacePath(projectId);
	const { stdout } = await runGit(["diff", "--name-only", "--diff-filter=U"], cwd);
	const files = stdout.trim().split("\n").filter(Boolean);
	return { files };
}

export async function getConflictDiff(projectId: string, file: string) {
	const cwd = await getWorkspacePath(projectId);
	const { stdout } = await runGit(["diff", "--", file], cwd);
	return { diff: stdout.slice(0, 100000) };
}

export async function gitDeleteBranch(projectId: string, name: string) {
	const cwd = await getWorkspacePath(projectId);
	const { exitCode } = await runGit(["branch", "-d", name], cwd);
	if (exitCode !== 0) {
		// Try force delete
		const force = await runGit(["branch", "-D", name], cwd);
		return { success: force.exitCode === 0, error: force.exitCode !== 0 ? force.stderr : undefined };
	}
	return { success: true };
}

export async function gitMergeBranch(projectId: string, branch: string, strategy?: string) {
	const cwd = await getWorkspacePath(projectId);

	let args: string[];
	// squash handled inline above; this handles merge + rebase
	if (strategy === "squash") {
		const squashResult = await runGit(["merge", "--squash", branch], cwd);
		if (squashResult.exitCode !== 0) {
			return { success: false, error: squashResult.stderr || squashResult.stdout };
		}
		// --squash stages changes but doesn't commit — must commit explicitly
		const commitResult = await runGit(["commit", "-m", `squash merge ${branch}`], cwd);
		if (commitResult.exitCode !== 0) {
			return { success: false, error: commitResult.stderr || commitResult.stdout };
		}
		return { success: true };
	} else if (strategy === "rebase") {
		// We'll checkout the source and rebase onto current
		const rebaseResult = await runGit(["rebase", branch], cwd);
		if (rebaseResult.exitCode !== 0) {
			const hasConflicts = rebaseResult.stderr.includes("CONFLICT") || rebaseResult.stdout.includes("CONFLICT");
			const { files } = await getConflicts(projectId);
			return { success: false, hasConflicts, conflictFiles: files, error: rebaseResult.stderr };
		}
		return { success: true };
	} else {
		args = ["merge", "--no-ff", branch];
	}

	const { exitCode, stdout, stderr } = await runGit(args, cwd);
	const hasConflicts = stdout.includes("CONFLICT") || stderr.includes("CONFLICT");
	if (exitCode !== 0 || hasConflicts) {
		const { files } = await getConflicts(projectId);
		return { success: false, hasConflicts, conflictFiles: files, error: stderr || stdout };
	}
	return { success: true };
}

export async function gitRebaseBranch(projectId: string, onto: string) {
	const cwd = await getWorkspacePath(projectId);
	const { exitCode, stderr } = await runGit(["rebase", onto], cwd);
	return { success: exitCode === 0, error: exitCode !== 0 ? stderr : undefined };
}

export async function gitAbortMerge(projectId: string) {
	const cwd = await getWorkspacePath(projectId);
	// Try abort merge, then rebase
	const mergeAbort = await runGit(["merge", "--abort"], cwd);
	if (mergeAbort.exitCode === 0) return { success: true };
	const rebaseAbort = await runGit(["rebase", "--abort"], cwd);
	return { success: rebaseAbort.exitCode === 0, error: rebaseAbort.exitCode !== 0 ? rebaseAbort.stderr : undefined };
}

export async function getMergedBranches(projectId: string) {
	const cwd = await getWorkspacePath(projectId);
	const { stdout } = await runGit(["branch", "--merged", "HEAD"], cwd);
	const branches = stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((b) => b.replace(/^\*?\s+/, "").trim())
		.filter((b) => !["main", "master", "develop", "HEAD"].includes(b));
	return { branches };
}

export async function cleanupMergedBranches(projectId: string) {
	const { branches } = await getMergedBranches(projectId);
	const deleted: string[] = [];
	const errors: string[] = [];
	for (const branch of branches) {
		const result = await gitDeleteBranch(projectId, branch);
		if (result.success) deleted.push(branch);
		else errors.push(`${branch}: ${result.error ?? "unknown error"}`);
	}
	return { deleted, errors };
}
