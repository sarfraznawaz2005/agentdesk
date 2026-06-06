import { sqlite } from "../connection";

export const name = "custom-env-vars";

export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS custom_env_vars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
}
