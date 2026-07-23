import { tool } from "ai";
import { z } from "zod";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// query_sqlite — read-only SQL against a SQLite database file
// ---------------------------------------------------------------------------
//
// Reading a SQLite database is an inherently READ-ONLY operation, but before
// this tool the only way to do it was `sqlite3` via run_shell — a WRITE_TOOL,
// and therefore stripped from every read-only agent. So code-explorer could
// confirm a .db file existed and was binary, and then had no way to read a
// single row out of it. Same defect git_show fixes for historical commits:
// a read-only capability that was only reachable through a write tool.
//
// Uses bun:sqlite (already a dependency — the app's own DB runs on it through
// Drizzle), so this adds no new package. Opened `readonly: true` and gated to
// a single read statement, which makes it mechanically safe to hand to a
// read-only agent rather than safe-by-prompt-instruction.

/** Statement kinds that cannot modify the database. */
const READ_STATEMENT = /^(select|with|pragma|explain)\b/i;

/**
 * PRAGMA is read-only only in its query form. `PRAGMA journal_mode = WAL` and
 * friends mutate, and they're indistinguishable from a read by the leading
 * keyword alone — so any PRAGMA carrying an assignment is rejected.
 */
const PRAGMA_ASSIGNMENT = /^pragma\b[^=]*=/i;

/** Strip SQL comments so they can't hide a second statement from the checks below. */
function stripComments(sql: string): string {
	return sql
		.replace(/--[^\n]*/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ");
}

function validateReadOnlyQuery(rawQuery: string): string | null {
	const stripped = stripComments(rawQuery).trim();
	if (!stripped) return "Query is empty.";

	// Reject anything after the first statement terminator. Trailing semicolons
	// are fine; a second statement is not — that's how a read would smuggle in
	// a write (`SELECT 1; DROP TABLE x`).
	const withoutTrailing = stripped.replace(/;\s*$/, "");
	if (withoutTrailing.includes(";")) {
		return "Only a single statement is allowed — remove the additional statement(s) after the first ';'.";
	}

	if (!READ_STATEMENT.test(withoutTrailing)) {
		return "Only read statements are permitted (SELECT, WITH, PRAGMA, EXPLAIN). This tool opens the database read-only and cannot modify data.";
	}

	if (PRAGMA_ASSIGNMENT.test(withoutTrailing)) {
		return "PRAGMA statements that assign a value are not permitted — only the query form (e.g. `PRAGMA table_info(users)`).";
	}

	return null;
}

const MAX_OUTPUT_CHARS = 15_000;

/** SQLite returns BLOBs as Uint8Array, which does not survive JSON.stringify usefully. */
function serializeValue(value: unknown): unknown {
	if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
	if (typeof value === "bigint") return value.toString();
	return value;
}

const querySqliteTool = tool({
	description:
		"Run a read-only SQL query against a SQLite database file and return the rows as JSON. " +
		"The database is opened read-only and only SELECT/WITH/PRAGMA/EXPLAIN statements are accepted, " +
		"so this cannot modify data. Use it to inspect any .db/.sqlite file — application databases, " +
		"caches, test fixtures — without needing shell access. " +
		"To discover the schema first, query `SELECT name, sql FROM sqlite_master WHERE type='table'`, " +
		"or use `PRAGMA table_info(<table>)` for one table's columns.",
	inputSchema: z.object({
		path: z.string().describe("Absolute path to the SQLite database file"),
		query: z
			.string()
			.describe("A single read-only SQL statement (SELECT, WITH, PRAGMA, or EXPLAIN)"),
		params: z
			.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
			.optional()
			.describe("Optional bind parameters for '?' placeholders in the query — prefer these over string interpolation"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(1000)
			.optional()
			.describe("Maximum rows to return (default: 100, max: 1000)"),
	}),
	execute: async ({ path, query, params, limit = 100 }): Promise<string> => {
		const validationError = validateReadOnlyQuery(query);
		if (validationError) {
			return JSON.stringify({ error: validationError });
		}

		// Dynamic import keeps bun:sqlite off this module's static import graph,
		// matching how the other tools defer their heavier dependencies.
		const { Database } = await import("bun:sqlite");

		let database: InstanceType<typeof Database> | null = null;
		try {
			database = new Database(path, { readonly: true });
			const statement = database.query(query);
			const rows = (params ? statement.all(...(params as never[])) : statement.all()) as Record<string, unknown>[];

			const truncatedRows = rows.slice(0, limit);
			const serialized = truncatedRows.map((row) => {
				const out: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(row)) out[key] = serializeValue(value);
				return out;
			});

			const payload = {
				rows: serialized,
				rowCount: serialized.length,
				...(rows.length > limit
					? { truncated: true, totalRows: rows.length, note: `Showing first ${limit} of ${rows.length} rows — raise \`limit\` or narrow the query.` }
					: {}),
			};

			const json = JSON.stringify(payload);
			if (json.length > MAX_OUTPUT_CHARS) {
				return JSON.stringify({
					rows: serialized.slice(0, Math.max(1, Math.floor(serialized.length / 4))),
					rowCount: serialized.length,
					truncated: true,
					note: `Result exceeded ${MAX_OUTPUT_CHARS} characters. Showing a partial set — select fewer columns, add a WHERE clause, or lower \`limit\`.`,
				});
			}
			return json;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return JSON.stringify({ error: `SQLite query failed: ${message}`, path, query });
		} finally {
			try {
				database?.close();
			} catch {
				/* already closed / never opened */
			}
		}
	},
});

export const dataTools: Record<string, ToolRegistryEntry> = {
	query_sqlite: { tool: querySqliteTool, category: "data" },
};
