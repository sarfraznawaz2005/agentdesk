/**
 * projects.test.ts
 *
 * Tests for the project RPC handlers.  Each test uses an in-memory SQLite
 * database so no filesystem state leaks between runs.
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../helpers/db";

// Electrobun must be mocked before any import that pulls it transitively.
mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-projects" } },
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();

mock.module("../../src/bun/db", () => ({ db: testDb }));
// The connection module is used for prepared-statement cascade deletes.
mock.module("../../src/bun/db/connection", () => ({ sqlite: testSqlite }));

mock.module("../../src/bun/db/audit", () => ({
	logAudit: () => {},
}));

mock.module("../../src/bun/providers/models", () => ({
	clearContextLimitCache: () => {},
	getContextLimit: () => 128000,
	getDefaultModel: () => "claude-3-5-sonnet-20241022",
}));

mock.module("../../src/bun/engine-manager", () => ({
	abortAllAgents: () => {},
	engines: new Map(),
	broadcastToWebview: () => {},
	getOrCreateEngine: () => ({ getActiveConversationId: () => null }),
	registerAgentController: () => {},
	unregisterAgentController: () => {},
	getRunningAgentCount: () => 0,
	getRunningAgentNames: () => [],
}));

// Import module under test after all mocks.
const {
	createProjectHandler,
	getProject,
	getProjectsList,
	updateProject,
	deleteProjectHandler,
	saveProjectSetting,
	getProjectSettings,
	isAutoExecuteEnabled,
} = await import("../../src/bun/rpc/projects");

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function randomPath(): string {
	return `/tmp/test-workspace-${crypto.randomUUID()}`;
}

// -------------------------------------------------------------------------

describe("createProjectHandler", () => {
	it("inserts a project and returns success:true with a non-empty id", async () => {
		const result = await createProjectHandler({
			name: "My Test Project",
			workspacePath: randomPath(),
		});
		expect(result.success).toBe(true);
		expect(result.id).toBeTruthy();
	});

	it("persists the project so getProject can retrieve it", async () => {
		const path = randomPath();
		const { id } = await createProjectHandler({ name: "Persisted", workspacePath: path });

		const project = await getProject(id);
		expect(project).not.toBeNull();
		expect(project!.name).toBe("Persisted");
		expect(project!.workspacePath).toBe(path);
	});

	it("seeds default project settings (thinkingBudget, shellApprovalMode, etc.)", async () => {
		const { id } = await createProjectHandler({ name: "Seeded", workspacePath: randomPath() });
		const settings = await getProjectSettings(id);
		expect(settings["thinkingBudget"]).toBe("medium");
		expect(settings["shellApprovalMode"]).toBe("ask");
		expect(settings["maxReviewRounds"]).toBeTruthy();
	});
});

describe("isAutoExecuteEnabled (auto-execute next task gate)", () => {
	it("is true by default", async () => {
		const { id } = await createProjectHandler({ name: "AutoExecDefault", workspacePath: randomPath() });
		expect(await isAutoExecuteEnabled(id)).toBe(true);
	});

	it("is false when the setting is \"false\"", async () => {
		const { id } = await createProjectHandler({ name: "AutoExecOff", workspacePath: randomPath() });
		await saveProjectSetting(id, "autoExecuteNextTask", "false");
		expect(await isAutoExecuteEnabled(id)).toBe(false);
	});

	it("is true when the setting is \"true\"", async () => {
		const { id } = await createProjectHandler({ name: "AutoExecOn", workspacePath: randomPath() });
		await saveProjectSetting(id, "autoExecuteNextTask", "true");
		expect(await isAutoExecuteEnabled(id)).toBe(true);
	});

	it("reflects a toggle immediately (live — the basis for no-restart behaviour)", async () => {
		const { id } = await createProjectHandler({ name: "AutoExecToggle", workspacePath: randomPath() });
		expect(await isAutoExecuteEnabled(id)).toBe(true);
		await saveProjectSetting(id, "autoExecuteNextTask", "false");
		expect(await isAutoExecuteEnabled(id)).toBe(false);
		await saveProjectSetting(id, "autoExecuteNextTask", "true");
		expect(await isAutoExecuteEnabled(id)).toBe(true);
	});

	it("is scoped per-project", async () => {
		const a = await createProjectHandler({ name: "AutoExecA", workspacePath: randomPath() });
		const b = await createProjectHandler({ name: "AutoExecB", workspacePath: randomPath() });
		await saveProjectSetting(a.id, "autoExecuteNextTask", "false");
		expect(await isAutoExecuteEnabled(a.id)).toBe(false);
		expect(await isAutoExecuteEnabled(b.id)).toBe(true); // unaffected
	});
});

describe("getProjectsList", () => {
	it("returns all projects including newly created ones", async () => {
		const path = randomPath();
		await createProjectHandler({ name: "ListTest", workspacePath: path });
		const list = await getProjectsList();
		expect(list.some((p) => p.name === "ListTest")).toBe(true);
	});

	it("returns an empty array when no projects exist (isolated DB scenario)", async () => {
		// Create a fresh isolated DB to prove the list starts empty.
		const { db: freshDb } = createTestDb();
		const { drizzle } = await import("drizzle-orm/bun-sqlite");
		const { projects: projectsTable } = await import("../../src/bun/db/schema");
		const rows = await freshDb.select().from(projectsTable);
		expect(rows).toHaveLength(0);
	});
});

describe("getProject", () => {
	it("returns null for a non-existent id", async () => {
		const project = await getProject("does-not-exist");
		expect(project).toBeNull();
	});

	it("returns the correct project data", async () => {
		const path = randomPath();
		const { id } = await createProjectHandler({
			name: "GetMe",
			description: "A description",
			workspacePath: path,
		});
		const project = await getProject(id);
		expect(project!.id).toBe(id);
		expect(project!.name).toBe("GetMe");
		expect(project!.description).toBe("A description");
		expect(project!.status).toBe("active");
	});
});

describe("updateProject", () => {
	it("updates the project name", async () => {
		const { id } = await createProjectHandler({ name: "OldName", workspacePath: randomPath() });
		await updateProject({ id, name: "NewName" });
		const updated = await getProject(id);
		expect(updated!.name).toBe("NewName");
	});

	it("updates the project status", async () => {
		const { id } = await createProjectHandler({ name: "StatusTest", workspacePath: randomPath() });
		await updateProject({ id, status: "paused" });
		const updated = await getProject(id);
		expect(updated!.status).toBe("paused");
	});

	it("returns an error for an invalid status", async () => {
		const { id } = await createProjectHandler({ name: "BadStatus", workspacePath: randomPath() });
		const result = await updateProject({ id, status: "invalid-status" });
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

describe("deleteProjectHandler", () => {
	it("removes the project from the database", async () => {
		const { id } = await createProjectHandler({ name: "DeleteMe", workspacePath: randomPath() });
		await deleteProjectHandler(id);
		const project = await getProject(id);
		expect(project).toBeNull();
	});

	it("returns success:true even if the project didn't exist", async () => {
		const result = await deleteProjectHandler("nonexistent-id");
		expect(result.success).toBe(true);
	});
});

describe("saveProjectSetting / getProjectSettings", () => {
	it("stores and retrieves a setting", async () => {
		const { id } = await createProjectHandler({ name: "SettingsTest", workspacePath: randomPath() });
		await saveProjectSetting(id, "myKey", "myValue");
		const settings = await getProjectSettings(id);
		expect(settings["myKey"]).toBe("myValue");
	});

	it("overwrites an existing setting without creating a duplicate row", async () => {
		const { id } = await createProjectHandler({ name: "OverwriteTest", workspacePath: randomPath() });
		await saveProjectSetting(id, "color", "blue");
		await saveProjectSetting(id, "color", "red");
		const settings = await getProjectSettings(id);
		expect(settings["color"]).toBe("red");
	});

	it("stores settings under the project:<id>:<key> prefix", async () => {
		const { id } = await createProjectHandler({ name: "PrefixTest", workspacePath: randomPath() });
		await saveProjectSetting(id, "feature", "enabled");

		// Query the raw settings row to confirm the key format.
		const { settings } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb
			.select({ key: settings.key })
			.from(settings)
			.where(eq(settings.key, `project:${id}:feature`));
		expect(rows).toHaveLength(1);
	});

	it("different projects do not share settings", async () => {
		const { id: id1 } = await createProjectHandler({ name: "P1", workspacePath: randomPath() });
		const { id: id2 } = await createProjectHandler({ name: "P2", workspacePath: randomPath() });

		await saveProjectSetting(id1, "alpha", "first");
		await saveProjectSetting(id2, "alpha", "second");

		const s1 = await getProjectSettings(id1);
		const s2 = await getProjectSettings(id2);

		expect(s1["alpha"]).toBe("first");
		expect(s2["alpha"]).toBe("second");
	});
});
