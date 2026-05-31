/**
 * Settings export/import RPC handlers.
 *
 * Exports / imports the full app configuration bundle:
 *   - All settings rows (general, user, notifications, mcp, git, …)
 *   - All AI providers (including API keys — stored locally, user's responsibility)
 *   - All channel configs (Discord, Email, WhatsApp config, NOT WhatsApp session keys)
 *   - Global notification preferences
 */
import { sqlite } from "../db/connection";
import { logAudit } from "../db/audit";

const SETTINGS_EXPORT_VERSION = 2;

export interface SettingsBundle {
	version: number;
	exportedAt: string;
	type: "agentdesk-settings";
	settings: Array<{ key: string; value: string; category: string }>;
	aiProviders: Array<{
		name: string;
		providerType: string;
		apiKey: string;
		baseUrl: string | null;
		defaultModel: string | null;
		isDefault: boolean;
	}>;
	channels: Array<{
		platform: string;
		config: string;
		enabled: boolean;
	}>;
	notificationPreferences: Array<{
		platform: string;
		soundEnabled: boolean;
		badgeEnabled: boolean;
		bannerEnabled: boolean;
		muteUntil: string | null;
	}>;
	// v2 additions
	cronJobs?: Array<{
		name: string;
		cronExpression: string;
		timezone: string;
		taskType: string;
		taskConfig: string;
		enabled: boolean;
		oneShot: boolean;
	}>;
	prompts?: Array<{
		name: string;
		description: string;
		content: string;
		category: string;
	}>;
	customAgents?: Array<{
		name: string;
		displayName: string;
		color: string;
		systemPrompt: string;
		modelId: string | null;
		temperature: string | null;
		maxTokens: number | null;
		isEnabled: boolean;
		thinkingBudget: string | null;
		tools: Array<{ toolName: string; isEnabled: boolean }>;
	}>;
}

export function exportSettings(): { data: string } {
	// Exclude:
	//   - project-specific settings (tied to project UUIDs, not portable)
	//   - internal system markers (keys starting with '_')
	//   - derived/computed status keys that become stale on a new machine
	const EXCLUDED_KEYS = ["github_status"];
	const settings = sqlite.prepare(
		`SELECT key, value, category FROM settings
		 WHERE category != 'project'
		   AND key NOT LIKE '\\_%' ESCAPE '\\'
		   AND key NOT IN (${EXCLUDED_KEYS.map(() => "?").join(",")})`
	).all(...EXCLUDED_KEYS) as Array<{
		key: string; value: string; category: string;
	}>;

	const providers = sqlite.prepare(
		"SELECT name, provider_type, api_key, base_url, default_model, is_default FROM ai_providers ORDER BY is_default DESC, name ASC"
	).all() as Array<{
		name: string; provider_type: string; api_key: string;
		base_url: string | null; default_model: string | null; is_default: number;
	}>;

	// Export channel configs but NOT whatsapp_sessions (device-specific pairing data)
	const channels = sqlite.prepare(
		"SELECT platform, config, enabled FROM channels ORDER BY platform ASC"
	).all() as Array<{ platform: string; config: string; enabled: number }>;

	// Export only global notification prefs (project_id IS NULL)
	const notifPrefs = sqlite.prepare(
		"SELECT platform, sound_enabled, badge_enabled, banner_enabled, mute_until FROM notification_preferences WHERE project_id IS NULL"
	).all() as Array<{
		platform: string; sound_enabled: number; badge_enabled: number;
		banner_enabled: number; mute_until: string | null;
	}>;

	// Global cron jobs (no projectId — project-specific jobs aren't portable)
	const cronJobRows = sqlite.prepare(
		"SELECT name, cron_expression, timezone, task_type, task_config, enabled, one_shot FROM cron_jobs WHERE project_id IS NULL ORDER BY name ASC"
	).all() as Array<{
		name: string; cron_expression: string; timezone: string; task_type: string;
		task_config: string; enabled: number; one_shot: number;
	}>;

	// Custom prompts only (built-ins are re-seeded on every launch)
	const promptRows = sqlite.prepare(
		"SELECT name, description, content, category FROM prompts WHERE category != 'builtin' ORDER BY name ASC"
	).all() as Array<{ name: string; description: string; content: string; category: string }>;

	// User-created agents (isBuiltin = 0) + their tool assignments
	const customAgentRows = sqlite.prepare(
		"SELECT id, name, display_name, color, system_prompt, model_id, temperature, max_tokens, is_enabled, thinking_budget FROM agents WHERE is_builtin = 0 ORDER BY name ASC"
	).all() as Array<{
		id: string; name: string; display_name: string; color: string; system_prompt: string;
		model_id: string | null; temperature: string | null; max_tokens: number | null;
		is_enabled: number; thinking_budget: string | null;
	}>;

	const customAgents = customAgentRows.map((a) => {
		const toolRows = sqlite.prepare(
			"SELECT tool_name, is_enabled FROM agent_tools WHERE agent_id = ?"
		).all(a.id) as Array<{ tool_name: string; is_enabled: number }>;
		return {
			name: a.name,
			displayName: a.display_name,
			color: a.color,
			systemPrompt: a.system_prompt,
			modelId: a.model_id ?? null,
			temperature: a.temperature ?? null,
			maxTokens: a.max_tokens ?? null,
			isEnabled: a.is_enabled === 1,
			thinkingBudget: a.thinking_budget ?? null,
			tools: toolRows.map((t) => ({ toolName: t.tool_name, isEnabled: t.is_enabled === 1 })),
		};
	});

	const bundle: SettingsBundle = {
		version: SETTINGS_EXPORT_VERSION,
		exportedAt: new Date().toISOString(),
		type: "agentdesk-settings",
		settings,
		aiProviders: providers.map((p) => ({
			name: p.name,
			providerType: p.provider_type,
			apiKey: p.api_key,
			baseUrl: p.base_url ?? null,
			defaultModel: p.default_model ?? null,
			isDefault: p.is_default === 1,
		})),
		channels: channels.map((c) => ({
			platform: c.platform,
			config: c.config,
			enabled: c.enabled === 1,
		})),
		notificationPreferences: notifPrefs.map((n) => ({
			platform: n.platform,
			soundEnabled: n.sound_enabled === 1,
			badgeEnabled: n.badge_enabled === 1,
			bannerEnabled: n.banner_enabled === 1,
			muteUntil: n.mute_until ?? null,
		})),
		cronJobs: cronJobRows.map((j) => ({
			name: j.name,
			cronExpression: j.cron_expression,
			timezone: j.timezone,
			taskType: j.task_type,
			taskConfig: j.task_config,
			enabled: j.enabled === 1,
			oneShot: j.one_shot === 1,
		})),
		prompts: promptRows,
		customAgents,
	};

	logAudit({ action: "settings.export", entityType: "settings", entityId: "all", details: {} });

	return { data: JSON.stringify(bundle, null, 2) };
}

