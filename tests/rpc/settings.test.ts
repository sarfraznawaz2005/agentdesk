/**
 * settings.test.ts
 *
 * Tests for the settings RPC handlers (getSetting, saveSetting, getSettings).
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import { createTestDb } from "../helpers/db";

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-settings" } },
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();

mock.module("../../src/bun/db", () => ({ db: testDb }));
mock.module("../../src/bun/db/connection", () => ({ sqlite: testSqlite }));
mock.module("../../src/bun/db/audit", () => ({ logAudit: () => {} }));
mock.module("../../src/bun/providers/models", () => ({
	clearContextLimitCache: () => {},
	getDefaultModel: () => "claude-3-5-sonnet-20241022",
	getContextLimit: () => 128000,
}));

const { getSetting, saveSetting, getSettings } = await import("../../src/bun/rpc/settings");

// -------------------------------------------------------------------------

describe("getSetting", () => {
	it("returns null for a non-existent key", async () => {
		const val = await getSetting("this-key-does-not-exist");
		expect(val).toBeNull();
	});

	it("returns null for a non-existent key in a specific category", async () => {
		const val = await getSetting("nonexistent", "general");
		expect(val).toBeNull();
	});
});

describe("saveSetting and getSetting", () => {
	it("stores a string value and retrieves it", async () => {
		await saveSetting("theme", "dark", "ui");
		const val = await getSetting("theme");
		expect(val).toBe("dark");
	});

	it("overwrites an existing setting on second call", async () => {
		await saveSetting("language", "en", "general");
		await saveSetting("language", "fr", "general");
		const val = await getSetting("language");
		expect(val).toBe("fr");
	});

	it("does not create duplicate rows on upsert", async () => {
		await saveSetting("unique-key", "v1", "test");
		await saveSetting("unique-key", "v2", "test");

		const { settings } = await import("../../src/bun/db/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await testDb.select().from(settings).where(eq(settings.key, "unique-key"));
		expect(rows).toHaveLength(1);
	});

	it("round-trips a JSON object value", async () => {
		const obj = { port: 3000, host: "localhost", debug: true };
		await saveSetting("server-config", obj, "network");
		const raw = await getSetting("server-config");
		// saveSetting serialises via JSON.stringify; getSetting parses with JSON.parse
		expect(raw).toEqual(obj);
	});

	it("round-trips a JSON array value", async () => {
		const arr = ["alpha", "beta", "gamma"];
		await saveSetting("features", arr, "general");
		const result = await getSetting("features");
		expect(result).toEqual(arr);
	});

	it("returns the value scoped to the correct category", async () => {
		await saveSetting("mode", "production", "deployment");
		const val = await getSetting("mode", "deployment");
		expect(val).toBe("production");
	});

	it("returns null when the key exists but is in a different category", async () => {
		await saveSetting("cat-key", "value", "cat-a");
		const val = await getSetting("cat-key", "cat-b");
		expect(val).toBeNull();
	});
});

describe("getSettings", () => {
	it("returns all settings when no category filter is provided", async () => {
		await saveSetting("gs-key-1", "val1", "misc");
		await saveSetting("gs-key-2", "val2", "misc");
		const all = await getSettings();
		expect(all["gs-key-1"]).toBe("val1");
		expect(all["gs-key-2"]).toBe("val2");
	});

	it("filters by category when provided", async () => {
		await saveSetting("cat-filter-a", "aaa", "category-x");
		await saveSetting("cat-filter-b", "bbb", "category-y");
		const cx = await getSettings("category-x");
		expect(cx["cat-filter-a"]).toBe("aaa");
		expect(cx["cat-filter-b"]).toBeUndefined();
	});

	it("returns an empty object when no settings exist in the category", async () => {
		const result = await getSettings("empty-category-xyz");
		expect(Object.keys(result)).toHaveLength(0);
	});
});

describe("global vs project settings isolation", () => {
	it("project settings and global settings do not collide with the same logical key", async () => {
		const projectId = crypto.randomUUID();
		// Store a project-scoped setting via direct key namespacing convention.
		await saveSetting(`project:${projectId}:timeout`, "30", "project");
		// Store a global setting with the same logical name.
		await saveSetting("timeout", "60", "general");

		const projectVal = await getSetting(`project:${projectId}:timeout`);
		const globalVal = await getSetting("timeout");

		expect(projectVal).toBe("30");
		expect(globalVal).toBe("60");
	});
});
