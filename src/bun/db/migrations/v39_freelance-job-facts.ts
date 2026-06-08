import { sqlite } from "../connection";

export const name = "freelance-job-facts";

// Important non-secret client/project facts the agent learns (rules, contacts,
// links, preferences, requirements) — injected into the agent's context so every
// reply is well-informed. Idempotent.
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS freelance_job_facts (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other',
  detail      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_freelance_job_facts_job
  ON freelance_job_facts(job_id, created_at);
`);
}
