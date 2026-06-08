import { sqlite } from "../connection";

export const name = "freelance-remove-peopleperhour";

// PeoplePerHour was removed as a built-in RSS source. Strip it from existing
// users' saved freelance_rss_sources so it stops being fetched. Already-fetched
// PPH listings are left untouched (they age out via the normal trim/purge) to
// avoid deleting anything the user may have approved/shortlisted. Idempotent.
export function run(): void {
	const row = sqlite
		.prepare(`SELECT value FROM settings WHERE key = 'freelance_rss_sources'`)
		.get() as { value: string } | undefined;
	if (!row?.value) return;

	let arr: unknown;
	try {
		arr = JSON.parse(row.value);
	} catch {
		return;
	}
	if (!Array.isArray(arr)) return;

	const filtered = arr.filter((s) => {
		const o = s as { name?: unknown; url?: unknown };
		const name = String(o?.name ?? "").toLowerCase();
		const url = String(o?.url ?? "").toLowerCase();
		return !name.includes("peopleperhour") && !url.includes("peopleperhour");
	});

	if (filtered.length !== arr.length) {
		sqlite
			.prepare(`UPDATE settings SET value = ?, updated_at = ? WHERE key = 'freelance_rss_sources'`)
			.run(JSON.stringify(filtered), new Date().toISOString());
	}
}
