import { sqlite } from "../connection";

export const name = "freelance-wizard-analysis";

export function run(): void {
  sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN wizard_reason TEXT");
  sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN wizard_blockers TEXT");
  sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN wizard_analysis_text TEXT");
}
