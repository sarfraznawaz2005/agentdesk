// ---------------------------------------------------------------------------
// Auto-Earn — inbox RPC handlers (read-only v1)
//
// The session webview intercepts the platform's own messaging JSON and forwards
// it here via `ingest`. We normalize + store, then the UI reads normalized
// threads/messages back. No data is ever requested by Bun directly — every
// network call stays inside the genuine browser session.
// ---------------------------------------------------------------------------

import { Session } from "electrobun/bun";
import { sqlite } from "../db/connection";
import { broadcastToWebview } from "../engine-manager";
import { FREELANCE_EVENTS } from "../freelance/events";
import { ingestCaptures } from "../freelance/session/ingest";
import { recordAction } from "../freelance/session/governor";
import { getAutoEarnSettings, saveAutoEarnSettings } from "../freelance/auto-earn-settings";
import { isAutoEarnFeatureAvailable } from "../freelance/feature-flag";
import { sendDesktopNotification } from "../notifications/desktop";
import type { NewInboundMessage } from "../freelance/session/ingest";
import type { FreelanceAutoEarnSettingsDto } from "../../shared/rpc/freelance";
import { getPlatform } from "../../shared/freelance/platforms";
import type {
	FreelanceAccountDto,
	FreelanceInboxThreadDto,
	FreelanceInboxMessageDto,
} from "../../shared/rpc/freelance";

const DEFAULT_PLATFORM = "freelancer";

function partitionFor(platform: string): string {
	return `persist:freelance-${platform}`;
}

/** True if we have a live session (auth cookie OR a captured self id). */
export function isConnectedPlatform(platform: string): boolean {
	if (hasAuthCookie(platform)) return true;
	const row = sqlite
		.prepare(`SELECT self_user_id FROM freelance_accounts WHERE platform = ?`)
		.get(platform) as { self_user_id: string | null } | undefined;
	return !!row?.self_user_id;
}

// Cookie-based logged-in detection: an auth-ish cookie on the platform domain
// means a live session. We never read cookie *values* — only presence of names.
function hasAuthCookie(platform: string): boolean {
	try {
		const domain = getPlatform(platform).cookieDomain;
		const session = Session.fromPartition(partitionFor(platform));
		const cookies = (session.cookies.get({ domain }) ?? []) as Array<{ name?: string }>;
		return cookies.some((c) => /auth|sess|token|login|hash|gaf|uid/i.test(String(c.name ?? "")));
	} catch {
		return false;
	}
}

// ─── ingest ───────────────────────────────────────────────────────────────────
export async function ingest(params: {
	platform?: string;
	records: Array<{ url: string; body: string }>;
}): Promise<{ threads: number; messages: number; users: number }> {
	const platform = params.platform ?? DEFAULT_PLATFORM;
	const records = Array.isArray(params.records) ? params.records : [];
	if (records.length === 0) return { threads: 0, messages: 0, users: 0 };

	const result = await ingestCaptures(platform, records);
	if (result.changed) {
		broadcastToWebview(FREELANCE_EVENTS.INBOX_UPDATED, {
			threads: result.threads,
			messages: result.messages,
		});
		if (result.messages > 0) {
			broadcastToWebview(FREELANCE_EVENTS.INBOX_NEW_MESSAGE, { threadId: "", messageId: "" });
		}
	}
	// New client replies → desktop notification and/or connected channels (gated
	// by Auto-Earn settings). Fire-and-forget so it never blocks the ingest.
	if (result.newInbound.length > 0) {
		void notifyNewInbound(result.newInbound);
		// In full-auto, hand each affected thread to the freelance-expert agent (it
		// decides: reply, accept/create-project, gather access, deliver, or escalate).
		// The orchestrator self-gates on full-auto+ack and dedupes per job.
		const threadsSeen = new Set<string>();
		for (const m of result.newInbound) {
			if (threadsSeen.has(m.threadId)) continue;
			threadsSeen.add(m.threadId);
			void (async () => {
				try {
					const { runFreelanceExpert } = await import("../freelance/expert/orchestrator");
					await runFreelanceExpert({ platform, threadId: m.threadId, trigger: "new_message" });
				} catch (err) {
					console.error("[freelance-expert] trigger failed:", err);
				}
			})();
		}
	}
	return { threads: result.threads, messages: result.messages, users: result.users };
}

function clientNameForThread(threadId: string, fromUser: string | null): string {
	if (fromUser) {
		const u = sqlite
			.prepare(`SELECT display_name FROM freelance_inbox_users WHERE id = ?`)
			.get(fromUser) as { display_name: string | null } | undefined;
		if (u?.display_name) return u.display_name;
	}
	const t = sqlite
		.prepare(`SELECT title FROM freelance_inbox_threads WHERE id = ?`)
		.get(threadId) as { title: string | null } | undefined;
	return t?.title || "a client";
}

