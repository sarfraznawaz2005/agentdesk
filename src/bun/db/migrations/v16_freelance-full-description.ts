import { sqlite } from "../connection";

export const name = "freelance-full-description";

export function run(): void {
  sqlite.exec("ALTER TABLE freelance_listings ADD COLUMN full_description TEXT");
}
