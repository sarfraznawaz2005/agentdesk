/**
 * tests/db/settings.test.ts
 *
 * Tests for key/value settings storage using the test DB directly.
 * Does NOT import any app RPC files (they depend on electrobun).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";

let testDbInstance: TestDb;

beforeEach(() => {
	testDbInstance = createTestDb();
});

afterEach(() => {
	testDbInstance.sqlite.close();
});

// ---------------------------------------------------------------------------
// Helper functions — mirror the settings RPC logic without importing it
// ---------------------------------------------------------------------------

async function saveSetting(db: TestDb["db"], key: string, value: string): Promise<void> {
	const { settings } = await import("../../src/bun/db/schema");
	const existing = await db
		.select({ id: settings.id })
		.from(settings)
		.where(eq(settings.key, key))
		.limit(1);

	if (existing.length > 0) {
		await db
			.update(settings)
			.set({ value })
			.where(eq(settings.key, key));
	} else {
		await db.insert(settings).values({
			id: crypto.randomUUID(),
			key,
			value,
			category: "general",
		});
	}
}

async function getSetting(db: TestDb["db"], key: string): Promise<string | null> {
	const { settings } = await import("../../src/bun/db/schema");
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, key))
		.limit(1);
	return rows.length > 0 ? rows[0].value : null;
}

async function saveProjectSetting(
	db: TestDb["db"],
	projectId: string,
	key: string,
	value: string,
): Promise<void> {
	return saveSetting(db, `project:${projectId}:${key}`, value);
}

async function getProjectSetting(
	db: TestDb["db"],
	projectId: string,
	key: string,
): Promise<string | null> {
	return getSetting(db, `project:${projectId}:${key}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Settings storage", () => {
	it("stores a value and reads it back", async () => {
		const { db } = testDbInstance;
		await saveSetting(db, "theme", '"dark"');
		const value = await getSetting(db, "theme");
		expect(value).toBe('"dark"');
	});

	it("returns null for missing key", async () => {
		const { db } = testDbInstance;
		const value = await getSetting(db, "nonexistent-key");
		expect(value).toBeNull();
	});

	it("overwrites existing value without creating duplicates", async () => {
		const { settings } = await import("../../src/bun/db/schema");
		const { db } = testDbInstance;

		await saveSetting(db, "mykey", '"first"');
		await saveSetting(db, "mykey", '"second"');

		const rows = await db
			.select()
			.from(settings)
			.where(eq(settings.key, "mykey"));
		expect(rows.length).toBe(1);
		expect(rows[0].value).toBe('"second"');
	});

	it("round-trips a JSON object value", async () => {
		const { db } = testDbInstance;
		const obj = { provider: "anthropic", model: "claude-sonnet-4" };
		const serialized = JSON.stringify(obj);

		await saveSetting(db, "provider_config", serialized);
		const raw = await getSetting(db, "provider_config");
		expect(raw).not.toBeNull();
		const parsed = JSON.parse(raw!);
		expect(parsed).toEqual(obj);
	});

	it("round-trips a JSON array value", async () => {
		const { db } = testDbInstance;
		const arr = ["alpha", "beta", "gamma"];
		await saveSetting(db, "tags", JSON.stringify(arr));

		const raw = await getSetting(db, "tags");
		const parsed = JSON.parse(raw!);
		expect(parsed).toEqual(arr);
	});

	it("stores and retrieves project-scoped settings", async () => {
		const { db } = testDbInstance;
		const projectId = "proj-123";

		await saveProjectSetting(db, projectId, "shellApprovalMode", '"always"');
		const val = await getProjectSetting(db, projectId, "shellApprovalMode");
		expect(val).toBe('"always"');
	});

	it("project settings for different projects do not interfere", async () => {
		const { db } = testDbInstance;

		await saveProjectSetting(db, "proj-A", "theme", '"light"');
		await saveProjectSetting(db, "proj-B", "theme", '"dark"');

		const valA = await getProjectSetting(db, "proj-A", "theme");
		const valB = await getProjectSetting(db, "proj-B", "theme");

		expect(valA).toBe('"light"');
		expect(valB).toBe('"dark"');
	});

	it("stores boolean false as a JSON-serialised value", async () => {
		const { db } = testDbInstance;
		await saveSetting(db, "autoExecuteNextTask", "false");
		const raw = await getSetting(db, "autoExecuteNextTask");
		expect(raw).toBe("false");
	});
});