async function notifyNewInbound(items: NewInboundMessage[]): Promise<void> {
	let settings;
	try {
		settings = await getAutoEarnSettings();
	} catch {
		return;
	}
	if (!settings.notifyDesktop && !settings.notifyChannels) return;

	// One notification per thread (latest wins), capped to avoid a burst.
	const byThread = new Map<string, NewInboundMessage>();
	for (const m of items) byThread.set(m.threadId, m);
	const picked = [...byThread.values()].slice(0, 5);

	for (const m of picked) {
		const name = clientNameForThread(m.threadId, m.fromUser);
		const snippet = (m.body || "").replace(/\s+/g, " ").trim().slice(0, 160) || "(no preview)";
		const title = `New message from ${name}`;
		if (settings.notifyDesktop) {
			try {
				await sendDesktopNotification(title, snippet);
			} catch {
				/* notification unavailable */
			}
		}
		if (settings.notifyChannels) {
			try {
				const { broadcastSchedulerResult } = await import("../channels/manager");
				await broadcastSchedulerResult("Freelance message", `💬 ${title}\n${snippet}`);
			} catch (err) {
				console.log("[freelance] channel notify failed:", err instanceof Error ? err.message : "");
			}
		}
	}
}

// ─── getAccount ─────────────────────────────────────────────────────────────
export async function getAccount(params: { platform?: string }): Promise<FreelanceAccountDto> {
	const platform = params.platform ?? DEFAULT_PLATFORM;
	const row = sqlite
		.prepare(
			`SELECT self_user_id, display_name, status, last_sync_at, autonomy_mode FROM freelance_accounts WHERE platform = ?`,
		)
		.get(platform) as
		| { self_user_id: string | null; display_name: string | null; status: string; last_sync_at: string | null; autonomy_mode: string | null }
		| undefined;

	// Real connection signal: an auth cookie in the partition OR a captured self id.
	const connected = hasAuthCookie(platform) || !!row?.self_user_id;

	// Reflect the live signal back into the DB + notify the UI on change.
	const desiredStatus = connected ? "connected" : "logged_out";
	if (row && row.status !== desiredStatus) {
		sqlite
			.prepare(`UPDATE freelance_accounts SET status = ?, updated_at = ? WHERE platform = ?`)
			.run(desiredStatus, new Date().toISOString(), platform);
		broadcastToWebview(FREELANCE_EVENTS.ACCOUNT_STATUS_CHANGED, { platform, status: desiredStatus });
	}

	return {
		connected,
		platform,
		displayName: row?.display_name ?? null,
		selfUserId: row?.self_user_id ?? null,
		lastSyncAt: row?.last_sync_at ?? null,
		autonomyMode: (row?.autonomy_mode as "assisted" | "full_auto") ?? "assisted",
	};
}

// ─── disconnect ─────────────────────────────────────────────────────────────
// Clears the partition session (cookies/storage) so the next use requires a
// fresh login. Credentials were never stored by us — only the platform cookies.
export async function disconnect(params: { platform?: string }): Promise<{ success: boolean }> {
	const platform = params.platform ?? DEFAULT_PLATFORM;
	try {
		Session.fromPartition(partitionFor(platform)).clearStorageData();
	} catch (err) {
		console.error("[freelance/account] clearStorageData failed:", err);
	}
	sqlite
		.prepare(`UPDATE freelance_accounts SET status = 'logged_out', self_user_id = NULL, updated_at = ? WHERE platform = ?`)
		.run(new Date().toISOString(), platform);
	recordAction(platform, "login", "ok", "disconnected");
	broadcastToWebview(FREELANCE_EVENTS.ACCOUNT_STATUS_CHANGED, { platform, status: "logged_out" });
	return { success: true };
}

// ─── logSync ──────────────────────────────────────────────────────────────────
// Records an inbox_sync action (auto or manual) for the governor's audit trail.
export async function logSync(params: { platform?: string; source?: string }): Promise<{ success: boolean }> {
	const platform = params.platform ?? DEFAULT_PLATFORM;
	recordAction(platform, "inbox_sync", "ok", params.source ?? "auto");
	return { success: true };
}

// ─── autoEarn availability (flag file) ───────────────────────────────────────
// The whole Auto-Earn feature is gated by an `autoearn` flag file next to the exe.
export async function getAutoEarnAvailable(): Promise<{ available: boolean }> {
	return { available: isAutoEarnFeatureAvailable() };
}

// ─── autoEarn settings ───────────────────────────────────────────────────────
export async function getAutoEarn(): Promise<FreelanceAutoEarnSettingsDto> {
	return getAutoEarnSettings();
}

