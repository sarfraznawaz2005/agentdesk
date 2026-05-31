/**
 * agents.test.ts
 *
 * Tests for agent CRUD RPC handlers. Manually seeds agent rows so we don't
 * depend on the full seed.ts bootstrap process.
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../helpers/db";

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-agents" } },
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();

mock.module("../../src/bun/db", () => ({ db: testDb }));
mock.module("../../src/bun/db/connection", () => ({ sqlite: testSqlite }));
mock.module("../../src/bun/db/audit", () => ({ logAudit: () => {} }));

// Stub the tools modules that agents.ts imports.
mock.module("../../src/bun/agents/tools/index", () => ({
	getToolDefinitions: () => [],
	clearToolCache: () => {},
	getToolsForAgent: async () => ({}),
	getAllTools: () => ({}),
	registerTools: () => {},
}));
mock.module("../../src/bun/db/seed", () => ({
	getDefaultAgentTools: () => [],
}));

const {
	getAgentsList,
	createAgent,
	updateAgent,
	deleteAgent,
	getAgentToolsList,
	setAgentToolsList,
} = await import("../../src/bun/rpc/agents");

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function seedBuiltinAgent(name: string): Promise<string> {
	const id = crypto.randomUUID();
	testSqlite.exec(
		`INSERT INTO agents(id, name, display_name, color, system_prompt, is_builtin)
     VALUES ('${id}','${name}','${name} Display','#fff','test prompt',1)`,
	);
	return id;
}

async function seedCustomAgent(name: string): Promise<string> {
	const id = crypto.randomUUID();
	testSqlite.exec(
		`INSERT INTO agents(id, name, display_name, color, system_prompt, is_builtin)
     VALUES ('${id}','${name}','${name} Display','#000','custom prompt',0)`,
	);
	return id;
}

// -------------------------------------------------------------------------

describe("getAgentsList", () => {
	it("returns a list of agents", async () => {
		await seedBuiltinAgent("test-list-agent-" + crypto.randomUUID());
		const agents = await getAgentsList();
		expect(agents.length).toBeGreaterThan(0);
	});

	it("maps isBuiltin integer to boolean", async () => {
		await seedBuiltinAgent("builtin-agent-" + crypto.randomUUID());
		const agents = await getAgentsList();
		const builtin = agents.find((a) => a.isBuiltin);
		expect(typeof builtin!.isBuiltin).toBe("boolean");
		expect(builtin!.isBuiltin).toBe(true);
	});

	it("is sorted alphabetically by displayName", async () => {
		const uid = crypto.randomUUID().slice(0, 6);
		await seedBuiltinAgent(`zz-agent-${uid}`);
		await seedBuiltinAgent(`aa-agent-${uid}`);
		const agents = await getAgentsList();
		const displayNames = agents.map((a) => a.displayName);
		const sorted = [...displayNames].sort((a, b) => a.localeCompare(b));
		expect(displayNames).toEqual(sorted);
	});
});

describe("createAgent", () => {
	it("inserts a custom agent and returns success:true with an id", async () => {
		const result = await createAgent({
			name: "test-agent-" + crypto.randomUUID(),
			displayName: "Test Agent",
			color: "#123456",
			systemPrompt: "You are a test agent.",
		});
		expect(result.success).toBe(true);
		expect(result.id).toBeTruthy();
	});

	it("marks the created agent as not builtin", async () => {
		const { id } = await createAgent({
			name: "custom-" + crypto.randomUUID(),
			displayName: "Custom",
			color: "#000",
			systemPrompt: "",
		});
		const agents = await getAgentsList();
		const agent = agents.find((a) => a.id === id);
		expect(agent!.isBuiltin).toBe(false);
	});
});

describe("updateAgent", () => {
	it("updates the display name", async () => {
		const id = await seedBuiltinAgent("update-agent-" + crypto.randomUUID());
		await updateAgent({ id, displayName: "Updated Name" });
		const agents = await getAgentsList();
		const agent = agents.find((a) => a.id === id);
		expect(agent!.displayName).toBe("Updated Name");
	});

	it("updates the system prompt", async () => {
		const id = await seedBuiltinAgent("prompt-agent-" + crypto.randomUUID());
		await updateAgent({ id, systemPrompt: "New system prompt" });
		const { agents } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb.select({ systemPrompt: agents.systemPrompt }).from(agents).where(eq(agents.id, id));
		expect(rows[0].systemPrompt).toBe("New system prompt");
	});

	it("updates modelId", async () => {
		const id = await seedBuiltinAgent("model-agent-" + crypto.randomUUID());
		await updateAgent({ id, modelId: "claude-3-5-sonnet-20241022" });
		const { agents } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb.select({ modelId: agents.modelId }).from(agents).where(eq(agents.id, id));
		expect(rows[0].modelId).toBe("claude-3-5-sonnet-20241022");
	});

	it("sets isEnabled to false", async () => {
		const id = await seedBuiltinAgent("disable-agent-" + crypto.randomUUID());
		await updateAgent({ id, isEnabled: false });
		const { agents } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb.select({ isEnabled: agents.isEnabled }).from(agents).where(eq(agents.id, id));
		expect(rows[0].isEnabled).toBe(0);
	});
});

describe("deleteAgent", () => {
	it("prevents deleting a builtin agent", async () => {
		const id = await seedBuiltinAgent("nodelete-" + crypto.randomUUID());
		const result = await deleteAgent(id);
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("deletes a custom agent", async () => {
		const id = await seedCustomAgent("delete-custom-" + crypto.randomUUID());
		const result = await deleteAgent(id);
		expect(result.success).toBe(true);
		const agents = await getAgentsList();
		expect(agents.find((a) => a.id === id)).toBeUndefined();
	});
});

describe("getAgentToolsList / setAgentToolsList", () => {
	it("returns an empty list when no tools have been assigned", async () => {
		const id = await seedBuiltinAgent("tools-empty-" + crypto.randomUUID());
		const tools = await getAgentToolsList(id);
		expect(tools).toHaveLength(0);
	});

	it("sets tool assignments and retrieves them", async () => {
		const id = await seedBuiltinAgent("tools-set-" + crypto.randomUUID());
		await setAgentToolsList(id, [
			{ toolName: "read_file", isEnabled: true },
			{ toolName: "write_file", isEnabled: false },
		]);
		const tools = await getAgentToolsList(id);
		expect(tools).toHaveLength(2);
		const readFile = tools.find((t) => t.toolName === "read_file");
		const writeFile = tools.find((t) => t.toolName === "write_file");
		expect(readFile!.isEnabled).toBe(true);
		expect(writeFile!.isEnabled).toBe(false);
	});

	it("replaces existing tools on a second call (no duplicates)", async () => {
		const id = await seedBuiltinAgent("tools-replace-" + crypto.randomUUID());
		await setAgentToolsList(id, [{ toolName: "read_file", isEnabled: true }]);
		await setAgentToolsList(id, [{ toolName: "write_file", isEnabled: true }]);
		const tools = await getAgentToolsList(id);
		expect(tools).toHaveLength(1);
		expect(tools[0].toolName).toBe("write_file");
	});

	it("returns an empty list after clearing all tools", async () => {
		const id = await seedBuiltinAgent("tools-clear-" + crypto.randomUUID());
		await setAgentToolsList(id, [{ toolName: "git_status", isEnabled: true }]);
		await setAgentToolsList(id, []);
		const tools = await getAgentToolsList(id);
		expect(tools).toHaveLength(0);
	});
});
