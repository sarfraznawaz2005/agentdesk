import { sqlite } from "../connection";

export const name = "freelance-chat-messages";

export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS freelance_chat_messages (
  id          TEXT PRIMARY KEY,
  listing_id  TEXT NOT NULL REFERENCES freelance_listings(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_freelance_chat_messages_listing ON freelance_chat_messages(listing_id, created_at);
`);
}
