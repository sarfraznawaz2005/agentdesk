/**
 * tests/helpers/git.ts
 *
 * Utilities for initialising git repositories in temporary workspaces.
 */

import { execSync } from "child_process";

/**
 * Initialise a bare git repository in `dir` with a test identity.
 * Throws if git is not available or init fails.
 */
export function initGitRepo(dir: string): void {
	execSync("git init", { cwd: dir, stdio: "pipe" });
	execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
	execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
	// Set a default branch name so behaviour is predictable across git versions
	try {
		execSync("git config init.defaultBranch main", { cwd: dir, stdio: "pipe" });
	} catch {
		// Older git versions may not support this; fine to ignore
	}
}

/**
 * Stage all changes and create a commit in `dir`.
 * Uses `--allow-empty` so it works even when there are no files.
 */
export function gitAddCommit(dir: string, message = "init"): void {
	execSync("git add -A", { cwd: dir, stdio: "pipe" });
	execSync(`git commit -m "${message}" --allow-empty`, {
		cwd: dir,
		stdio: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test.com",
		},
	});
}
