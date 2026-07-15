import type { FilesV4 } from "@ai-sdk/provider";
import { uploadFile } from "ai";
import { extractImagePayload } from "./screenshot";
import { extractAudioPayload } from "./audio";

// ---------------------------------------------------------------------------
// Shared: deliver real media bytes from a tool call as a follow-up message.
//
// A tool-result message can only carry real media on Anthropic's API (as a
// tool_result content block). Every OpenAI-compatible chat/completions
// backend (OpenAI, DeepSeek, Groq, xAI, OpenRouter, Ollama, ZenMux, and any
// other custom provider) requires tool-result content to be a plain string —
// so the actual bytes are stripped out of the tool-result text (see
// imageToolModelOutput/audioToolModelOutput) and re-delivered here as a
// synthetic user-role message right after the tool call — the one wire
// format every provider genuinely supports as real, efficiently-encoded
// media input.
//
// When the calling provider exposes a Files API (`filesApi`, from
// ProviderAdapter.getFilesApi() — Anthropic and real OpenAI only, confirmed
// live 2026-07-15 §6.7), each media part is uploaded once via `uploadFile()`
// and referenced by ID instead of inlined as base64 — avoiding the full
// payload being resent on every subsequent step for the rest of the turn.
// Falls back to inline base64 whenever no Files API is available, or if the
// upload call itself fails (never block the turn on this optimization).
// ---------------------------------------------------------------------------

const IMAGE_TOOL_NAMES = new Set(["read_image", "take_screenshot", "generate_image"]);
const AUDIO_TOOL_NAMES = new Set(["read_audio"]);

type MediaFollowUpPart =
	| { type: "text"; text: string }
	| { type: "file"; data: string | { type: "reference"; reference: Record<string, string> }; mediaType: string };

async function toFilePart(
	base64: string,
	mediaType: string,
	filesApi: FilesV4 | undefined,
): Promise<MediaFollowUpPart> {
	if (filesApi) {
		try {
			const uploaded = await uploadFile({ api: filesApi, data: base64, mediaType });
			return { type: "file", data: { type: "reference", reference: uploaded.providerReference }, mediaType };
		} catch {
			// Fall through to inline base64 — an upload failure must never
			// block the agent from seeing the media at all.
		}
	}
	return { type: "file", data: base64, mediaType };
}

/**
 * Build a synthetic user message carrying the real bytes (or, when
 * `filesApi` is available, an uploaded-file reference) for any
 * read_image/take_screenshot/generate_image/read_audio calls in a completed
 * step, so the model actually sees the media on the next step. Returns null
 * if the step had no successful media-tool results.
 */
export async function buildMediaFollowUpMessage(
	toolResults: Array<{ toolName: string; output?: unknown; result?: unknown }> | undefined,
	filesApi?: FilesV4,
): Promise<{ role: "user"; content: MediaFollowUpPart[] } | null> {
	if (!toolResults?.length) return null;

	const mediaParts: MediaFollowUpPart[] = [];
	const toolNamesUsed = new Set<string>();
	for (const tr of toolResults) {
		const raw = tr.output ?? tr.result;
		if (IMAGE_TOOL_NAMES.has(tr.toolName)) {
			const image = extractImagePayload(raw);
			if (image) {
				mediaParts.push(await toFilePart(image.base64, image.mimeType, filesApi));
				toolNamesUsed.add(tr.toolName);
			}
		} else if (AUDIO_TOOL_NAMES.has(tr.toolName)) {
			const audio = extractAudioPayload(raw);
			if (audio) {
				mediaParts.push(await toFilePart(audio.base64, audio.mimeType, filesApi));
				toolNamesUsed.add(tr.toolName);
			}
		}
	}
	if (mediaParts.length === 0) return null;

	// A bare media part with no anchoring text reads to smaller/cheaper models
	// as an unexplained new user turn rather than the fulfillment of their own
	// tool call — observed causing a "flash"-tier model to call read_image 4x
	// in a row for the same file before proceeding. This text makes the link
	// to the tool call explicit so it doesn't re-call the tool "to be sure".
	const anchor = `Here is the content from your ${[...toolNamesUsed].join("/")} call. Use it directly to answer — no need to call the tool again.`;

	return { role: "user", content: [{ type: "text", text: anchor }, ...mediaParts] };
}
