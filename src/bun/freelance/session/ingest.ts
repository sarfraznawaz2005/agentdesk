// ---------------------------------------------------------------------------
// Auto-Earn — inbox ingest (DB writes)
//
// Takes a batch of raw capture records (the platform's own JSON, intercepted in
// the session webview), normalizes them, and upserts into the inbox tables.
// Pure DB side-effects; broadcasting is left to the RPC handler.
// ---------------------------------------------------------------------------

import { sqlite } from "../../db/connection";
import { classifyEndpoint, getPlatform } from "../../../shared/freelance/platforms";
import {
	parseThreads,
	parseMessages,
	parseUsers,
	parseSelf,
	parseProjects,
	type CaptureRecord,
} from "./normalizer";

export interface NewInboundMessage {
	threadId: string;
	fromUser: string | null;
	body: string;
}

export interface IngestResult {
	threads: number;
	messages: number;
	users: number;
	changed: boolean;
	/** Newly-arrived client messages (inbound, recent) — for notifications. */
	newInbound: NewInboundMessage[];
}

function threadUrl(platform: string, threadId: string): string {
	return getPlatform(platform).threadUrl(threadId);
}

function getSelfUserId(platform: string): string | null {
	const row = sqlite
		.prepare("SELECT self_user_id FROM freelance_accounts WHERE platform = ?")
		.get(platform) as { self_user_id: string | null } | undefined;
	return row?.self_user_id ?? null;
}

/**
 * Ingest a batch of intercepted capture records for a platform.
 * Returns counts and whether anything inbox-relevant changed.
 */
