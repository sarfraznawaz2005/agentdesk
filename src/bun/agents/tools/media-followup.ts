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
// ---------------------------------------------------------------------------

const IMAGE_TOOL_NAMES = new Set(["read_image", "take_screenshot"]);
const AUDIO_TOOL_NAMES = new Set(["read_audio"]);

type MediaFollowUpPart =
	| { type: "text"; text: string }
	| { type: "image"; image: string; mediaType: string }
	| { type: "file"; data: string; mediaType: string };

/**
 * Build a synthetic user message carrying the real bytes for any
 * read_image/take_screenshot/read_audio calls in a completed step, so the
 * model actually sees the media on the next step. Returns null if the step
 * had no successful media-tool results.
 */
export function buildMediaFollowUpMessage(
	toolResults: Array<{ toolName: string; output?: unknown; result?: unknown }> | undefined,
): { role: "user"; content: MediaFollowUpPart[] } | null {
	if (!toolResults?.length) return null;

	const mediaParts: MediaFollowUpPart[] = [];
	const toolNamesUsed = new Set<string>();
	for (const tr of toolResults) {
		const raw = tr.output ?? tr.result;
		if (IMAGE_TOOL_NAMES.has(tr.toolName)) {
			const image = extractImagePayload(raw);
			if (image) {
				mediaParts.push({ type: "image", image: image.base64, mediaType: image.mimeType });
				toolNamesUsed.add(tr.toolName);
			}
		} else if (AUDIO_TOOL_NAMES.has(tr.toolName)) {
			const audio = extractAudioPayload(raw);
			if (audio) {
				mediaParts.push({ type: "file", data: audio.base64, mediaType: audio.mimeType });
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
