import { sqlite } from "../connection";

export const name = "perf-indexes";

/**
 * Add missing performance indexes:
 * - messages(conversation_id, created_at DESC) — summarizer and engine both
 *   query messages ordered DESC; the existing ASC index cannot serve these
 *   queries without a full reverse scan.
 */
export function run(): void {
	sqlite.exec(
		`CREATE INDEX IF NOT EXISTS idx_messages_conv_date_desc
		 ON messages(conversation_id, created_at DESC)`,
	);
}
