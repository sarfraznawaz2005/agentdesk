import { sqlite } from "../connection";

export const name = "agents-default-thinking-medium";

// Thinking is now on by default for every agent: the per-agent thinking budget
// defaults to "medium" instead of null ("Default"/off). Bring EXISTING installs
// in line so their agents (built-in AND custom) start thinking at medium too —
// but only where the user never made an explicit choice (thinking_budget IS
// NULL). Any agent a user deliberately set to low/medium/high is left untouched.
//
// New agents (seed + createAgent) get "medium" from the schema column default at
// insert time, so this backfill only concerns rows that already exist.
// Idempotent: a second run finds no NULLs left to update.
export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "thinking_budget")) return; // column not created yet

	sqlite.prepare("UPDATE agents SET thinking_budget = 'medium' WHERE thinking_budget IS NULL").run();
}
