import { sqlite } from "../connection";

export const name = "freelance-is-deleted";

export function run(): void {
	sqlite.exec(`
ALTER TABLE freelance_listings ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_freelance_listings_is_deleted ON freelance_listings(is_deleted);
UPDATE freelance_listings SET is_deleted = 1 WHERE status = 'dismissed';
`);
}
