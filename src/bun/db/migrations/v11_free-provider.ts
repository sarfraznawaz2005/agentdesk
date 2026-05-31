import { sqlite } from "../connection";

export const name = "add-free-opencode-provider";

/**
 * Adds the OpenCode Free provider for existing users who have already onboarded.
 * Only inserts if no opencode provider exists yet, making this idempotent.
 */
export function run(): void {
	const existing = sqlite
		.prepare("SELECT id FROM ai_providers WHERE provider_type = 'opencode' LIMIT 1")
		.get();
	if (existing) return;

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	sqlite
		.prepare(
			`INSERT INTO ai_providers (id, name, provider_type, api_key, base_url, default_model, is_default, is_valid, created_at, updated_at)
       VALUES (?, 'Free', 'opencode', 'public', NULL, NULL, 0, 0, ?, ?)`,
		)
		.run(id, now, now);
}
