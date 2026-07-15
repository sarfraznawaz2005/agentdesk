// ---------------------------------------------------------------------------
// Auto-Earn — reply drafting pipeline
//
// Drafts a reply to a client thread using an experienced-freelancer system
// prompt + the conversation context, and enqueues it to freelance_outbox as a
// `draft`. The actual SEND (typing into the real composer) happens in the
// frontend webview via the write-step script — never a direct API call.
// ---------------------------------------------------------------------------

import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { aiProviders } from "../db/schema";
import { createProviderAdapter } from "../providers";
import { internalCallModelId } from "../providers/claude-subscription";
import { getFreelanceSettings } from "./settings";
import { getHumanizerRules } from "./humanizer-prompt";
import { qaRevise } from "./qa";
import { DRAFT_SIMILARITY_MAX, maxSimilarityAgainst, recentOutboxBodies } from "./similarity";

function buildStrategistSystem(): string {
	return `You are an experienced freelancer replying to a client on a freelancing platform.
Write a concise, professional reply to the client's latest message — usually 2 to 6 sentences. Address the client's actual question; if a key detail is missing, ask one specific clarifying question. Do not over-promise on timeline or price unless the context provides them. Output ONLY the reply text — no preamble, no quotes, no signature block.

${getHumanizerRules()}`;
}

async function resolveProviderAndModel(): Promise<{ adapter: ReturnType<typeof createProviderAdapter>; modelId: string; providerType: string }> {
	// Prefer the freelance analysis provider if set, else the default provider.
	const fl = await getFreelanceSettings();
	let row = fl.analysisProviderId
		? (await db.select().from(aiProviders).where(eq(aiProviders.id, fl.analysisProviderId)).limit(1))[0]
		: undefined;
	if (!row) {
		row = (await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1))[0];
	}
	if (!row) throw new Error("No AI provider configured");
	const adapter = createProviderAdapter({
		id: row.id,
		name: row.name,
		providerType: row.providerType,
		apiKey: row.apiKey,
		baseUrl: row.baseUrl ?? null,
		defaultModel: row.defaultModel ?? null,
	});
	return { adapter, modelId: row.defaultModel ?? "gpt-4o-mini", providerType: row.providerType };
}

interface ThreadCtx {
	id: string;
	clientName: string | null;
	title: string | null;
	listingId: string | null;
	selfUserId: string | null;
}

function loadThreadContext(platform: string, threadId: string): ThreadCtx | null {
	const t = sqlite
		.prepare(
			`SELECT t.id, t.title, t.listing_id, u.display_name AS client_name,
			        (SELECT self_user_id FROM freelance_accounts WHERE platform = ?) AS self_user_id
			 FROM freelance_inbox_threads t
			 LEFT JOIN freelance_inbox_users u ON u.id = t.client_user_id
			 WHERE t.id = ?`,
		)
		.get(platform, threadId) as
		| { id: string; title: string | null; listing_id: string | null; client_name: string | null; self_user_id: string | null }
		| undefined;
	if (!t) return null;
	return { id: t.id, clientName: t.client_name, title: t.title, listingId: t.listing_id, selfUserId: t.self_user_id };
}

function buildConversationText(threadId: string, selfUserId: string | null): string {
	const rows = sqlite
		.prepare(
			`SELECT m.from_user, m.body, u.display_name AS from_name
			 FROM freelance_inbox_messages m
			 LEFT JOIN freelance_inbox_users u ON u.id = m.from_user
			 WHERE m.thread_id = ?
			 ORDER BY m.sent_at ASC
			 LIMIT 30`,
		)
		.all(threadId) as Array<{ from_user: string | null; body: string; from_name: string | null }>;
	return rows
		.map((r) => {
			const who = selfUserId && r.from_user === selfUserId ? "Me" : r.from_name || "Client";
			return `${who}: ${r.body}`;
		})
		.join("\n");
}

function listingBrief(listingId: string | null): string {
	if (!listingId) return "";
	const l = sqlite
		.prepare(`SELECT title, description FROM freelance_listings WHERE id = ?`)
		.get(listingId) as { title: string; description: string } | undefined;
	if (!l) return "";
	return `\n\nJob context:\nTitle: ${l.title}\n${String(l.description ?? "").slice(0, 1200)}`;
}

export interface OutboxItem {
	id: string;
	platform: string;
	kind: string;
	threadId: string | null;
	listingId: string | null;
	draftBody: string;
	status: string;
	autonomyMode: string;
	createdAt: string;
}

function getAccountAutonomy(platform: string): string {
	const row = sqlite
		.prepare(`SELECT autonomy_mode FROM freelance_accounts WHERE platform = ?`)
		.get(platform) as { autonomy_mode: string } | undefined;
	return row?.autonomy_mode ?? "assisted";
}

/** Generate a reply draft for a thread and enqueue it to the outbox. */
export async function draftReplyForThread(platform: string, threadId: string): Promise<OutboxItem> {
	const ctx = loadThreadContext(platform, threadId);
	if (!ctx) throw new Error("Thread not found");

	const conversation = buildConversationText(threadId, ctx.selfUserId);
	const prompt = `Conversation so far (most recent last):\n${conversation || "(no messages captured yet)"}${listingBrief(ctx.listingId)}\n\nWrite my reply to the client's latest message.`;

	const { adapter, modelId, providerType } = await resolveProviderAndModel();
	const { text } = await generateText({
		model: adapter.createModel(internalCallModelId(providerType, modelId)),
		instructions: buildStrategistSystem(),
		prompt,
		temperature: 0.7,
	});
	let draftBody = await qaRevise(adapter, modelId, "reply", text.trim(), providerType);

	// Template-variation guard (draft time): near-identical messages are a top
	// spam signal. If this draft reads like a recent one, regenerate once with an
	// explicit variation instruction and keep whichever is less similar.
	const priors = recentOutboxBodies(platform, "reply");
	const sim = maxSimilarityAgainst(draftBody, priors);
	if (sim > DRAFT_SIMILARITY_MAX) {
		try {
			const { text: retry } = await generateText({
				model: adapter.createModel(internalCallModelId(providerType, modelId)),
				instructions: buildStrategistSystem(),
				prompt: `${prompt}\n\nIMPORTANT: Your reply must clearly differ in structure and wording from your recent messages — vary the opening, sentence order, and phrasing.`,
				temperature: 0.9,
			});
			const retryBody = await qaRevise(adapter, modelId, "reply", retry.trim(), providerType);
			if (maxSimilarityAgainst(retryBody, priors) < sim) draftBody = retryBody;
		} catch {
			/* keep the original draft — the send-time gate is the backstop */
		}
	}

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const autonomyMode = getAccountAutonomy(platform);
	sqlite
		.prepare(
			`INSERT INTO freelance_outbox (id, platform, kind, thread_id, listing_id, draft_body, status, autonomy_mode, created_at, updated_at)
			 VALUES (?, ?, 'reply', ?, ?, ?, 'draft', ?, ?, ?)`,
		)
		.run(id, platform, threadId, ctx.listingId, draftBody, autonomyMode, now, now);

	return {
		id, platform, kind: "reply", threadId, listingId: ctx.listingId,
		draftBody, status: "draft", autonomyMode, createdAt: now,
	};
}
