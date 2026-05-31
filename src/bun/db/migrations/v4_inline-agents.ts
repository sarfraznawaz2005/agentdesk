import { sqlite } from "../connection";

export const name = "inline-agents";

export function run(): void {
	// 1. Create message_parts table for decomposed message content
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS message_parts (
			id          TEXT PRIMARY KEY NOT NULL,
			message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
			type        TEXT NOT NULL,
			content     TEXT NOT NULL DEFAULT '',
			tool_name   TEXT,
			tool_input  TEXT,
			tool_output TEXT,
			tool_state  TEXT DEFAULT 'pending',
			sort_order  INTEGER NOT NULL DEFAULT 0,
			time_start  TEXT,
			time_end    TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	sqlite.exec(
		"CREATE INDEX IF NOT EXISTS idx_message_parts_message_id ON message_parts(message_id)",
	);

	// 2. Add has_parts flag to messages for quick queries
	const msgCols = sqlite.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
	if (!msgCols.some((c) => c.name === "has_parts")) {
		sqlite.exec("ALTER TABLE messages ADD COLUMN has_parts INTEGER NOT NULL DEFAULT 0");
	}

	// 3. Add agent_name to messages (sub-agent identity for inline rendering)
	if (!msgCols.some((c) => c.name === "agent_name")) {
		sqlite.exec("ALTER TABLE messages ADD COLUMN agent_name TEXT");
	}

	// 4. Drop obsolete agent session / task result tables (FK order: children first)
	sqlite.exec("DROP TABLE IF EXISTS agent_session_messages");
	sqlite.exec("DROP TABLE IF EXISTS agent_sessions");
	sqlite.exec("DROP TABLE IF EXISTS agent_task_results");
}
