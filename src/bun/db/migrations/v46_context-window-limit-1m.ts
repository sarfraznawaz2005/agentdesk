import { sqlite } from "../connection";

export const name = "context-window-limit-default-1m";

// The Context Window Limit default is now 1,000,000 (was 200k). Set EVERY existing
// project's Context Window Limit to exactly 1,000,000 so all existing users move to
// the new default — both projects that already have the setting stored and projects
// that have none yet (a row is inserted for them).
//
// Values are stored as plain numeric strings (e.g. "200000") — that's how the
// settings UI writes them and how getContextLimit() / the context meter read them —
// so we write "1000000" (no JSON quoting). The settings.key is unique; ids are 16
// random bytes (only needs to be unique).
export function run(): void {
  const now = new Date().toISOString();

  // 1) Set every project that already has the setting to exactly 1,000,000.
  sqlite
    .prepare(`UPDATE settings SET value = '1000000', updated_at = ? WHERE key LIKE 'project:%:contextWindowLimit'`)
    .run(now);

  // 2) Insert the setting (= 1,000,000) for any project that doesn't have one yet,
  //    so every existing project is explicitly covered, not just relying on the
  //    in-code default.
  sqlite
    .prepare(
      `INSERT INTO settings (id, key, value, category, created_at, updated_at)
         SELECT lower(hex(randomblob(16))),
                'project:' || p.id || ':contextWindowLimit',
                '1000000', 'project', ?, ?
           FROM projects p
          WHERE NOT EXISTS (
            SELECT 1 FROM settings s
             WHERE s.key = 'project:' || p.id || ':contextWindowLimit'
          )`,
    )
    .run(now, now);

  // 3) Keep the global fallback consistent if it exists.
  sqlite
    .prepare(`UPDATE settings SET value = '1000000', updated_at = ? WHERE key = 'contextWindowLimit'`)
    .run(now);
}
