import { sqlite } from "../connection";

export const name = "freelance-client-quality";

// Adds client quality columns to freelance_listings so the workability
// gate can filter out low-rating / brand-new clients without AI cost.
// All new columns are nullable so existing rows are unaffected.
export function run() {
  const cols = (sqlite.prepare("PRAGMA table_info(freelance_listings)").all() as Array<{ name: string }>)
    .map((c) => c.name);

  if (!cols.includes("client_rating"))
    sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN client_rating REAL");
  if (!cols.includes("client_review_count"))
    sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN client_review_count INTEGER");
  if (!cols.includes("client_member_since"))
    sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN client_member_since TEXT");
  if (!cols.includes("client_payment_verified"))
    sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN client_payment_verified INTEGER NOT NULL DEFAULT 0");
}
