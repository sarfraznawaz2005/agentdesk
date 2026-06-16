import { sqlite } from "../connection";

export const name = "freelance-client-country";

// Adds `client_country` to freelance_listings so the client quality gate can
// block listings by the client's country. Nullable (fail-open): if the page
// fetch can't extract country data the listing is not blocked.
export function run() {
  const cols = (sqlite.prepare("PRAGMA table_info(freelance_listings)").all() as Array<{ name: string }>)
    .map((c) => c.name);

  if (!cols.includes("client_country"))
    sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN client_country TEXT");
}
