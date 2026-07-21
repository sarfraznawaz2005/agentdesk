import { sqlite } from "../connection";

export const name = "general-chat-message-metadata";

/**
 * Adds `metadata` to general_chat_messages — mirrors project chat's
 * `messages.metadata` (JSON-encoded, currently just `{modelId}`), so an
 * assistant reply can record which model produced it and MessageBubble-style
 * per-message actions (delete/fork/retry) have a place to read that from.
 * Guarded so it's safe to re-run.
 */
export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(general_chat_messages)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "metadata")) {
		sqlite.exec("ALTER TABLE general_chat_messages ADD COLUMN metadata TEXT");
	}
}