export function importSettings(data: string): { success: boolean; error?: string } {
	let bundle: SettingsBundle;
	try {
		bundle = JSON.parse(data);
	} catch {
		return { success: false, error: "Invalid JSON file." };
	}

	if (bundle.type !== "agentdesk-settings") {
		return { success: false, error: "Not a valid AgentDesk settings export file." };
	}
	if (bundle.version !== 1 && bundle.version !== SETTINGS_EXPORT_VERSION) {
		return { success: false, error: `Unsupported version: ${bundle.version}` };
	}

	const tx = sqlite.transaction(() => {
		// Settings: upsert each row, skipping project-specific and internal keys
		// (guards against older exports that may have included them)
		const upsertSetting = sqlite.prepare(
			"INSERT INTO settings (id, key, value, category, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = excluded.category, updated_at = CURRENT_TIMESTAMP"
		);
		const SKIP_KEYS = new Set(["github_status"]);
		for (const row of bundle.settings ?? []) {
			if (row.category === "project" || row.key.startsWith("_") || SKIP_KEYS.has(row.key)) continue;
			upsertSetting.run(row.key, row.value, row.category ?? "general");
		}

		// AI providers: full replace only when the bundle contains providers.
		// If the bundle has none (e.g. exported before any provider was configured),
		// leave existing providers untouched so we don't strand the user on onboarding.
		if (bundle.aiProviders?.length) {
			sqlite.prepare("DELETE FROM ai_providers").run();
			const insertProvider = sqlite.prepare(
				"INSERT INTO ai_providers (id, name, provider_type, api_key, base_url, default_model, is_default, is_valid, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
			);
			for (const p of bundle.aiProviders) {
				insertProvider.run(p.name, p.providerType, p.apiKey, p.baseUrl ?? null, p.defaultModel ?? null, p.isDefault ? 1 : 0);
			}
		}

		// Channels: full replace only when the bundle contains channel configs.
		if (bundle.channels?.length) {
			sqlite.prepare("DELETE FROM channels").run();
			const insertChannel = sqlite.prepare(
				"INSERT INTO channels (id, platform, config, enabled, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
			);
			for (const c of bundle.channels) {
				insertChannel.run(c.platform, c.config, c.enabled ? 1 : 0);
			}
		}

		// Notification preferences (global only): full replace
		sqlite.prepare("DELETE FROM notification_preferences WHERE project_id IS NULL").run();
		const insertPref = sqlite.prepare(
			"INSERT INTO notification_preferences (id, platform, project_id, sound_enabled, badge_enabled, banner_enabled, mute_until, created_at) VALUES (lower(hex(randomblob(16))), ?, NULL, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
		);
		for (const n of bundle.notificationPreferences ?? []) {
			insertPref.run(n.platform, n.soundEnabled ? 1 : 0, n.badgeEnabled ? 1 : 0, n.bannerEnabled ? 1 : 0, n.muteUntil ?? null);
		}

		// Cron jobs: insert new, update existing (matched by name), global jobs only
		const findCronJob = sqlite.prepare("SELECT id FROM cron_jobs WHERE name = ? AND project_id IS NULL LIMIT 1");
		const insertCronJob = sqlite.prepare(
			"INSERT INTO cron_jobs (id, name, cron_expression, timezone, task_type, task_config, enabled, one_shot, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
		);
		const updateCronJob = sqlite.prepare(
			"UPDATE cron_jobs SET cron_expression = ?, timezone = ?, task_type = ?, task_config = ?, enabled = ?, one_shot = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
		);
		for (const j of bundle.cronJobs ?? []) {
			const existing = findCronJob.get(j.name) as { id: string } | undefined;
			if (existing) {
				updateCronJob.run(j.cronExpression, j.timezone, j.taskType, j.taskConfig, j.enabled ? 1 : 0, j.oneShot ? 1 : 0, existing.id);
			} else {
				insertCronJob.run(j.name, j.cronExpression, j.timezone, j.taskType, j.taskConfig, j.enabled ? 1 : 0, j.oneShot ? 1 : 0);
			}
		}

		// Prompts: insert new, update existing (matched by name), skip built-ins
		const findPrompt = sqlite.prepare("SELECT id FROM prompts WHERE name = ? LIMIT 1");
		const insertPrompt = sqlite.prepare(
			"INSERT INTO prompts (id, name, description, content, category, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
		);
		const updatePrompt = sqlite.prepare(
			"UPDATE prompts SET description = ?, content = ?, category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND category != 'builtin'"
		);
		for (const p of bundle.prompts ?? []) {
			if (p.category === "builtin") continue;
			const existing = findPrompt.get(p.name) as { id: string } | undefined;
			if (existing) {
				updatePrompt.run(p.description ?? "", p.content, p.category ?? "custom", existing.id);
			} else {
				insertPrompt.run(p.name, p.description ?? "", p.content, p.category ?? "custom");
			}
		}

		// Custom agents: insert new, update existing (matched by name), never touch built-ins
		const findCustomAgent = sqlite.prepare("SELECT id FROM agents WHERE name = ? AND is_builtin = 0 LIMIT 1");
		const insertAgent = sqlite.prepare(
			"INSERT INTO agents (id, name, display_name, color, system_prompt, is_builtin, model_id, temperature, max_tokens, is_enabled, thinking_budget, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
		);
		const updateAgent = sqlite.prepare(
			"UPDATE agents SET display_name = ?, color = ?, system_prompt = ?, model_id = ?, temperature = ?, max_tokens = ?, is_enabled = ?, thinking_budget = ? WHERE id = ?"
		);
		const deleteAgentTools = sqlite.prepare("DELETE FROM agent_tools WHERE agent_id = ?");
		const insertAgentTool = sqlite.prepare(
			"INSERT INTO agent_tools (id, agent_id, tool_name, is_enabled) VALUES (lower(hex(randomblob(16))), ?, ?, ?)"
		);
		for (const a of bundle.customAgents ?? []) {
			let agentId: string;
			const existing = findCustomAgent.get(a.name) as { id: string } | undefined;
			if (existing) {
				updateAgent.run(a.displayName, a.color, a.systemPrompt, a.modelId ?? null, a.temperature ?? null, a.maxTokens ?? null, a.isEnabled ? 1 : 0, a.thinkingBudget ?? null, existing.id);
				agentId = existing.id;
			} else {
				const newId = crypto.randomUUID();
				insertAgent.run(a.name, a.displayName, a.color, a.systemPrompt, a.modelId ?? null, a.temperature ?? null, a.maxTokens ?? null, a.isEnabled ? 1 : 0, a.thinkingBudget ?? null);
				// Fetch the just-inserted id
				const inserted = findCustomAgent.get(a.name) as { id: string } | undefined;
				agentId = inserted?.id ?? newId;
			}
			// Restore tool assignments
			if (a.tools?.length) {
				deleteAgentTools.run(agentId);
				for (const t of a.tools) {
					insertAgentTool.run(agentId, t.toolName, t.isEnabled ? 1 : 0);
				}
			}
		}
	});

	tx();

	logAudit({ action: "settings.import", entityType: "settings", entityId: "all", details: {} });

	return { success: true };
}
