// ---------------------------------------------------------------------------
// Auto-Earn — settings (the master switch + governor knobs)
//
// Stored in the existing `settings` table under category "freelance" (same
// pattern as freelance/settings.ts). The governor reads these keys directly, so
// the key names here MUST match the ones in session/governor.ts.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../db/schema";

export interface AutoEarnSettings {
	enabled: boolean;               // master switch — gates all Auto-Earn UI + behavior
	autonomyMode: "assisted" | "full_auto"; // global default (per-account overrides)
	pollMin: number;                // inbox auto-sync jitter floor (seconds)
	pollMax: number;                // inbox auto-sync jitter ceiling (seconds)
	activeHours: { start: number; end: number };
	maxSendsPerHour: number;
	minGapSeconds: number;
	fullautoAck: boolean;           // user accepted full-auto risk
	notifyDesktop: boolean;         // desktop notification on a new client reply
	notifyChannels: boolean;        // forward new client reply to connected channels
}

const DEFAULTS: AutoEarnSettings = {
	enabled: false,
	autonomyMode: "assisted",
	pollMin: 180,
	pollMax: 480,
	activeHours: { start: 9, end: 22 },
	maxSendsPerHour: 1,
	minGapSeconds: 90,
	fullautoAck: false,
	notifyDesktop: true,
	notifyChannels: false,
};

const KEYS: Record<keyof AutoEarnSettings, string> = {
	enabled: "freelance_autoearn_enabled",
	autonomyMode: "freelance_autonomy_mode",
	pollMin: "freelance_inbox_poll_min",
	pollMax: "freelance_inbox_poll_max",
	activeHours: "freelance_active_hours",
	maxSendsPerHour: "freelance_max_sends_per_hour",
	minGapSeconds: "freelance_min_gap_seconds",
	fullautoAck: "freelance_fullauto_ack",
	notifyDesktop: "freelance_notify_desktop",
	notifyChannels: "freelance_notify_channels",
};

export async function getAutoEarnSettings(): Promise<AutoEarnSettings> {
	const rows = await db.select().from(settings).where(eq(settings.category, "freelance"));
	const map = new Map(rows.map((r) => [r.key, r.value]));
	function get<K extends keyof AutoEarnSettings>(key: K): AutoEarnSettings[K] {
		const raw = map.get(KEYS[key]);
		if (raw === undefined) return DEFAULTS[key];
		try {
			return JSON.parse(raw) as AutoEarnSettings[K];
		} catch {
			return DEFAULTS[key];
		}
	}
	return {
		enabled: get("enabled"),
		autonomyMode: get("autonomyMode"),
		pollMin: get("pollMin"),
		pollMax: get("pollMax"),
		activeHours: get("activeHours"),
		maxSendsPerHour: get("maxSendsPerHour"),
		minGapSeconds: get("minGapSeconds"),
		fullautoAck: get("fullautoAck"),
		notifyDesktop: get("notifyDesktop"),
		notifyChannels: get("notifyChannels"),
	};
}

export async function saveAutoEarnSetting<K extends keyof AutoEarnSettings>(
	key: K,
	value: AutoEarnSettings[K],
): Promise<void> {
	const dbKey = KEYS[key];
	const now = new Date().toISOString();
	await db
		.insert(settings)
		.values({ id: crypto.randomUUID(), key: dbKey, value: JSON.stringify(value), category: "freelance", updatedAt: now })
		.onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt: now } });
}

export async function saveAutoEarnSettings(input: AutoEarnSettings): Promise<void> {
	// Full-auto cannot be active without the explicit risk acknowledgment.
	const safe: AutoEarnSettings = {
		...input,
		autonomyMode: input.autonomyMode === "full_auto" && !input.fullautoAck ? "assisted" : input.autonomyMode,
	};
	await Promise.all([
		saveAutoEarnSetting("enabled", safe.enabled),
		saveAutoEarnSetting("autonomyMode", safe.autonomyMode),
		saveAutoEarnSetting("pollMin", safe.pollMin),
		saveAutoEarnSetting("pollMax", safe.pollMax),
		saveAutoEarnSetting("activeHours", safe.activeHours),
		saveAutoEarnSetting("maxSendsPerHour", safe.maxSendsPerHour),
		saveAutoEarnSetting("minGapSeconds", safe.minGapSeconds),
		saveAutoEarnSetting("fullautoAck", safe.fullautoAck),
		saveAutoEarnSetting("notifyDesktop", safe.notifyDesktop),
		saveAutoEarnSetting("notifyChannels", safe.notifyChannels),
	]);
}

/** Is the Auto-Earn feature switched on at all? Used to gate UI + background work. */
export async function isAutoEarnEnabled(): Promise<boolean> {
	const rows = await db.select().from(settings).where(eq(settings.category, "freelance"));
	const row = rows.find((r) => r.key === KEYS.enabled);
	if (!row) return DEFAULTS.enabled;
	try {
		return !!JSON.parse(row.value);
	} catch {
		return DEFAULTS.enabled;
	}
}
