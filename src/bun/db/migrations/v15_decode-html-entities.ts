import he from "he";
import { sqlite } from "../connection";

export const name = "decode-html-entities";

export function run(): void {
  const rows = sqlite.prepare("SELECT id, title, description, skills FROM freelance_listings").all() as Array<{
    id: string;
    title: string;
    description: string;
    skills: string;
  }>;

  const update = sqlite.prepare(
    "UPDATE freelance_listings SET title = ?, description = ?, skills = ? WHERE id = ?",
  );

  const updateMany = sqlite.transaction(() => {
    for (const row of rows) {
      const decodedSkills = (() => {
        try {
          const parsed = JSON.parse(row.skills) as unknown[];
          return JSON.stringify(parsed.map((s) => (typeof s === "string" ? he.decode(s) : s)));
        } catch {
          return row.skills;
        }
      })();
      update.run(he.decode(row.title), he.decode(row.description), decodedSkills, row.id);
    }
  });

  updateMany();
}
