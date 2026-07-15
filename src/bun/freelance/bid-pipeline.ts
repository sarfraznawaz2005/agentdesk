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
import { internalCallModelId } from "../providers/claude-subscription";
import { ensureFullDescription } from "./description";
import { getFreelanceSettings } from "./settings";
import { getAutoEarnSettings } from "./auto-earn-settings";
import { getHumanizerRules } from "./humanizer-prompt";
import { qaRevise } from "./qa";
import { DRAFT_SIMILARITY_MAX, maxSimilarityAgainst, recentOutboxBodies } from "./similarity";
import type { BidQuestionDto, BidRequirementsDto, BidAnswerDto } from "../../shared/rpc/freelance";
import type { OutboxItem } from "./reply-pipeline";

function buildProposalSystem(): string {
	return `You are an experienced freelancer writing a winning proposal (bid) for a job post.
Open by showing you understood the specific job — reference a concrete detail. State briefly how you would approach it and why you are a fit, specifically. Keep it tight: 4 to 8 sentences. End with one clarifying question or a clear next step. Output ONLY the proposal text.

${getHumanizerRules()}`;
}

async function resolveProviderAndModel(): Promise<{ adapter: ReturnType<typeof createProviderAdapter>; modelId: string; providerType: string }> {
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
	return { adapter, modelId: row.defaultModel ?? "gpt-4o-mini", providerType: row.providerType };
}

function getAccountAutonomy(platform: string): string {
	const row = sqlite
		.prepare(`SELECT autonomy_mode FROM freelance_accounts WHERE platform = ?`)
		.get(platform) as { autonomy_mode: string } | undefined;
	return row?.autonomy_mode ?? "assisted";
}

/**
 * Analyse a listing's application requirements.
 * Returns structured questions the client explicitly asks for, classified as
 * AI-answerable (pricing, timeframe, tech choices) or human-only (portfolio
 * examples, personal past work).
 */
export async function analyzeListingRequirements(_platform: string, listingId: string): Promise<BidRequirementsDto> {
	const listing = (await db.select().from(freelanceListings).where(eq(freelanceListings.id, listingId)).limit(1))[0];
	if (!listing) throw new Error("Listing not found");

	const { adapter, modelId, providerType } = await resolveProviderAndModel();
	const fullDescription = await ensureFullDescription(listing, adapter, modelId, undefined, providerType);
	const description = String(fullDescription || listing.description || "").slice(0, 8000);

	const aeSettings = await getAutoEarnSettings();
	const pricingContext = aeSettings.bidPricingMode === "hourly"
		? `Hourly rate: $${aeSettings.bidHourlyRate}/hr`
		: aeSettings.bidPricingMode === "fixed"
			? `Fixed price range: $${aeSettings.bidMinClamp}–$${aeSettings.bidMaxClamp}`
			: `Budget-percentile bidding (${Math.round((aeSettings.bidPercentile ?? 0.5) * 100)}th percentile), clamp $${aeSettings.bidMinClamp}–$${aeSettings.bidMaxClamp}`;
	const deliveryContext = `Default delivery estimate: ${aeSettings.bidDeliveryDays ?? 7} days`;

	const analysisPrompt = `Analyze this freelance job listing and identify any explicit application requirements.

Freelancer context you can use to answer questions:
- ${pricingContext}
- ${deliveryContext}
- General software development expertise

Job listing:
Title: ${listing.title}
${description}

Instructions:
1. Look for sections like "When Applying", "Please Provide", "Requirements for Applicants", "To Apply" etc.
2. For each item found, decide: can you answer it from the freelancer context above, or does it require personal info only the human can provide?
3. YOU CAN answer: preferred tech stack/tools, timeframe estimates, price quotes, general methodology.
4. YOU CANNOT answer: portfolio examples with links, specific past project URLs, personal testimonials, account history.
5. If the listing has NO specific application requirements section, return hasRequirements=false.

Respond ONLY with valid JSON in this exact shape:
{
  "hasRequirements": true,
  "questions": [
    { "id": "q1", "question": "Examples of similar websites you have built", "canAiAnswer": false, "aiAnswer": null },
    { "id": "q2", "question": "Preferred theme/page builder", "canAiAnswer": true, "aiAnswer": "GeneratePress + Elementor — lightweight and allows easy row duplication for non-technical users." }
  ]
}`;

	let parsed: BidRequirementsDto = { hasRequirements: false, questions: [] };
	try {
		const { text } = await generateText({
			model: adapter.createModel(internalCallModelId(providerType, modelId)),
			prompt: analysisPrompt,
			temperature: 0,
		});
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const raw = JSON.parse(jsonMatch[0]) as { hasRequirements?: boolean; questions?: BidQuestionDto[] };
			parsed = {
				hasRequirements: !!raw.hasRequirements,
				questions: Array.isArray(raw.questions) ? raw.questions : [],
			};
		}
	} catch {
		// Analysis failed — fall back to no requirements (direct draft path)
	}
	return parsed;
}

/** Generate a proposal draft for a listing and enqueue it to the outbox. */
export async function draftBidForListing(platform: string, listingId: string, humanAnswers?: BidAnswerDto[]): Promise<OutboxItem> {
	const listing = (await db.select().from(freelanceListings).where(eq(freelanceListings.id, listingId)).limit(1))[0];
	if (!listing) throw new Error("Listing not found");

	const skills = (() => {
		try {
			return (JSON.parse(listing.skills) as string[]).join(", ");
		} catch {
			return "";
		}
	})();

	const { adapter, modelId, providerType } = await resolveProviderAndModel();

	// Make sure the proposal is written from the full listing page description,
	// not the truncated RSS snippet — fetch + cache it if the chat hasn't already.
	const fullDescription = await ensureFullDescription(listing, adapter, modelId, undefined, providerType);
	const description = String(fullDescription || listing.description || "").slice(0, 8000);
	const answersBlock = humanAnswers?.length
		? `\nThe client specifically requested the following information in the application — include ALL of these in the proposal:\n${humanAnswers.map((a) => `- ${a.question}: ${a.answer}`).join("\n")}\n`
		: "";
	const prompt = `Job post:\nTitle: ${listing.title}\nSkills: ${skills}\n\n${description}${answersBlock}\n\nWrite my proposal for this job.`;
	const { text } = await generateText({
		model: adapter.createModel(internalCallModelId(providerType, modelId)),
		instructions: buildProposalSystem(),
		prompt,
		temperature: 0.75,
	});
	let draftBody = await qaRevise(adapter, modelId, "proposal", text.trim(), providerType);

	// Template-variation guard (draft time): identical-skeleton proposals across
	// many projects are THE classic bid-spam signal. Regenerate once if this one
	// reads like a recent bid; keep whichever is less similar.
	const priors = recentOutboxBodies(platform, "bid");
	const sim = maxSimilarityAgainst(draftBody, priors);
	if (sim > DRAFT_SIMILARITY_MAX) {
		try {
			const { text: retry } = await generateText({
				model: adapter.createModel(internalCallModelId(providerType, modelId)),
				instructions: buildProposalSystem(),
				prompt: `${prompt}\n\nIMPORTANT: This proposal must clearly differ in structure and wording from your recent proposals — different opening, different ordering, different phrasing. Anchor it in the specifics of THIS job.`,
				temperature: 0.9,
			});
			const retryBody = await qaRevise(adapter, modelId, "proposal", retry.trim(), providerType);
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
