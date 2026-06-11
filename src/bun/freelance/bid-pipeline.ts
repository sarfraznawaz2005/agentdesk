// ---------------------------------------------------------------------------
// Auto-Earn — bid (proposal) drafting pipeline
//
// Drafts a proposal for a shortlisted listing and enqueues it to freelance_outbox
// as a `bid` draft. Submission (filling the bid form) is governor-gated and runs
// in the frontend webview, with stricter caps than replies.
// ---------------------------------------------------------------------------

import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { aiProviders, freelanceListings } from "../db/schema";
import { createProviderAdapter } from "../providers";
import { getFreelanceSettings } from "./settings";
import { getHumanizerRules } from "./humanizer-prompt";
import { qaRevise } from "./qa";
import { DRAFT_SIMILARITY_MAX, maxSimilarityAgainst, recentOutboxBodies } from "./similarity";
import type { OutboxItem } from "./reply-pipeline";

function buildProposalSystem(): string {
	return `You are an experienced freelancer writing a winning proposal (bid) for a job post.
Open by showing you understood the specific job — reference a concrete detail. State briefly how you would approach it and why you are a fit, specifically. Keep it tight: 4 to 8 sentences. End with one clarifying question or a clear next step. Output ONLY the proposal text.

${getHumanizerRules()}`;
}

async function resolveProviderAndModel(): Promise<{ adapter: ReturnType<typeof createProviderAdapter>; modelId: string }> {
	const fl = await getFreelanceSettings();
	let row = fl.analysisProviderId
		? (await db.select().from(aiProviders).where(eq(aiProviders.id, fl.analysisProviderId)).limit(1))[0]
		: undefined;
	if (!row) row = (await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1))[0];
	if (!row) throw new Error("No AI provider configured");
	const adapter = createProviderAdapter({
		id: row.id, name: row.name, providerType: row.providerType,
		apiKey: row.apiKey, baseUrl: row.baseUrl ?? null, defaultModel: row.defaultModel ?? null,
	});
	return { adapter, modelId: row.defaultModel ?? "gpt-4o-mini" };
}

function getAccountAutonomy(platform: string): string {
	const row = sqlite
		.prepare(`SELECT autonomy_mode FROM freelance_accounts WHERE platform = ?`)
		.get(platform) as { autonomy_mode: string } | undefined;
	return row?.autonomy_mode ?? "assisted";
}

/** Generate a proposal draft for a listing and enqueue it to the outbox. */
export async function draftBidForListing(platform: string, listingId: string): Promise<OutboxItem> {
	const listing = (await db.select().from(freelanceListings).where(eq(freelanceListings.id, listingId)).limit(1))[0];
	if (!listing) throw new Error("Listing not found");

	const skills = (() => {
		try {
			return (JSON.parse(listing.skills) as string[]).join(", ");
		} catch {
			return "";
		}
	})();
	const prompt = `Job post:\nTitle: ${listing.title}\nSkills: ${skills}\n\n${String(listing.fullDescription || listing.description || "").slice(0, 2000)}\n\nWrite my proposal for this job.`;

	const { adapter, modelId } = await resolveProviderAndModel();
	const { text } = await generateText({
		model: adapter.createModel(modelId),
		system: buildProposalSystem(),
		prompt,
		temperature: 0.75,
	});
	let draftBody = await qaRevise(adapter, modelId, "proposal", text.trim());

	// Template-variation guard (draft time): identical-skeleton proposals across
	// many projects are THE classic bid-spam signal. Regenerate once if this one
	// reads like a recent bid; keep whichever is less similar.
	const priors = recentOutboxBodies(platform, "bid");
	const sim = maxSimilarityAgainst(draftBody, priors);
	if (sim > DRAFT_SIMILARITY_MAX) {
		try {
			const { text: retry } = await generateText({
				model: adapter.createModel(modelId),
				system: buildProposalSystem(),
				prompt: `${prompt}\n\nIMPORTANT: This proposal must clearly differ in structure and wording from your recent proposals — different opening, different ordering, different phrasing. Anchor it in the specifics of THIS job.`,
				temperature: 0.9,
			});
			const retryBody = await qaRevise(adapter, modelId, "proposal", retry.trim());
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
			 VALUES (?, ?, 'bid', NULL, ?, ?, 'draft', ?, ?, ?)`,
		)
		.run(id, platform, listingId, draftBody, autonomyMode, now, now);

	return {
		id, platform, kind: "bid", threadId: null, listingId,
		draftBody, status: "draft", autonomyMode, createdAt: now,
	};
}
