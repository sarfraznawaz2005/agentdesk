import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateImage, APICallError } from "ai";
import { PROVIDER_HEADERS } from "./headers";

/**
 * Generate an image via the standard OpenAI-compatible `images/generations`
 * contract (`.imageModel()` from @ai-sdk/openai-compatible + `generateImage()`
 * from "ai"). Shared by every adapter built on that contract (openai, custom,
 * openrouter, ollama, opencode, zai) so a user-added custom OpenAI-compatible
 * provider gets image generation for free, without any provider-specific code.
 */
export async function generateImageOpenAICompatible(
	baseURL: string,
	apiKey: string,
	modelId: string,
	prompt: string,
): Promise<{ base64: string; mimeType: string }> {
	const provider = createOpenAICompatible({
		name: "image-gen",
		apiKey,
		baseURL,
		headers: PROVIDER_HEADERS,
	});
	try {
		const result = await generateImage({
			model: provider.imageModel(modelId),
			prompt,
			abortSignal: AbortSignal.timeout(120_000),
		});
		return { base64: result.image.base64, mimeType: result.image.mediaType };
	} catch (err) {
		throw new Error(describeImageGenError(err), { cause: err });
	}
}

/**
 * Turn a thrown image-generation error into a short, human-readable message.
 * Insufficient balance / not-entitled / rate-limit are the common case for
 * image models (not the exception), so these must read as an actionable
 * sentence, not a raw stack trace.
 */
export function describeImageGenError(err: unknown): string {
	if (APICallError.isInstance(err)) {
		const status = err.statusCode;
		if (status === 401) return "Invalid API key.";
		if (status === 402) return "Insufficient account balance for image generation.";
		if (status === 404) return "Model not found or not entitled for image generation (HTTP 404).";
		if (status === 429) return "Rate limited by the provider. Try again in a moment.";
		return `Provider returned HTTP ${status ?? "error"}: ${err.message}`;
	}
	if (err instanceof Error) {
		if (err.name === "TimeoutError" || /timeout/i.test(err.message)) return "Request timed out.";
		return err.message;
	}
	return String(err);
}

/** Same status-code messaging as describeImageGenError(), for raw fetch() calls (no APICallError involved). */
function describeHttpError(status: number, bodyText: string): string {
	if (status === 401) return "Invalid API key.";
	if (status === 402) return "Insufficient account balance for image generation.";
	if (status === 404) return "Model not found or not entitled for image generation (HTTP 404).";
	if (status === 429) return "Rate limited by the provider. Try again in a moment.";
	return `Provider returned HTTP ${status}: ${bodyText.slice(0, 300)}`;
}

// ---------------------------------------------------------------------------
// NVIDIA NIM hosted genai endpoint — a genuinely different host/shape than
// NVIDIA's chat completions endpoint (integrate.api.nvidia.com). Ported from
// the empirically-verified scripts/test-image-generation.ts
// (tryNvidiaGenai) — confirmed live for black-forest-labs/flux.1-dev.
// These NIM image models never appear in nvidia's own /v1/models chat
// listing, so they can't be discovered through the classification-cache
// mechanism at all — see the DOCUMENTED_IMAGE_MODELS override in
// agents/tools/image-gen.ts.
// ---------------------------------------------------------------------------
export async function generateImageNvidia(
	apiKey: string,
	modelPath: string,
	prompt: string,
): Promise<{ base64: string; mimeType: string }> {
	const url = `https://ai.api.nvidia.com/v1/genai/${modelPath}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			prompt,
			height: 1024,
			width: 1024,
			samples: 1,
			seed: 0,
			steps: 30,
			cfg_scale: 5,
			mode: "base",
			image: null,
		}),
		signal: AbortSignal.timeout(90_000),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(describeHttpError(res.status, text));
	let json: { image?: string; artifacts?: Array<{ base64?: string }>; data?: Array<{ b64_json?: string }> };
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error("Provider returned a non-JSON response.");
	}
	const base64 = json.image ?? json.artifacts?.[0]?.base64 ?? json.data?.[0]?.b64_json;
	if (!base64) throw new Error("Provider returned 200 OK but no recognizable image field.");
	return { base64, mimeType: "image/png" };
}

// ---------------------------------------------------------------------------
// Mistral — no single-call image endpoint exists. Generation only happens via
// their beta Agents/Conversations flow: create a temporary agent with the
// image_generation tool, start a conversation, poll for a tool_file chunk,
// then download it. Ported from the empirically-verified
// scripts/test-image-generation.ts (tryMistralImageTool) — confirmed live,
// backed by FLUX1.1 [pro] Ultra. Mistral has no selectable "model id" for
// this at all (it's a tool on an agent, not a model) — the modelId param is
// unused; see the synthetic MISTRAL_IMAGE_MODEL_ID marker in image-gen.ts.
// ---------------------------------------------------------------------------
export async function generateImageMistral(
	apiKey: string,
	prompt: string,
): Promise<{ base64: string; mimeType: string }> {
	const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

	const agentRes = await fetch("https://api.mistral.ai/v1/agents", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: "mistral-medium-latest",
			name: "AgentDesk image generator",
			description: "Generates images on request.",
			instructions: "Use the image generation tool when asked to create an image.",
			tools: [{ type: "image_generation" }],
		}),
		signal: AbortSignal.timeout(30_000),
	});
	const agentText = await agentRes.text();
	if (!agentRes.ok) throw new Error(describeHttpError(agentRes.status, agentText));
	const agent = JSON.parse(agentText) as { id: string };

	const convRes = await fetch("https://api.mistral.ai/v1/conversations", {
		method: "POST",
		headers,
		body: JSON.stringify({ agent_id: agent.id, inputs: prompt }),
		signal: AbortSignal.timeout(90_000),
	});
	const convText = await convRes.text();
	if (!convRes.ok) throw new Error(describeHttpError(convRes.status, convText));
	const conv = JSON.parse(convText) as { outputs?: Array<{ content?: Array<{ type: string; file_id?: string }> }> };

	let fileId: string | undefined;
	for (const o of conv.outputs ?? []) {
		for (const c of o.content ?? []) {
			if (c.type === "tool_file" && c.file_id) fileId = c.file_id;
		}
	}
	if (!fileId) throw new Error("Mistral completed the conversation but returned no generated image file.");

	const fileRes = await fetch(`https://api.mistral.ai/v1/files/${fileId}/content`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(30_000),
	});
	if (!fileRes.ok) throw new Error(describeHttpError(fileRes.status, await fileRes.text()));
	const buf = new Uint8Array(await fileRes.arrayBuffer());
	return { base64: Buffer.from(buf).toString("base64"), mimeType: "image/png" };
}

/** Best-effort hostname extraction for base-URL sniffing (nvidia.com / mistral.ai). */
export function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}
