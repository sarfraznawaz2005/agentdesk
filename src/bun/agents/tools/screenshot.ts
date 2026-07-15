import { tool } from "ai";
import { z } from "zod";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { settings } from "../../db/schema";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// Chrome/Chromium discovery — find an installed browser for headless screenshots
// ---------------------------------------------------------------------------

const CHROME_PATHS = [
	// Windows
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
	// macOS
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	// Linux
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/snap/bin/chromium",
];

function findChrome(): string | null {
	for (const p of CHROME_PATHS) {
		try {
			if (existsSync(p)) return p;
		} catch {
			// skip
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Shared: image tool result handling.
//
// A tool-result message can only carry an actual image on Anthropic's API
// (as a tool_result image block). Every OpenAI-compatible chat/completions
// backend (OpenAI, DeepSeek, Groq, xAI, OpenRouter, Ollama, ZenMux, and any
// other custom provider) requires tool-result content to be a plain string —
// the AI SDK's openai-compatible adapter just JSON.stringifies whatever we
// give it, which means a raw base64 payload gets embedded as literal TEXT
// and tokenized character-by-character. For a ~150-300KB resized image that
// can be tens of thousands of tokens, which blew a small-context-window
// model's request budget and came back as a 400 "invalid_params" from
// ZenMux (stepfun/step-3.7-flash-free).
//
// So the tool-result text must never carry the base64 payload. Instead:
// extractImagePayload() strips it out of the JSON for toModelOutput (keeps
// the result cheap on every provider), and buildMediaFollowUpMessage() in
// media-followup.ts re-delivers the actual bytes as a synthetic user-role
// image message right after the tool call — the one wire format every
// provider genuinely supports as real, efficiently-tokenized vision input.
// ---------------------------------------------------------------------------

export function extractImagePayload(output: unknown): { base64: string; mimeType: string } | null {
	if (typeof output !== "string") return null;
	try {
		const parsed = JSON.parse(output) as { image?: { base64?: string; mimeType?: string } };
		const base64 = parsed.image?.base64;
		const mimeType = parsed.image?.mimeType;
		return base64 && mimeType ? { base64, mimeType } : null;
	} catch {
		return null;
	}
}

export function imageToolModelOutput(output: string) {
	try {
		const parsed = JSON.parse(output) as { image?: unknown; [key: string]: unknown };
		if (parsed.image) {
			const { image: _image, ...meta } = parsed;
			return {
				type: "text" as const,
				value: JSON.stringify({ ...meta, note: "Image loaded — its content is provided to you as an image in the next message." }),
			};
		}
	} catch {
		// not JSON or no image payload — fall through to plain text
	}
	return { type: "text" as const, value: output };
}

// ---------------------------------------------------------------------------
// take_screenshot tool
// ---------------------------------------------------------------------------

async function captureScreenshot(
	url: string,
	width: number,
	height: number,
): Promise<{ base64: string } | { error: string }> {
	const chromePath = findChrome();
	if (!chromePath) {
		return {
			error:
				"No Chrome/Chromium browser found on this system. Install Google Chrome to enable screenshots.",
		};
	}

	const tmpFile = join(tmpdir(), `agentdesk-screenshot-${crypto.randomUUID().slice(0, 8)}.png`);

	try {
		const proc = Bun.spawn(
			[
				chromePath,
				"--headless=new",
				"--disable-gpu",
				"--no-sandbox",
				"--disable-dev-shm-usage",
				`--window-size=${width},${height}`,
				`--screenshot=${tmpFile}`,
				"--hide-scrollbars",
				url,
			],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		// Wait for process with a 30s timeout
		const timeout = setTimeout(() => proc.kill(), 30_000);
		await proc.exited;
		clearTimeout(timeout);

		if (!existsSync(tmpFile)) {
			const stderr = await new Response(proc.stderr).text();
			return { error: `Screenshot failed: ${stderr.slice(0, 500)}` };
		}

		const buffer = await readFile(tmpFile);
		const base64 = buffer.toString("base64");

		return { base64 };
	} catch (err) {
		return {
			error: `Screenshot error: ${err instanceof Error ? err.message : String(err)}`,
		};
	} finally {
		// Clean up temp file
		try {
			await unlink(tmpFile);
		} catch {
			// ignore
		}
	}
}

/**
 * Resolve the dev server URL for a project from settings.
 */
async function getDevServerUrl(projectId: string): Promise<string | null> {
	const key = `project:${projectId}:devServerUrl`;
	const rows = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, key));
	return rows[0]?.value?.trim() || null;
}

const takeScreenshotInputSchema = z.object({
	url: z
		.string()
		.optional()
		.describe(
			"URL to screenshot. Defaults to the project's Dev Server URL if configured.",
		),
	project_id: z
		.string()
		.describe("Project ID — used to look up the dev server URL if no URL is provided."),
	width: z
		.number()
		.int()
		.min(320)
		.max(3840)
		.optional()
		.default(1280)
		.describe("Viewport width in pixels (default: 1280)"),
	height: z
		.number()
		.int()
		.min(240)
		.max(2160)
		.optional()
		.default(720)
		.describe("Viewport height in pixels (default: 720)"),
});
const takeScreenshotTool = tool({
	description:
		"Take a screenshot of a web page at the given URL. Returns a base64-encoded PNG image. " +
		"If no URL is provided, uses the project's configured Dev Server URL. " +
		"Useful for visually verifying UI changes, catching layout bugs, and comparing before/after states. " +
		"Requires Chrome/Chromium to be installed on the system.",
	inputSchema: takeScreenshotInputSchema,
	execute: async (args: z.infer<typeof takeScreenshotInputSchema>): Promise<string> => {
		let targetUrl = args.url;

		if (!targetUrl) {
			const devUrl = await getDevServerUrl(args.project_id);
			if (!devUrl) {
				return JSON.stringify({
					success: false,
					error:
						"No URL provided and no Dev Server URL configured for this project. " +
						"Set a Dev Server URL in Project Settings > AI tab, or pass a URL directly.",
				});
			}
			targetUrl = devUrl;
		}

		const result = await captureScreenshot(
			targetUrl,
			args.width ?? 1280,
			args.height ?? 720,
		);

		if ("error" in result) {
			return JSON.stringify({ success: false, error: result.error });
		}

		// Resize to fit MAX_DIMENSION so any screenshot size works regardless of viewport
		const raw = Buffer.from(result.base64, "base64");
		const { data, mimeType } = await resizeToFit(raw);
		const base64 = data.toString("base64");

		return JSON.stringify({
			success: true,
			url: targetUrl,
			image: { type: "image", mimeType, base64 },
		});
	},
	toModelOutput: ({ output }: { output: string }) => imageToolModelOutput(output),
});

// ---------------------------------------------------------------------------
// read_image — Read an image file and return base64 for vision-capable models
// ---------------------------------------------------------------------------

const SUPPORTED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
// Hard cap on raw file size — avoids OOM when reading very large files into memory.
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
// Resize images so the longer edge is at most this many pixels.
// Keeps base64 output manageable for all providers without an arbitrary byte cap.
const MAX_DIMENSION = 1280;

/**
 * Resize an image buffer so its longest edge ≤ MAX_DIMENSION, then return
 * as JPEG (good compression, universally supported by vision APIs).
 * If the image is already within limits AND is already JPEG, returns original
 * buffer without re-encoding to avoid unnecessary lossy compression.
 */
async function resizeToFit(buffer: Buffer): Promise<{ data: Buffer; mimeType: string }> {
	const { Jimp } = await import("jimp");
	const image = await Jimp.fromBuffer(buffer);
	const { width, height } = image.bitmap;

	// Skip re-encoding if already within size limits and already JPEG
	if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
		// JPEG magic bytes: FF D8
		if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
			return { data: buffer, mimeType: "image/jpeg" };
		}
	}

	if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
		image.scaleToFit({ w: MAX_DIMENSION, h: MAX_DIMENSION });
	}
	const data = Buffer.from(await image.getBuffer("image/jpeg"));
	return { data, mimeType: "image/jpeg" };
}


