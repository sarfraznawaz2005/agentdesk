// ---------------------------------------------------------------------------
// One-time, idempotent migration of legacy plaintext secrets → encrypted at rest.
// ---------------------------------------------------------------------------
// Earlier builds stored per-project GitHub tokens and issue-tracker configs as
// plaintext in the `settings` table. This pass encrypts any that aren't already
// encrypted. Safe to run on every startup: rows already in enc:v1: form are
// skipped, and the readers tolerate both forms during the transition.
// ---------------------------------------------------------------------------

import { db } from "../db";
import { settings } from "../db/schema";
import { like, eq } from "drizzle-orm";
import { isEncrypted, encryptSecret } from "./secret-crypto";

export async function encryptExistingSecrets(): Promise<void> {
	try {
		const rows = [
			// Per-project custom GitHub tokens: project:<id>:githubToken
			...(await db.select().from(settings).where(like(settings.key, "project:%:githubToken"))),
			// Issue-tracker source configs (Jira/Linear/GitLab/Trello/Kanboard): issueSource:<id>:<source>
			...(await db.select().from(settings).where(like(settings.key, "issueSource:%"))),
		];

		let migrated = 0;
		for (const row of rows) {
			if (row.value && !isEncrypted(row.value)) {
				await db
					.update(settings)
					.set({ value: encryptSecret(row.value) })
					.where(eq(settings.key, row.key));
				migrated++;
			}
		}
		if (migrated > 0) {
			console.log(`[secrets] Encrypted ${migrated} legacy plaintext secret(s) at rest.`);
		}
	} catch (err) {
		// Best-effort: never block startup. Readers still tolerate plaintext.
		console.error("[secrets] Failed to encrypt existing secrets:", err);
	}
}
