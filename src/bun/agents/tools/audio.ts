import { tool } from "ai";
import { z } from "zod";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// read_audio — Read an audio file and return base64 for audio-capable models
//
// Only WAV and MP3 are accepted: those are the only formats the AI SDK's
// OpenAI-compatible adapter maps to a real `input_audio` part (see
// getAudioFormat in convert-to-openai-compatible-chat-messages.ts — any other
// mediaType throws UnsupportedFunctionalityError). No transcoding is done
// here; that would need an ffmpeg-class dependency this app doesn't carry.
// Anthropic's Claude models don't accept audio input at all.
// ---------------------------------------------------------------------------

const SUPPORTED_AUDIO_EXTS: Record<string, string> = {
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
};
// Hard cap on raw file size — avoids OOM when reading very large files into memory.
const MAX_AUDIO_SIZE = 20 * 1024 * 1024; // 20 MB

export function extractAudioPayload(output: unknown): { base64: string; mimeType: string } | null {
	if (typeof output !== "string") return null;
	try {
		const parsed = JSON.parse(output) as { audio?: { base64?: string; mimeType?: string } };
		const base64 = parsed.audio?.base64;
		const mimeType = parsed.audio?.mimeType;
		return base64 && mimeType ? { base64, mimeType } : null;
	} catch {
		return null;
	}
}

function audioToolModelOutput(output: string) {
	try {
		const parsed = JSON.parse(output) as { audio?: unknown; [key: string]: unknown };
		if (parsed.audio) {
			const { audio: _audio, ...meta } = parsed;
			return {
				type: "text" as const,
				value: JSON.stringify({ ...meta, note: "Audio loaded — its content is provided to you as audio in the next message." }),
			};
		}
	} catch {
		// not JSON or no audio payload — fall through to plain text
	}
	return { type: "text" as const, value: output };
}

const readAudioInputSchema = z.object({
	path: z.string().describe("Absolute or relative path to the audio file"),
});
type ReadAudioInput = z.infer<typeof readAudioInputSchema>;

const readAudioTool = tool<ReadAudioInput, string>({
	description:
		"Read an audio file and return its base64-encoded content. Only WAV and MP3 are supported — " +
		"other formats (m4a, ogg, flac, aac, opus, etc.) are rejected, since there is no transcoding step. " +
		"Requires an audio-capable AI model to interpret the content; most models cannot. " +
		"Max file size: 20 MB.",
	inputSchema: readAudioInputSchema,
	execute: async ({ path: audioPath }): Promise<string> => {
		try {
			const { extname: getExt, resolve } = await import("node:path");
			const resolvedPath = resolve(audioPath);
			const ext = getExt(resolvedPath).toLowerCase();
			const mimeType = SUPPORTED_AUDIO_EXTS[ext];

			if (!mimeType) {
				return JSON.stringify({
					success: false,
					error: `Unsupported audio format "${ext}". Supported: ${Object.keys(SUPPORTED_AUDIO_EXTS).join(", ")}`,
				});
			}

			const file = Bun.file(resolvedPath);
			const size = file.size;

			if (size === 0) {
				return JSON.stringify({ success: false, error: "File is empty" });
			}
			if (size > MAX_AUDIO_SIZE) {
				return JSON.stringify({
					success: false,
					error: `File too large (${(size / 1024 / 1024).toFixed(1)} MB). Max: 20 MB.`,
				});
			}

			const raw = Buffer.from(await file.arrayBuffer());
			const base64 = raw.toString("base64");

			return JSON.stringify({
				success: true,
				path: resolvedPath,
				mimeType,
				size,
				audio: {
					type: "audio",
					mimeType,
					base64,
				},
			});
		} catch (err) {
			return JSON.stringify({
				success: false,
				error: `Failed to read audio: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	},
	toModelOutput: ({ output }: { output: string }) => audioToolModelOutput(output),
});

// ---------------------------------------------------------------------------
// Exported tool registry
// ---------------------------------------------------------------------------

export const audioTools: Record<string, ToolRegistryEntry> = {
	read_audio: { tool: readAudioTool, category: "file" },
};
