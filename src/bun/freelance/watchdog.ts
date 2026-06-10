// ---------------------------------------------------------------------------
// Auto-Earn — bun-side watchdog
//
// The full-auto engine (sync + send loop) lives in an always-mounted React
// component — if the renderer crashes or the loop silently dies, autonomy stops
// with no signal. This watchdog runs in the BUN process on a timer, so it
// survives anything short of the app itself dying. Every tick it:
//   • recovers outbox rows stranded in 'sending' (crash mid-type)
//   • runs the stuck-queue check (logged out / misconfigured active hours)
//   • verifies the frontend engine heartbeat when full-auto is on, and
//     escalates if the engine hasn't ticked in too long
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { settings } from "../db/schema";
import { isAutoEarnFeatureAvailable } from "./feature-flag";
import { getAutoEarnSettings } from "./auto-earn-settings";

const CHECK_MS = 10 * 60_000;
// The engine ticks every 1–2 min; 30 min of silence means it is not running.
const HEARTBEAT_STALE_MS = 30 * 60_000;
const DOWN_COOLDOWN_MS = 6 * 3_600_000;
const DOWN_KEY = "freelance_engine_down_escalated_at";

let timer: ReturnType<typeof setInterval> | null = null;

export function startAutoEarnWatchdog(): void {
	if (timer) return;
	timer = setInterval(() => {
		tick().catch((err) => console.error("[freelance/watchdog]", err));
	}, CHECK_MS);
}

export function stopAutoEarnWatchdog(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

function isFullAutoAccount(autonomyDefault: string): boolean {
	const acct = (
		sqlite.prepare(`SELECT autonomy_mode FROM freelance_accounts WHERE platform = 'freelancer'`).get() as
			| { autonomy_mode: string | null }
			| undefined
	)?.autonomy_mode;
	return acct === "full_auto" || (acct == null && autonomyDefault === "full_auto");
}

async function tick(): Promise<void> {
	if (!isAutoEarnFeatureAvailable()) return;
	const ae = await getAutoEarnSettings();
	if (!ae.enabled) return;

	const outbox = await import("../rpc/freelance-outbox");
	await outbox.recoverInterruptedSends();
	await outbox.checkStuckQueue();

	// Engine-down detection only matters in full-auto (in assisted mode the user
	// drives sends; nothing autonomous is silently failing).
	if (!ae.fullautoAck || !isFullAutoAccount(ae.autonomyMode)) return;

	const heartbeat = await outbox.getEngineHeartbeatMs();
	if (heartbeat === 0) return; // engine never ran yet (fresh enable / app just started)
	if (Date.now() - heartbeat < HEARTBEAT_STALE_MS) return;

	// Cooldown so one outage produces one alert, not one every 10 minutes.
	const last = (await db.select().from(settings).where(eq(settings.key, DOWN_KEY)).limit(1))[0];
	if (last?.value) {
		try {
			const t = Date.parse(JSON.parse(last.value) as string);
			if (Number.isFinite(t) && Date.now() - t < DOWN_COOLDOWN_MS) return;
		} catch {
			/* re-escalate */
		}
	}
	const now = new Date().toISOString();
	await db
		.insert(settings)
		.values({ id: crypto.randomUUID(), key: DOWN_KEY, value: JSON.stringify(now), category: "freelance", updatedAt: now })
		.onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(now), updatedAt: now } });

	const { escalateToHuman } = await import("./expert/notify");
	const mins = Math.round((Date.now() - heartbeat) / 60_000);
	await escalateToHuman({
		platform: "freelancer",
		reason: "Auto-Earn engine is not running",
		detail:
			`Full-auto is enabled but the background engine hasn't ticked in ${mins} minutes. ` +
			`Nothing is being sent. Keep the app window open (the engine runs inside it), or restart the app.`,
		severity: "blocker",
	});
}
