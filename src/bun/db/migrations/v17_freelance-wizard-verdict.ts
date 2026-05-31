import { sqlite } from "../connection";

export const name = "freelance-wizard-verdict";

export function run(): void {
  sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN wizard_verdict TEXT");
  sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN wizard_analyzed_at TEXT");
}
