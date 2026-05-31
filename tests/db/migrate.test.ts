/**
 * tests/db/migrate.test.ts
 *
 * Tests that the schema helper correctly creates all expected tables and that
 * applying it twice is idempotent (no errors on re-run).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../helpers/db";

const EXPECTED_TABLES = [
	"settings",
	"ai_providers",
	"projects",
	"agents",
	"agent_tools",
	"conversations",
	"messages",
	"conversation_summaries",
	"notes",
	"kanban_tasks",
	"kanban_task_activity",
	"plugins",
	"channels",
	"deploy_environments",
	"deploy_history",
	"prompts",
	"inbox_messages",
	"whatsapp_sessions",
	"notification_preferences",
	"inbox_rules",
	"cron_jobs",
	"cron_job_history",
	"automation_rules",
	"cost_budgets",
	"pull_requests",
	"pr_comments",
	"webhook_configs",
	"webhook_events",
	"github_issues",
	"branch_strategies",
	"audit_log",
	"keyboard_shortcuts",
	"message_parts",
];

let sqlite: Database;

beforeEach(() => {
	sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => {
	sqlite.close();
});

describe("Schema migration", () => {
	it("starts empty — no user tables before migration", () => {
		const tables = sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
			.all() as Array<{ name: string }>;
		expect(tables.length).toBe(0);
	});

	it("creates all expected tables after applying schema", () => {
		applySchema(sqlite);

		const tables = sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
			.all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);

		for (const expected of EXPECTED_TABLES) {
			expect(tableNames).toContain(expected);
		}
	});

	it("creates message_parts table with correct columns", () => {
		applySchema(sqlite);

		const cols = sqlite
			.prepare("PRAGMA table_info(message_parts)")
			.all() as Array<{ name: string; type: string; notnull: number }>;
		const colNames = cols.map((c) => c.name);

		expect(colNames).toContain("id");
		expect(colNames).toContain("message_id");
		expect(colNames).toContain("type");
		expect(colNames).toContain("content");
		expect(colNames).toContain("tool_name");
		expect(colNames).toContain("tool_input");
		expect(colNames).toContain("tool_output");
		expect(colNames).toContain("tool_state");
		expect(colNames).toContain("sort_order");
		expect(colNames).toContain("agent_name"); // v5 addition
	});

	it("adds verification_status to kanban_tasks (v6)", () => {
		applySchema(sqlite);

		const cols = sqlite
			.prepare("PRAGMA table_info(kanban_tasks)")
			.all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);

		expect(colNames).toContain("verification_status");
	});

	it("adds has_parts and agent_name to messages (v4)", () => {
		applySchema(sqlite);

		const cols = sqlite
			.prepare("PRAGMA table_info(messages)")
			.all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);

		expect(colNames).toContain("has_parts");
		expect(colNames).toContain("agent_name");
	});

	it("adds prompt column to plugins (v2)", () => {
		applySchema(sqlite);

		const cols = sqlite
			.prepare("PRAGMA table_info(plugins)")
			.all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);

		expect(colNames).toContain("prompt");
	});

	it("drops agent_task_results after v4 migration", () => {
		applySchema(sqlite);

		const tables = sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_task_results'")
			.all() as Array<{ name: string }>;
		// v4 drops this table
		expect(tables.length).toBe(0);
	});

	it("is idempotent — applying schema twice does not throw", () => {
		applySchema(sqlite);
		// Should not throw — all CREATE TABLE IF NOT EXISTS
		expect(() => applySchema(sqlite)).not.toThrow();
	});

	it("creates FTS5 virtual tables for full-text search", () => {
		applySchema(sqlite);

		const ftsTables = sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'")
			.all() as Array<{ name: string }>;
		const ftsNames = ftsTables.map((t) => t.name);

		expect(ftsNames).toContain("messages_fts");
		expect(ftsNames).toContain("notes_fts");
		expect(ftsNames).toContain("inbox_fts");
	});
});
