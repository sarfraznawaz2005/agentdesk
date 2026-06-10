import { sqlite } from "../connection";

export const name = "freelance-profile-skills";

// Caches the logged-in user's Freelancer profile skills ("jobs") so the shortlist
// engine can pre-filter projects the user cannot bid on (Freelancer blocks bidding
// unless the profile shares at least one skill with the project). PRAGMA-guarded
// ADD COLUMN — idempotent.
export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(freelance_accounts)").all() as Array<{ name: string }>;
	if (cols.length === 0) return; // table not created yet; schema bootstrap will add the columns
	if (!cols.some((c) => c.name === "profile_skills")) {
		sqlite.exec("ALTER TABLE freelance_accounts ADD COLUMN profile_skills TEXT");
	}
	if (!cols.some((c) => c.name === "profile_skills_updated_at")) {
		sqlite.exec("ALTER TABLE freelance_accounts ADD COLUMN profile_skills_updated_at TEXT");
	}
}
