import { describe, it, expect } from "bun:test";
import { findShellViolation } from "../../src/bun/issue-fixer/shell-guard";

describe("issue-fixer shell guard", () => {
	const base = "main";

	it("blocks git merge", () => {
		expect(findShellViolation("git merge feature", base)).not.toBeNull();
	});

	it("blocks git rebase", () => {
		expect(findShellViolation("git rebase main", base)).not.toBeNull();
	});

	it("blocks gh pr merge", () => {
		expect(findShellViolation("gh pr merge 42 --squash", base)).not.toBeNull();
	});

	it("blocks force push (--force and -f)", () => {
		expect(findShellViolation("git push origin foo --force", base)).not.toBeNull();
		expect(findShellViolation("git push -f origin foo", base)).not.toBeNull();
		expect(findShellViolation("git push origin foo --force-with-lease", base)).not.toBeNull();
	});

	it("blocks git reset --hard", () => {
		expect(findShellViolation("git reset --hard HEAD~1", base)).not.toBeNull();
	});

	it("blocks ALL pushes (orchestrator owns push) and gh CLI", () => {
		expect(findShellViolation("git push origin main", base)).not.toBeNull();
		expect(findShellViolation("git push origin issue-fix/12-foo", base)).not.toBeNull();
		expect(findShellViolation("gh pr create --fill", base)).not.toBeNull();
		expect(findShellViolation("gh pr merge 2 --squash", base)).not.toBeNull();
	});

	it("blocks destructive / undo commands", () => {
		expect(findShellViolation("git reset HEAD~1", base)).not.toBeNull();
		expect(findShellViolation("git clean -fd", base)).not.toBeNull();
		expect(findShellViolation("git restore .", base)).not.toBeNull();
		expect(findShellViolation("git checkout -- src/app.ts", base)).not.toBeNull();
		expect(findShellViolation("git switch main", base)).not.toBeNull();
		expect(findShellViolation("git branch -D feature", base)).not.toBeNull();
		expect(findShellViolation("git push origin --delete feature", base)).not.toBeNull();
		expect(findShellViolation("git push origin :feature", base)).not.toBeNull();
		expect(findShellViolation("git filter-branch --tree-filter x", base)).not.toBeNull();
		expect(findShellViolation("git reflog expire --all", base)).not.toBeNull();
		expect(findShellViolation("git stash clear", base)).not.toBeNull();
		expect(findShellViolation("rm -rf src", base)).not.toBeNull();
		expect(findShellViolation("rm -fr build", base)).not.toBeNull();
	});

	it("allows normal commands", () => {
		expect(findShellViolation("npm test", base)).toBeNull();
		expect(findShellViolation("bun run build", base)).toBeNull();
		expect(findShellViolation("git commit -m 'fix'", base)).toBeNull();
		expect(findShellViolation("git status", base)).toBeNull();
		expect(findShellViolation("git diff", base)).toBeNull();
		expect(findShellViolation("git add -A", base)).toBeNull();
		expect(findShellViolation("rm file.txt", base)).toBeNull();
	});
});
