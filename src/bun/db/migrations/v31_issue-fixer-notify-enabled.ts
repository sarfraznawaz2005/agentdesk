import { sqlite } from "../connection";

export const name = "issue-fixer-notify-enabled";

// Adds the notify_enabled flag to issue_fixer_config.
// Default 1 so existing users continue receiving notifications unchanged.
export function run(): void {
	sqlite.exec(`
ALTER TABLE issue_fixer_config ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 0;
`);
}
