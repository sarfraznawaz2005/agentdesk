/**
 * github-api.test.ts
 *
 * src/bun/rpc/github-api.ts is the single choke point for GitHub authentication
 * across the app (Git tab, Issue Fixer, PR tools). CLAUDE.md documents it as
 * a "hard-won rule": embedding a token in a git remote URL while Git Credential
 * Manager is active makes git STORE an account and pop an interactive
 * "Select an account" dialog on the user's own future pushes — fatal for
 * autonomous flows like Issue Fixer, where no human is present to dismiss it.
 * Despite that severity, this file had no dedicated test. This suite pins
 * down:
 *
 *   - resolveGitHubToken's 3-step fallback chain (per-project custom, when
 *     explicitly selected, or inferred from token presence for back-compat >
 *     global github_pat > legacy githubToken) — existing-user compatibility
 *     depends on the inference and legacy-fallback behaving exactly as
 *     documented
 *   - gitAuthArgs never invokes a credential helper
 *   - githubAuthPrefix only activates for HTTPS github.com remotes
 *   - pushBranchAuthenticated's safety contract: exact-branch refspec (never
 *     "push current branch"), token never embedded in the URL, and error text
 *     redaction
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mock, describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createTestDb } from "../helpers/db";

const testUserData = mkdtempSync(join(tmpdir(), "agentdesk-github-api-"));
mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: testUserData } },
}));
afterAll(() => rmSync(testUserData, { recursive: true, force: true }));

const { db: testDb, sqlite: testSqlite } = createTestDb();
mock.module("../../src/bun/db", () => ({ db: testDb }));

// Controllable fake for the shared git runner — records every invocation and
// lets each test script canned responses for "remote get-url origin" / "push".
type GitCall = { args: string[]; cwd: string };
const gitCalls: GitCall[] = [];
let remoteUrlResponse = { stdout: "", stderr: "", exitCode: 0 };
let pushResponse = { stdout: "", stderr: "", exitCode: 0 };

mock.module("../../src/bun/lib/git-runner", () => ({
	runGit: async (args: string[], cwd: string) => {
		gitCalls.push({ args, cwd });
		if (args.includes("push")) return pushResponse;
		if (args.includes("remote")) return remoteUrlResponse;
		return { stdout: "", stderr: "", exitCode: 0 };
	},
}));

const {
	resolveGitHubToken,
	getProjectGitHubTokenSource,
	getProjectGitHubTokenInfo,
	gitAuthArgs,
	githubAuthPrefix,
	pushBranchAuthenticated,
	parseGithubUrl,
} = await import("../../src/bun/rpc/github-api");
const { encryptSecret } = await import("../../src/bun/lib/secret-crypto");

async function seedProject(githubUrl?: string): Promise<string> {
	const id = crypto.randomUUID();
	testSqlite
		.prepare("INSERT INTO projects(id, name, workspace_path, github_url) VALUES (?, ?, ?, ?)")
		.run(id, "gh-test", `/tmp/${id}`, githubUrl ?? null);
	return id;
}

// Raw sqlite for settings writes — simpler and avoids drizzle import churn.
// Mirrors saveProjectSetting's convention: plain values are JSON-stringified
// (readers JSON.parse them back), but pre-encrypted values must be stored
// RAW so decryptSecret can see the "enc:v1:" prefix untouched.
function insertSetting(key: string, value: string, category: string) {
	testSqlite
		.prepare(
			"INSERT INTO settings(id, key, value, category) VALUES (?, ?, ?, ?) " +
				"ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = excluded.category",
		)
		.run(crypto.randomUUID(), key, JSON.stringify(value), category);
}

function insertEncryptedSetting(key: string, plainValue: string, category: string) {
	testSqlite
		.prepare(
			"INSERT INTO settings(id, key, value, category) VALUES (?, ?, ?, ?) " +
				"ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = excluded.category",
		)
		.run(crypto.randomUUID(), key, encryptSecret(plainValue), category);
}

beforeEach(() => {
	testSqlite.exec("DELETE FROM settings; DELETE FROM projects;");
	gitCalls.length = 0;
	remoteUrlResponse = { stdout: "", stderr: "", exitCode: 0 };
	pushResponse = { stdout: "", stderr: "", exitCode: 0 };
});

// ---------------------------------------------------------------------------

describe("resolveGitHubToken — fallback chain", () => {
	it("returns null when nothing is configured", async () => {
		expect(await resolveGitHubToken()).toBeNull();
	});

	it("falls back to the legacy githubToken/git setting when github_pat is absent", async () => {
		insertSetting("githubToken", "legacy-token", "git");
		expect(await resolveGitHubToken()).toBe("legacy-token");
	});

	it("prefers the global github_pat over the legacy setting", async () => {
		insertSetting("githubToken", "legacy-token", "git");
		insertSetting("github_pat", "global-pat", "github");
		expect(await resolveGitHubToken()).toBe("global-pat");
	});

	it("a project with no explicit token source and no custom token uses the global PAT", async () => {
		insertSetting("github_pat", "global-pat", "github");
		const projectId = await seedProject();
		expect(await getProjectGitHubTokenSource(projectId)).toBe("global");
		expect(await resolveGitHubToken({ projectId })).toBe("global-pat");
	});

	it("infers source 'custom' for back-compat when a project has a saved custom token but no explicit source", async () => {
		const projectId = await seedProject();
		insertEncryptedSetting(`project:${projectId}:githubToken`, "project-token", "project");
		expect(await getProjectGitHubTokenSource(projectId)).toBe("custom");
		expect(await resolveGitHubToken({ projectId })).toBe("project-token");
	});

	it("an explicit source of 'global' overrides a saved custom token (ignores it)", async () => {
		const projectId = await seedProject();
		insertEncryptedSetting(`project:${projectId}:githubToken`, "project-token", "project");
		insertSetting(`project:${projectId}:githubTokenSource`, "global", "project");
		insertSetting("github_pat", "global-pat", "github");
		expect(await getProjectGitHubTokenSource(projectId)).toBe("global");
		expect(await resolveGitHubToken({ projectId })).toBe("global-pat");
	});

	it("decrypts an encrypted per-project custom token transparently", async () => {
		const projectId = await seedProject();
		insertEncryptedSetting(`project:${projectId}:githubToken`, "super-secret-pat", "project");
		insertSetting(`project:${projectId}:githubTokenSource`, "custom", "project");
		expect(await resolveGitHubToken({ projectId })).toBe("super-secret-pat");
	});

	it("resolves the project by workspacePath when projectId isn't passed directly", async () => {
		const projectId = await seedProject();
		insertEncryptedSetting(`project:${projectId}:githubToken`, "workspace-resolved-token", "project");
		insertSetting(`project:${projectId}:githubTokenSource`, "custom", "project");
		const row = testSqlite.prepare("SELECT workspace_path FROM projects WHERE id = ?").get(projectId) as { workspace_path: string };
		expect(await resolveGitHubToken({ workspacePath: row.workspace_path })).toBe("workspace-resolved-token");
	});

	it("getProjectGitHubTokenInfo never leaks the token value, only presence + source", async () => {
		const projectId = await seedProject();
		insertEncryptedSetting(`project:${projectId}:githubToken`, "hidden", "project");
		const info = await getProjectGitHubTokenInfo(projectId);
		expect(info).toEqual({ source: "custom", hasCustomToken: true });
		expect(JSON.stringify(info)).not.toContain("hidden");
	});
});

describe("gitAuthArgs — never invokes a credential helper", () => {
	it("disables credential.helper and supplies a Basic auth extraheader", () => {
		const args = gitAuthArgs("my-token");
		expect(args).toEqual([
			"-c",
			"credential.helper=",
			"-c",
			`http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from("x-access-token:my-token").toString("base64")}`,
		]);
	});

	it("never embeds the raw token in the args — only the base64 Basic header", () => {
		const args = gitAuthArgs("plaintext-secret");
		expect(args.join(" ")).not.toContain("plaintext-secret");
	});
});

describe("githubAuthPrefix — HTTPS github.com remotes only", () => {
	it("returns [] for a non-github remote", async () => {
		remoteUrlResponse = { stdout: "https://gitlab.com/foo/bar.git", stderr: "", exitCode: 0 };
		insertSetting("github_pat", "pat", "github");
		expect(await githubAuthPrefix({ workspacePath: "/tmp/x" })).toEqual([]);
	});

	it("returns [] for an SSH github remote (keys don't need our header)", async () => {
		remoteUrlResponse = { stdout: "git@github.com:foo/bar.git", stderr: "", exitCode: 0 };
		insertSetting("github_pat", "pat", "github");
		expect(await githubAuthPrefix({ workspacePath: "/tmp/x" })).toEqual([]);
	});

	it("returns [] when no token is configured, even for an https github remote", async () => {
		remoteUrlResponse = { stdout: "https://github.com/foo/bar.git", stderr: "", exitCode: 0 };
		expect(await githubAuthPrefix({ workspacePath: "/tmp/x" })).toEqual([]);
	});

	it("returns [] when the remote lookup itself fails", async () => {
		remoteUrlResponse = { stdout: "", stderr: "fatal: no remote", exitCode: 128 };
		insertSetting("github_pat", "pat", "github");
		expect(await githubAuthPrefix({ workspacePath: "/tmp/x" })).toEqual([]);
	});

	it("returns the auth args for an https github.com remote with a token configured", async () => {
		remoteUrlResponse = { stdout: "https://github.com/foo/bar.git", stderr: "", exitCode: 0 };
		insertSetting("github_pat", "pat", "github");
		expect(await githubAuthPrefix({ workspacePath: "/tmp/x" })).toEqual(gitAuthArgs("pat"));
	});
});

describe("pushBranchAuthenticated — safety contract", () => {
	it("rejects an empty branch name", async () => {
		const result = await pushBranchAuthenticated({ workspacePath: "/tmp/x", branch: "" });
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/no branch specified/i);
	});

	it("fails cleanly when no token is configured", async () => {
		const result = await pushBranchAuthenticated({ workspacePath: "/tmp/x", branch: "feature/x" });
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/token not configured/i);
	});

	it("fails cleanly when the origin remote can't be read", async () => {
		insertSetting("github_pat", "pat", "github");
		remoteUrlResponse = { stdout: "", stderr: "", exitCode: 128 };
		const result = await pushBranchAuthenticated({ workspacePath: "/tmp/x", branch: "feature/x" });
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/could not read origin/i);
	});

	it("fails cleanly when origin isn't a GitHub remote", async () => {
		insertSetting("github_pat", "pat", "github");
		remoteUrlResponse = { stdout: "https://gitlab.com/foo/bar.git", stderr: "", exitCode: 0 };
		const result = await pushBranchAuthenticated({ workspacePath: "/tmp/x", branch: "feature/x" });
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not a GitHub URL/);
	});

	it("pushes ONLY the named branch via an explicit refspec, never a bare/current-branch push", async () => {
		insertSetting("github_pat", "the-real-token", "github");
		remoteUrlResponse = { stdout: "https://github.com/acme/widgets.git", stderr: "", exitCode: 0 };
		pushResponse = { stdout: "", stderr: "", exitCode: 0 };

		const result = await pushBranchAuthenticated({ workspacePath: "/tmp/x", branch: "feature/my-fix" });
		expect(result.ok).toBe(true);

		const pushCall = gitCalls.find((c) => c.args.includes("push"))!;
		expect(pushCall).toBeDefined();
		// Explicit branch:branch refspec — never a bare "push" that defaults to
		// whatever branch happens to be checked out.
		expect(pushCall.args.at(-1)).toBe("feature/my-fix:feature/my-fix");
		// Credential helper is disabled and the token never appears embedded in
		// the destination URL.
		expect(pushCall.args).toContain("credential.helper=");
		const pushUrlArg = pushCall.args.find((a) => a.startsWith("https://github.com/"));
		expect(pushUrlArg).toBe("https://github.com/acme/widgets.git");
		expect(pushUrlArg).not.toContain("the-real-token");
	});

	it("rewrites an SSH-style origin to the https push URL (owner/repo parsed from either form)", async () => {
		insertSetting("github_pat", "tok", "github");
		remoteUrlResponse = { stdout: "git@github.com:acme/widgets.git", stderr: "", exitCode: 0 };
		pushResponse = { stdout: "", stderr: "", exitCode: 0 };
		await pushBranchAuthenticated({ workspacePath: "/tmp/x", branch: "b" });
		const pushCall = gitCalls.find((c) => c.args.includes("push"))!;
		expect(pushCall.args.find((a) => a.startsWith("https://github.com/"))).toBe("https://github.com/acme/widgets.git");
	});

	it("redacts the token from git's error output on push failure", async () => {
		insertSetting("github_pat", "leak-me-not", "github");
		remoteUrlResponse = { stdout: "https://github.com/acme/widgets.git", stderr: "", exitCode: 0 };
		pushResponse = { stdout: "", stderr: "remote: Invalid credentials for token leak-me-not", exitCode: 1 };
		const result = await pushBranchAuthenticated({ workspacePath: "/tmp/x", branch: "b" });
		expect(result.ok).toBe(false);
		expect(result.error).not.toContain("leak-me-not");
		expect(result.error).toContain("***");
	});
});

describe("parseGithubUrl", () => {
	it("parses a standard https URL with .git suffix", () => {
		expect(parseGithubUrl("https://github.com/acme/widgets.git")).toEqual({ owner: "acme", repo: "widgets" });
	});

	it("parses a URL without the .git suffix", () => {
		expect(parseGithubUrl("https://github.com/acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
	});

	it("returns null for a non-URL string", () => {
		expect(parseGithubUrl("not-a-url")).toBeNull();
	});

	it("returns null for a URL with too few path segments", () => {
		expect(parseGithubUrl("https://github.com/acme")).toBeNull();
	});
});
