import { sqlite } from "../connection";

export const name = "freelance-polling-interval-minutes";

// Previous values were stored as whole hours (1–8).
// New values are stored as minutes (15, 30, 60, 120, …, 480).
// Convert by multiplying by 60.
export function run(): void {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'freelance_polling_interval' LIMIT 1")
    .get() as { value: string } | undefined;

  if (!row) return;

  const parsed = Number(JSON.parse(row.value));
  if (!Number.isFinite(parsed) || parsed > 24) return; // already in minutes or invalid

  const minutes = Math.round(parsed * 60);

  sqlite
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'freelance_polling_interval'")
    .run(JSON.stringify(minutes), new Date().toISOString());
}
