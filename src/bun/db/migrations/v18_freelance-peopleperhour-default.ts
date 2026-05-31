import { sqlite } from "../connection";

export const name = "freelance-peopleperhour-default";

const PPH_SOURCE = { name: "PeoplePerHour", url: "https://www.peopleperhour.com/feed/jobs", enabled: true };

export function run(): void {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'freelance_rss_sources' LIMIT 1")
    .get() as { value: string } | undefined;

  if (!row) {
    // No saved setting yet — the in-code default (which already includes PPH) will apply
    return;
  }

  let sources: Array<{ name: string; url: string; enabled: boolean }>;
  try {
    sources = JSON.parse(row.value);
    if (!Array.isArray(sources)) return;
  } catch {
    return;
  }

  const alreadyPresent = sources.some((s) => s.url === PPH_SOURCE.url);
  if (alreadyPresent) return;

  sources.push(PPH_SOURCE);

  sqlite
    .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'freelance_rss_sources'")
    .run(JSON.stringify(sources), new Date().toISOString());
}