const readImageInputSchema = z.object({
	path: z.string().describe("Absolute or relative path to the image file"),
});
const readImageTool = tool({
	description:
		"Read an image file and return its base64-encoded content. Supports PNG, JPG, GIF, WebP, BMP, and SVG. " +
		"Use this to analyze screenshots, mockups, diagrams, or any visual asset. " +
		"Requires a vision-capable AI model to interpret the image content. " +
		"Max file size: 20 MB.",
	inputSchema: readImageInputSchema,
	execute: async ({ path: imagePath }: { path: string }): Promise<string> => {
		try {
			const { extname: getExt, resolve } = await import("node:path");
			const resolvedPath = resolve(imagePath);
			const ext = getExt(resolvedPath).toLowerCase();

			if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
				return JSON.stringify({
					success: false,
					error: `Unsupported image format "${ext}". Supported: ${[...SUPPORTED_IMAGE_EXTS].join(", ")}`,
				});
			}

			const file = Bun.file(resolvedPath);
			const size = file.size;

			if (size === 0) {
				return JSON.stringify({ success: false, error: "File is empty" });
			}
			if (size > MAX_IMAGE_SIZE) {
				return JSON.stringify({
					success: false,
					error: `File too large (${(size / 1024 / 1024).toFixed(1)} MB). Max: 20 MB.`,
				});
			}

			const raw = Buffer.from(await file.arrayBuffer());
			const { data, mimeType: outMimeType } = await resizeToFit(raw);
			const base64 = data.toString("base64");

			return JSON.stringify({
				success: true,
				path: resolvedPath,
				mimeType: outMimeType,
				size,
				image: {
					type: "image",
					mimeType: outMimeType,
					base64,
				},
			});
		} catch (err) {
			return JSON.stringify({
				success: false,
				error: `Failed to read image: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	},
	toModelOutput: ({ output }: { output: string }) => imageToolModelOutput(output),
});

// ---------------------------------------------------------------------------
// Exported tool registry
// ---------------------------------------------------------------------------

export const screenshotTools: Record<string, ToolRegistryEntry> = {
	take_screenshot: { tool: takeScreenshotTool, category: "web" },
	read_image: { tool: readImageTool, category: "file" },
};
