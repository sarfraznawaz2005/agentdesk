// ---------------------------------------------------------------------------
// Auto-Earn — Freelancer payload normalizer (PURE, no DB / no I/O)
//
// Turns the raw JSON the Freelancer SPA fetches (captured inside the embedded
// session webview) into flat, storable shapes. Endpoint map + field reference:
// see the freelancer-messaging-api notes. We deliberately whitelist only the
// fields the inbox needs — never email / device tokens / payment info.
// ---------------------------------------------------------------------------

export type { CaptureEndpoint } from "../../../shared/freelance/platforms";

export interface CaptureRecord {
	url: string;
	body: string; // raw JSON text of the response
}

export interface NormalizedThread {
	id: string;
	threadType: string | null;
	ownerId: string | null;
	memberIds: string[];
	contextType: string | null;
	contextId: string | null;
	lastMessageId: string | null;
	lastMessageText: string | null;
	lastMessageFrom: string | null;
	lastMessageAt: number | null;
	unread: number;
}

export interface NormalizedMessage {
	id: string;
	threadId: string;
	fromUser: string | null;
	body: string;
	sentAt: number | null;
}

export interface NormalizedUser {
	id: string;
	username: string | null;
	displayName: string | null;
	role: string | null;
	country: string | null;
	avatar: string | null;
}

export interface NormalizedSelf {
	id: string;
	displayName: string | null;
}

export interface NormalizedProject {
	id: string;
	title: string | null;
	seoUrl: string | null;
}

function asString(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	return String(v);
}

function toIntOrNull(v: unknown): number | null {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : null;
}

function getResult(body: string): unknown {
	try {
		const j = JSON.parse(body) as { result?: unknown };
		return j?.result ?? j;
	} catch {
		return null;
	}
}

export function parseThreads(body: string): NormalizedThread[] {
	const result = getResult(body) as { threads?: unknown } | null;
	const arr = Array.isArray(result?.threads) ? (result.threads as unknown[]) : [];
	const out: NormalizedThread[] = [];
	for (const item of arr) {
		const wrap = item as { id?: unknown; thread?: Record<string, unknown>; unread_count?: unknown };
		const t = (wrap.thread ?? wrap) as Record<string, unknown>;
		const id = asString(t.id ?? wrap.id);
		if (!id) continue;
		const ctx = (t.context ?? {}) as { type?: unknown; id?: unknown };
		const msg = (t.message ?? {}) as Record<string, unknown>;
		const members = Array.isArray(t.members) ? (t.members as unknown[]).map((m) => String(m)) : [];
		const unreadRaw = wrap.unread_count ?? t.unread_count ?? (t as { unread?: unknown }).unread ?? 0;
		out.push({
			id,
			threadType: asString(t.thread_type),
			ownerId: asString(t.owner),
			memberIds: members,
			contextType: asString(ctx.type),
			contextId: asString(ctx.id),
			lastMessageId: asString(msg.id),
			lastMessageText: typeof msg.message === "string" ? msg.message : null,
			lastMessageFrom: asString(msg.from_user),
			lastMessageAt: toIntOrNull(msg.time_created),
			unread: toIntOrNull(unreadRaw) ?? 0,
		});
	}
	return out;
}

export function parseMessages(body: string): NormalizedMessage[] {
	const result = getResult(body) as { messages?: unknown } | null;
	const arr = Array.isArray(result?.messages) ? (result.messages as unknown[]) : [];
	const out: NormalizedMessage[] = [];
	for (const item of arr) {
		const m = item as Record<string, unknown>;
		const id = asString(m.id);
		const threadId = asString(m.thread_id);
		if (!id || !threadId) continue;
		out.push({
			id,
			threadId,
			fromUser: asString(m.from_user),
			body: typeof m.message === "string" ? m.message : "",
			sentAt: toIntOrNull(m.time_created),
		});
	}
	return out;
}

export function parseUsers(body: string): NormalizedUser[] {
	const result = getResult(body) as { users?: Record<string, unknown> } | null;
	const map = result?.users;
	if (!map || typeof map !== "object") return [];
	const out: NormalizedUser[] = [];
	for (const key of Object.keys(map)) {
		const u = map[key] as Record<string, unknown>;
		const id = asString(u.id ?? key);
		if (!id) continue;
		const loc = (u.location ?? {}) as { country?: { name?: unknown } };
		out.push({
			id,
			username: asString(u.username),
			displayName: asString(u.display_name ?? u.username),
			role: asString(u.role ?? u.chosen_role),
			country: asString(loc.country?.name) || null,
			avatar: asString(u.avatar),
		});
	}
	return out;
}

export function parseSelf(body: string): NormalizedSelf | null {
	const result = getResult(body) as Record<string, unknown> | null;
	if (!result) return null;
	const id = asString(result.id);
	if (!id) return null;
	return { id, displayName: asString(result.display_name ?? result.username) };
}

export function parseProjects(body: string): NormalizedProject[] {
	const result = getResult(body) as { projects?: unknown } | null;
	const arr = Array.isArray(result?.projects) ? (result.projects as unknown[]) : [];
	const out: NormalizedProject[] = [];
	for (const item of arr) {
		const p = item as Record<string, unknown>;
		const id = asString(p.id);
		if (!id) continue;
		out.push({ id, title: asString(p.title), seoUrl: asString(p.seo_url) });
	}
	return out;
}