export function ingestCaptures(platform: string, records: CaptureRecord[]): IngestResult {
	const now = new Date().toISOString();
	let nThreads = 0;
	let nMessages = 0;
	let nUsers = 0;
	const newInbound: NewInboundMessage[] = [];

	// Ensure an account row exists + bump last_sync_at.
	sqlite
		.prepare(
			`INSERT INTO freelance_accounts (id, platform, status, last_sync_at, updated_at)
			 VALUES (?, ?, 'connected', ?, ?)
			 ON CONFLICT(platform) DO UPDATE SET status = 'connected', last_sync_at = excluded.last_sync_at, updated_at = excluded.updated_at`,
		)
		.run(crypto.randomUUID(), platform, now, now);

	const upsertUser = sqlite.prepare(
		`INSERT INTO freelance_inbox_users (id, platform, username, display_name, role, country, avatar, updated_at)
		 VALUES (?,?,?,?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET
		   username = excluded.username,
		   display_name = excluded.display_name,
		   role = excluded.role,
		   country = COALESCE(excluded.country, freelance_inbox_users.country),
		   avatar = excluded.avatar,
		   updated_at = excluded.updated_at`,
	);

	const upsertThread = sqlite.prepare(
		`INSERT INTO freelance_inbox_threads
		   (id, platform, thread_type, owner_id, member_ids, client_user_id, context_type, context_id,
		    last_message_id, last_message_text, last_message_from, last_message_at, unread, url, updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET
		   thread_type = excluded.thread_type,
		   owner_id = excluded.owner_id,
		   member_ids = excluded.member_ids,
		   client_user_id = COALESCE(excluded.client_user_id, freelance_inbox_threads.client_user_id),
		   context_type = excluded.context_type,
		   context_id = excluded.context_id,
		   last_message_id = COALESCE(excluded.last_message_id, freelance_inbox_threads.last_message_id),
		   last_message_text = COALESCE(excluded.last_message_text, freelance_inbox_threads.last_message_text),
		   last_message_from = COALESCE(excluded.last_message_from, freelance_inbox_threads.last_message_from),
		   last_message_at = COALESCE(excluded.last_message_at, freelance_inbox_threads.last_message_at),
		   unread = excluded.unread,
		   url = excluded.url,
		   updated_at = excluded.updated_at`,
	);

	const upsertMessage = sqlite.prepare(
		`INSERT INTO freelance_inbox_messages (id, thread_id, from_user, body, sent_at)
		 VALUES (?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET
		   body = excluded.body,
		   from_user = excluded.from_user,
		   sent_at = excluded.sent_at`,
	);

	const refreshThreadLast = sqlite.prepare(
		`UPDATE freelance_inbox_threads SET
		   last_message_text = (SELECT body FROM freelance_inbox_messages WHERE thread_id = ? ORDER BY sent_at DESC LIMIT 1),
		   last_message_from = (SELECT from_user FROM freelance_inbox_messages WHERE thread_id = ? ORDER BY sent_at DESC LIMIT 1),
		   last_message_at = COALESCE((SELECT sent_at FROM freelance_inbox_messages WHERE thread_id = ? ORDER BY sent_at DESC LIMIT 1), last_message_at),
		   updated_at = ?
		 WHERE id = ?`,
	);

	sqlite.exec("BEGIN");
	try {
		// Self first so the account's self_user_id is available for client resolution.
		for (const rec of records) {
			if (classifyEndpoint(platform, rec.url) !== "self") continue;
			const self = parseSelf(rec.body);
			if (self) {
				sqlite
					.prepare(
						`UPDATE freelance_accounts SET self_user_id = ?, display_name = COALESCE(?, display_name), updated_at = ? WHERE platform = ?`,
					)
					.run(self.id, self.displayName, now, platform);
			}
		}

		// Users (identity cache).
		for (const rec of records) {
			if (classifyEndpoint(platform, rec.url) !== "users") continue;
			for (const u of parseUsers(rec.body)) {
				upsertUser.run(u.id, platform, u.username, u.displayName, u.role, u.country, u.avatar, now);
				nUsers++;
			}
		}

		const selfUserId = getSelfUserId(platform);

		// Threads.
		for (const rec of records) {
			if (classifyEndpoint(platform, rec.url) !== "threads") continue;
			for (const t of parseThreads(rec.body)) {
				const clientUserId =
					selfUserId != null ? t.memberIds.find((m) => m !== selfUserId) ?? null : null;
				upsertThread.run(
					t.id,
					platform,
					t.threadType,
					t.ownerId,
					JSON.stringify(t.memberIds),
					clientUserId,
					t.contextType,
					t.contextId,
					t.lastMessageId,
					t.lastMessageText,
					t.lastMessageFrom,
					t.lastMessageAt,
					t.unread,
					threadUrl(platform, t.id),
					now,
				);
				nThreads++;
			}
		}

		// Messages. Track genuinely NEW, RECENT, INBOUND (client) messages so the
		// caller can notify — without spamming on the initial backfill of history.
		const touchedThreads = new Set<string>();
		const msgExists = sqlite.prepare(`SELECT 1 FROM freelance_inbox_messages WHERE id = ?`);
		const nowSec = Math.floor(Date.now() / 1000);
		const RECENT_WINDOW = 30 * 60; // 30 minutes
		for (const rec of records) {
			if (classifyEndpoint(platform, rec.url) !== "messages") continue;
			for (const m of parseMessages(rec.body)) {
				const existed = !!msgExists.get(m.id);
				upsertMessage.run(m.id, m.threadId, m.fromUser, m.body, m.sentAt);
				touchedThreads.add(m.threadId);
				nMessages++;
				const inbound = selfUserId != null && m.fromUser != null && m.fromUser !== selfUserId;
				const recent = m.sentAt == null || m.sentAt >= nowSec - RECENT_WINDOW;
				if (!existed && inbound && recent) {
					newInbound.push({ threadId: m.threadId, fromUser: m.fromUser, body: m.body });
				}
			}
		}
		for (const threadId of touchedThreads) {
			refreshThreadLast.run(threadId, threadId, threadId, now, threadId);
		}

		// Projects → cache titles + correlate threads to listings (section 4a cascade).
		const projectTitles = new Map<string, string | null>();
		for (const rec of records) {
			if (classifyEndpoint(platform, rec.url) !== "projects") continue;
			for (const p of parseProjects(rec.body)) projectTitles.set(p.id, p.title);
		}
		if (nThreads > 0 || projectTitles.size > 0) {
			const corrThreads = sqlite
				.prepare(
					`SELECT id, context_id FROM freelance_inbox_threads WHERE platform = ? AND context_id IS NOT NULL`,
				)
				.all(platform) as Array<{ id: string; context_id: string }>;
			const findByExternal = sqlite.prepare(
				`SELECT id, title FROM freelance_listings WHERE external_id = ? AND is_deleted = 0 LIMIT 1`,
			);
			const findByTitle = sqlite.prepare(
				`SELECT id FROM freelance_listings WHERE is_deleted = 0 AND title = ? LIMIT 1`,
			);
			const updateCorr = sqlite.prepare(
				`UPDATE freelance_inbox_threads
				 SET listing_external_id = ?, title = COALESCE(?, title), listing_id = ?, link_confidence = ?, updated_at = ?
				 WHERE id = ?`,
			);
			for (const t of corrThreads) {
				const ctxId = t.context_id;
				const byExt = findByExternal.get(ctxId) as { id: string; title: string } | undefined;
				const isProjectCtx = projectTitles.has(ctxId) || !!byExt;
				if (!isProjectCtx) continue; // e.g. support_session — not a job thread
				let title = projectTitles.get(ctxId) ?? null;
				let listingId: string | null = null;
				let confidence = "none";
				if (byExt) {
					listingId = byExt.id;
					confidence = "certain";
					if (!title) title = byExt.title;
				} else if (title) {
					const byTitle = findByTitle.get(title) as { id: string } | undefined;
					if (byTitle) {
						listingId = byTitle.id;
						confidence = "probable";
					}
				}
				updateCorr.run(ctxId, title, listingId, confidence, now, t.id);
			}
		}

		sqlite.exec("COMMIT");
	} catch (err) {
		sqlite.exec("ROLLBACK");
		throw err;
	}

	return {
		threads: nThreads,
		messages: nMessages,
		users: nUsers,
		changed: nThreads + nMessages + nUsers > 0,
		newInbound,
	};
}
