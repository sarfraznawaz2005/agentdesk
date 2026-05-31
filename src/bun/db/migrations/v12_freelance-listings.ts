import { sqlite } from "../connection";

export const name = "freelance-listings";

export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS freelance_listings (
  id           TEXT PRIMARY KEY,
  platform     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  skills       TEXT NOT NULL DEFAULT '[]',
  budget_type  TEXT NOT NULL DEFAULT 'fixed',
  budget_min   INTEGER,
  budget_max   INTEGER,
  currency     TEXT NOT NULL DEFAULT 'USD',
  url          TEXT NOT NULL,
  posted_at    TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  project_id   TEXT REFERENCES projects(id),
  fetched_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_freelance_listings_platform_external ON freelance_listings(platform, external_id);
CREATE INDEX IF NOT EXISTS idx_freelance_listings_status ON freelance_listings(status);
`);
}
