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
	bidDailyCap: number;            // hard daily budget for bids (0 = no daily cap)
	minGapSeconds: number;
	fullautoAck: boolean;           // user accepted full-auto risk
	notifyDesktop: boolean;         // desktop notification on a new client reply
	notifyChannels: boolean;        // forward new client reply to connected channels
	bidDeliveryDays: number;        // default "delivered in" days prefilled on a bid
	bidStaleHours: number;          // auto-dismiss awaiting_review bids older than this (0 = never)
	autoBidShortlisted: boolean;    // auto-draft a proposal when a listing is auto-shortlisted (off by default)
	bidPricingMode: string;         // "avg" | "min" | "max" | "percentile"
	bidPercentile: number;          // 0-100 position in the budget range (mode = percentile)
	bidMinClamp: number;            // absolute floor for the bid amount (0 = none)
	bidMaxClamp: number;            // absolute ceiling for the bid amount (0 = none)
	bidHourlyRate: number;          // rate to bid on hourly projects (0 = use the budget)
}

const DEFAULTS: AutoEarnSettings = {
	enabled: false,
	autonomyMode: "assisted",
	pollMin: 180,
	pollMax: 480,
	activeHours: { start: 9, end: 22 },
	maxSendsPerHour: 4, // reply cap; bids get half hourly + the daily budget (must match governor DEFAULTS)
	bidDailyCap: 10,
	minGapSeconds: 90,
	fullautoAck: false,
	notifyDesktop: true,
	notifyChannels: false,
	bidDeliveryDays: 7,
	bidStaleHours: 24,
	autoBidShortlisted: false,
	bidPricingMode: "avg",
	bidPercentile: 50,
	bidMinClamp: 0,
	bidMaxClamp: 0,
	bidHourlyRate: 0,
};

const KEYS: Record<keyof AutoEarnSettings, string> = {
	enabled: "freelance_autoearn_enabled",
	autonomyMode: "freelance_autonomy_mode",
	pollMin: "freelance_inbox_poll_min",
	pollMax: "freelance_inbox_poll_max",
	activeHours: "freelance_active_hours",
	maxSendsPerHour: "freelance_max_sends_per_hour",
	bidDailyCap: "freelance_bid_daily_cap",
	minGapSeconds: "freelance_min_gap_seconds",
	fullautoAck: "freelance_fullauto_ack",
	notifyDesktop: "freelance_notify_desktop",
	notifyChannels: "freelance_notify_channels",
	bidDeliveryDays: "freelance_bid_delivery_days",
	bidStaleHours: "freelance_bid_stale_hours",
	autoBidShortlisted: "freelance_auto_bid_shortlisted",
	bidPricingMode: "freelance_bid_pricing_mode",
	bidPercentile: "freelance_bid_percentile",
	bidMinClamp: "freelance_bid_min_clamp",
	bidMaxClamp: "freelance_bid_max_clamp",
	bidHourlyRate: "freelance_bid_hourly_rate",
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
		bidDailyCap: get("bidDailyCap"),
		minGapSeconds: get("minGapSeconds"),
		fullautoAck: get("fullautoAck"),
		notifyDesktop: get("notifyDesktop"),
		notifyChannels: get("notifyChannels"),
		bidDeliveryDays: get("bidDeliveryDays"),
		bidStaleHours: get("bidStaleHours"),
		autoBidShortlisted: get("autoBidShortlisted"),
		bidPricingMode: get("bidPricingMode"),
		bidPercentile: get("bidPercentile"),
		bidMinClamp: get("bidMinClamp"),
		bidMaxClamp: get("bidMaxClamp"),
		bidHourlyRate: get("bidHourlyRate"),
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
		saveAutoEarnSetting("bidDailyCap", safe.bidDailyCap),
		saveAutoEarnSetting("minGapSeconds", safe.minGapSeconds),
		saveAutoEarnSetting("fullautoAck", safe.fullautoAck),
		saveAutoEarnSetting("notifyDesktop", safe.notifyDesktop),
		saveAutoEarnSetting("notifyChannels", safe.notifyChannels),
		saveAutoEarnSetting("bidDeliveryDays", safe.bidDeliveryDays),
		saveAutoEarnSetting("bidStaleHours", safe.bidStaleHours),
		saveAutoEarnSetting("autoBidShortlisted", safe.autoBidShortlisted),
		saveAutoEarnSetting("bidPricingMode", safe.bidPricingMode),
		saveAutoEarnSetting("bidPercentile", safe.bidPercentile),
		saveAutoEarnSetting("bidMinClamp", safe.bidMinClamp),
		saveAutoEarnSetting("bidMaxClamp", safe.bidMaxClamp),
		saveAutoEarnSetting("bidHourlyRate", safe.bidHourlyRate),
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
