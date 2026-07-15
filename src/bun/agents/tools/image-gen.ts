import { tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { aiProviders, modelCapabilitiesCache } from "../../db/schema";
import { createProviderAdapter } from "../../providers";
import { getModelTypesHandler } from "../../rpc/providers";
import { hostnameOf } from "../../providers/image-generation";
import { imageToolModelOutput } from "./screenshot";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// Resolve which configured provider/model to use for image generation.
//
// "Image-capable" (model_capabilities_cache has model_type='image') and
// "can actually generate an image right now" are different questions — a
// model can be correctly classified as image-capable while its provider
// adapter has no generateImage() implementation (e.g. Anthropic), or while
// the account behind it has no balance/entitlement. This only answers the
// first question; adapter.generateImage() surfaces the second as a normal
// failed tool result (see below).
// ---------------------------------------------------------------------------

/**
 * Image models/tools confirmed empirically (scripts/test-image-generation.ts)
 * to actually produce images, but which can NEVER be discovered through the
 * classification-cache mechanism above — NVIDIA's flux.1-dev NIM isn't
 * returned by nvidia's own /v1/models chat catalog at all, and Mistral's
 * image generation is a tool on an Agent, not a selectable model. Matched by
 * base-URL hostname fragment; listed first so they're preferred over
 * anything (unverified) the classification cache might also find.
 */
const DOCUMENTED_IMAGE_MODELS: Array<{ hostFragment: string; modelId: string }> = [
	{ hostFragment: "nvidia.com", modelId: "black-forest-labs/flux.1-dev" },
	{ hostFragment: "mistral.ai", modelId: "flux1.1-pro-ultra (via agent tool)" },
];

interface ResolvedImageModel {
	generateImage: (modelId: string, prompt: string) => Promise<{ base64: string; mimeType: string }>;
	providerName: string;
	modelId: string;
}

async function findEligibleImageModel(): Promise<ResolvedImageModel | { error: string }> {
	const providerRows = await db.select().from(aiProviders);
	if (providerRows.length === 0) {
		return { error: "No AI provider is configured. Add one in Settings → AI." };
	}

	// Fast path: read the classification cache directly (populated lazily by
	// the Settings → AI → Models tab — see model-classification.ts).
	let imageModelsByProvider = new Map<string, string[]>();
	const cachedImageRows = await db
		.select({ providerId: modelCapabilitiesCache.providerId, modelId: modelCapabilitiesCache.modelId })
		.from(modelCapabilitiesCache)
		.where(eq(modelCapabilitiesCache.modelType, "image"));
	for (const row of cachedImageRows) {
		const list = imageModelsByProvider.get(row.providerId) ?? [];
		list.push(row.modelId);
		imageModelsByProvider.set(row.providerId, list);
	}

	// Cache is empty (first run ever, or brand-new providers) — populate it via
	// the same classification path Settings → AI → Models uses, then re-derive.
	if (imageModelsByProvider.size === 0) {
		const types = await getModelTypesHandler();
		imageModelsByProvider = new Map();
		for (const [providerId, models] of Object.entries(types)) {
			const imageIds = Object.entries(models)
				.filter(([, t]) => t === "image")
				.map(([id]) => id);
			if (imageIds.length > 0) imageModelsByProvider.set(providerId, imageIds);
		}
	}

	// Merge in the documented overrides above — undiscoverable via /models,
	// so they must be added regardless of what the classification cache found.
	// Listed first so they're preferred over anything else for that provider.
	for (const provider of providerRows) {
		if (!provider.baseUrl) continue;
		const host = hostnameOf(provider.baseUrl);
		const documented = DOCUMENTED_IMAGE_MODELS.filter((d) => host.includes(d.hostFragment)).map((d) => d.modelId);
		if (documented.length === 0) continue;
		imageModelsByProvider.set(provider.id, [...documented, ...(imageModelsByProvider.get(provider.id) ?? [])]);
	}

	if (imageModelsByProvider.size === 0) {
		return { error: "No image-generation model was found among your configured AI providers." };
	}

	// Prefer the user's default provider if it has an eligible model, else the
	// first provider (in DB order) that does.
	const ordered = [...providerRows].sort((a, b) => (b.isDefault ?? 0) - (a.isDefault ?? 0));
	for (const provider of ordered) {
		const modelIds = imageModelsByProvider.get(provider.id);
		if (!modelIds?.length) continue;
		const adapter = createProviderAdapter({
			id: provider.id,
			name: provider.name,
			providerType: provider.providerType,
			apiKey: provider.apiKey,
			baseUrl: provider.baseUrl,
			defaultModel: provider.defaultModel,
		});
		if (typeof adapter.generateImage !== "function") continue;
		return { generateImage: adapter.generateImage.bind(adapter), providerName: provider.name, modelId: modelIds[0] };
	}

	return {
		error:
			"Found image-capable models, but none of their providers support image generation yet " +
			"(only OpenAI-compatible-shaped providers do today: OpenAI, custom OpenAI-compatible, OpenRouter, Ollama, OpenCode, Z.AI).",
	};
}

// ---------------------------------------------------------------------------
// generate_image tool
// ---------------------------------------------------------------------------

const generateImageInputSchema = z.object({
	prompt: z.string().min(1).describe("What to generate, e.g. 'a cute cat, simple illustration'"),
});
const generateImageTool = tool({
	description:
		"Generate an image from a text prompt and show it inline in the chat. " +
		"Automatically picks an image-capable model from your configured AI providers — " +
		"no need to specify a provider or model. Fails gracefully with a readable error " +
		"(e.g. insufficient balance, not entitled) if the provider can't generate the image right now.",
	inputSchema: generateImageInputSchema,
	execute: async ({ prompt }: { prompt: string }): Promise<string> => {
		const resolved = await findEligibleImageModel();
		if ("error" in resolved) {
			return JSON.stringify({ success: false, error: resolved.error });
		}
		const { generateImage, providerName, modelId } = resolved;
		try {
			const image = await generateImage(modelId, prompt);
			return JSON.stringify({
				success: true,
				provider: providerName,
				model: modelId,
				prompt,
				image: { type: "image", mimeType: image.mimeType, base64: image.base64 },
			});
		} catch (err) {
			return JSON.stringify({
				success: false,
				provider: providerName,
				model: modelId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},
	toModelOutput: ({ output }: { output: string }) => imageToolModelOutput(output),
});

export const imageGenTools: Record<string, ToolRegistryEntry> = {
	generate_image: { tool: generateImageTool, category: "file" },
};
