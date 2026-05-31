import { sqlite } from "../connection";

export const name = "agent-sessions";

export function run(): void {
	// 1. Add files_modified column to agent_task_results
	const atrCols = sqlite.prepare("PRAGMA table_info(agent_task_results)").all() as Array<{ name: string }>;
	if (!atrCols.some((c) => c.name === "files_modified")) {
		sqlite.exec("ALTER TABLE agent_task_results ADD COLUMN files_modified TEXT");
	}

	// 2. Create agent_sessions table
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS agent_sessions (
			id              TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL REFERENCES conversations(id),
			agent_name      TEXT NOT NULL,
			total_tokens    INTEGER NOT NULL DEFAULT 0,
			created_at      TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(conversation_id, agent_name)
		)
	`);

	// 3. Create agent_session_messages table
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS agent_session_messages (
			id          TEXT PRIMARY KEY,
			session_id  TEXT NOT NULL REFERENCES agent_sessions(id),
			role        TEXT NOT NULL,
			content     TEXT NOT NULL,
			metadata    TEXT,
			token_count INTEGER NOT NULL DEFAULT 0,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);

	// 4. Index for fast session lookup by conversation + agent
	sqlite.exec(`
		CREATE INDEX IF NOT EXISTS idx_agent_sessions_conv_agent
		ON agent_sessions(conversation_id, agent_name)
	`);

	// 5. Index for fast message loading by session
	sqlite.exec(`
		CREATE INDEX IF NOT EXISTS idx_agent_session_messages_session
		ON agent_session_messages(session_id, created_at)
	`);
}