export async function saveAutoEarn(params: FreelanceAutoEarnSettingsDto): Promise<{ success: boolean }> {
	await saveAutoEarnSettings(params);
	return { success: true };
}

// ─── setAutonomy ────────────────────────────────────────────────────────────
export async function setAutonomy(params: {
	platform?: string;
	mode: "assisted" | "full_auto";
}): Promise<{ success: boolean }> {
	const platform = params.platform ?? DEFAULT_PLATFORM;
	const mode = params.mode === "full_auto" ? "full_auto" : "assisted";
	const now = new Date().toISOString();
	sqlite
		.prepare(
			`INSERT INTO freelance_accounts (id, platform, status, autonomy_mode, last_sync_at, updated_at)
			 VALUES (?, ?, 'connected', ?, ?, ?)
			 ON CONFLICT(platform) DO UPDATE SET autonomy_mode = excluded.autonomy_mode, updated_at = excluded.updated_at`,
		)
		.run(crypto.randomUUID(), platform, mode, now, now);
	return { success: true };
}

// ─── getThreads ─────────────────────────────────────────────────────────────
export async function getThreads(params: {
	platform?: string;
	search?: string;
}): Promise<{ threads: FreelanceInboxThreadDto[] }> {
	const platform = params.platform ?? DEFAULT_PLATFORM;
	const q = params.search?.trim();

	const base = `
		SELECT t.id, t.client_user_id, t.thread_type, t.context_type, t.context_id, t.title,
		       t.listing_id, t.link_confidence,
		       t.last_message_text, t.last_message_from, t.last_message_at, t.unread, t.url,
		       u.display_name AS client_name
		FROM freelance_inbox_threads t
		LEFT JOIN freelance_inbox_users u ON u.id = t.client_user_id
		WHERE t.platform = ?`;

	let rows: Array<Record<string, unknown>>;
	if (q) {
		const like = `%${q}%`;
		rows = sqlite
			.prepare(
				`${base} AND (t.last_message_text LIKE ? OR u.display_name LIKE ? OR t.title LIKE ?)
				 ORDER BY t.last_message_at DESC`,
			)
			.all(platform, like, like, like) as Array<Record<string, unknown>>;
	} else {
		rows = sqlite
			.prepare(`${base} ORDER BY t.last_message_at DESC`)
			.all(platform) as Array<Record<string, unknown>>;
	}

	const threads: FreelanceInboxThreadDto[] = rows.map((r) => ({
		id: String(r.id),
		clientUserId: (r.client_user_id as string | null) ?? null,
		clientName: (r.client_name as string | null) ?? null,
		threadType: (r.thread_type as string | null) ?? null,
		contextType: (r.context_type as string | null) ?? null,
		contextId: (r.context_id as string | null) ?? null,
		title: (r.title as string | null) ?? null,
		listingId: (r.listing_id as string | null) ?? null,
		linkConfidence: (r.link_confidence as string | null) ?? null,
		lastMessageText: (r.last_message_text as string | null) ?? null,
		lastMessageFrom: (r.last_message_from as string | null) ?? null,
		lastMessageAt: (r.last_message_at as number | null) ?? null,
		unread: (r.unread as number | null) ?? 0,
		url: (r.url as string | null) ?? null,
	}));

	return { threads };
}

// ─── getMessages ─────────────────────────────────────────────────────────────
export async function getMessages(params: {
	threadId: string;
	platform?: string;
}): Promise<{ messages: FreelanceInboxMessageDto[] }> {
	const platform = params.platform ?? DEFAULT_PLATFORM;

	const selfRow = sqlite
		.prepare(`SELECT self_user_id FROM freelance_accounts WHERE platform = ?`)
		.get(platform) as { self_user_id: string | null } | undefined;
	const selfUserId = selfRow?.self_user_id ?? null;

	const rows = sqlite
		.prepare(
			`SELECT m.id, m.thread_id, m.from_user, m.body, m.sent_at, u.display_name AS from_name
			 FROM freelance_inbox_messages m
			 LEFT JOIN freelance_inbox_users u ON u.id = m.from_user
			 WHERE m.thread_id = ?
			 ORDER BY m.sent_at ASC`,
		)
		.all(params.threadId) as Array<Record<string, unknown>>;

	const messages: FreelanceInboxMessageDto[] = rows.map((r) => {
		const fromUser = (r.from_user as string | null) ?? null;
		return {
			id: String(r.id),
			threadId: String(r.thread_id),
			fromUser,
			fromName: (r.from_name as string | null) ?? null,
			body: (r.body as string | null) ?? "",
			sentAt: (r.sent_at as number | null) ?? null,
			outbound: selfUserId != null && fromUser === selfUserId,
		};
	});

	return { messages };
}
