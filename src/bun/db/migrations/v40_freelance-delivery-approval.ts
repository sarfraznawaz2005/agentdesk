import { sqlite } from "../connection";

export const name = "freelance-delivery-approval";

// Per-job human delivery gate: the freelance-expert may not hand finished work to
// a client until the user approves. PRAGMA-guarded ADD COLUMN — idempotent.
export function run(): void {
	const cols = sqlite.prepare("PRAGMA table_info(freelance_jobs)").all() as Array<{ name: string }>;
	if (cols.length === 0) return; // table not created yet (v38 will); nothing to do
	if (!cols.some((c) => c.name === "delivery_approved")) {
		sqlite.exec("ALTER TABLE freelance_jobs ADD COLUMN delivery_approved INTEGER NOT NULL DEFAULT 0");
	}
}
