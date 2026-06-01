// ---------------------------------------------------------------------------
// Playground-only tools (injected into the Playground Agent via extraTools)
//
//  • playground_render_preview — the agent calls this when its artifact is ready
//    to be shown. It writes the preview manifest and tells the page to swap from
//    the live-activity view to the rendered preview.
//  • playground_reject — the agent calls this when the request cannot be rendered
//    in-app (native apps, cloud deploys, etc.), with guidance for the user.
//
// These are NOT registered in the global tool registry — they only exist for the
// duration of a playground run, so no other agent ever sees them.
// ---------------------------------------------------------------------------

import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { PREVIEW_FILE, ensurePlaygroundDirs } from "../../playground/paths";
import { PLAYGROUND_SERVER_PORT } from "../../playground/server";

export type PlaygroundPreviewKind = "static" | "devserver" | "file";

export interface PlaygroundPreview {
	kind: PlaygroundPreviewKind;
	url: string;
	title: string;
	description?: string;
	createdAt: string;
}

async function isReachable(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		const res = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
		clearTimeout(t);
		return res.status < 500;
	} catch {
		return false;
	}
}

async function waitReachable(url: string, totalMs = 20_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < totalMs) {
		if (await isReachable(url)) return true;
		await new Promise((r) => setTimeout(r, 750));
	}
	return false;
}

async function broadcast(method: string, payload: unknown): Promise<void> {
	try {
		const { broadcastToWebview } = await import("../../engine-manager");
		broadcastToWebview(method, payload);
	} catch {
		/* webview not ready — ignore */
	}
}

function staticUrl(entry: string): string {
	const clean = entry.replace(/^\/+/, "");
	return `http://127.0.0.1:${PLAYGROUND_SERVER_PORT}/${clean}`;
}

const renderPreviewTool = tool({
	description:
		"Show the finished artifact in the Playground preview pane. Call this ONCE the work is " +
		"ready to be viewed (and again after each follow-up change). The page switches from the " +
		"live activity log to the rendered preview.\n" +
		"Choose the type:\n" +
		"• 'static' — self-contained files you wrote into the workspace. Set `entry` to the HTML " +
		"file to open (default 'index.html'). Best for web pages, designs, SVG/canvas drawings, and SPAs you bundled to static output.\n" +
		"• 'file' — a single generated document to display (PDF, image, markdown, csv). Set `file` " +
		"to its path relative to the workspace (e.g. 'invoice.pdf').\n" +
		"• 'devserver' — an interactive app served by a dev server you started with run_background " +
		"(Vite/Next/Python/etc.). Set `url` to its localhost address (e.g. 'http://localhost:5173'). " +
		"The preview will wait for the server to become reachable before showing.",
	inputSchema: z.object({
		type: z.enum(["static", "devserver", "file"]).describe("How the artifact should be previewed"),
		title: z.string().describe("Short human-readable title for what was built"),
		description: z.string().optional().describe("One-line summary of what the user is looking at"),
		entry: z.string().optional().describe("For type 'static': the HTML entry file, default 'index.html'"),
		file: z.string().optional().describe("For type 'file': the document path relative to the workspace"),
		url: z.string().optional().describe("For type 'devserver': the localhost URL of the running server"),
	}),
	execute: async ({ type, title, description, entry, file, url }): Promise<string> => {
		ensurePlaygroundDirs();

		let previewUrl: string;
		if (type === "devserver") {
			if (!url) return "Error: type 'devserver' requires `url` (the localhost address of your running server).";
			if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(url)) {
				return "Error: devserver `url` must be a localhost address (http://localhost:PORT or http://127.0.0.1:PORT).";
			}
			const ok = await waitReachable(url);
			if (!ok) {
				return `Error: the dev server at ${url} did not become reachable within 20s. ` +
					`Make sure you started it with run_background and that it is listening on that exact URL, then call playground_render_preview again.`;
			}
			previewUrl = url;
		} else if (type === "file") {
			if (!file) return "Error: type 'file' requires `file` (path relative to the workspace).";
			// Office files have no browser renderer — they'd just download/blank. Steer the agent
			// to produce an HTML preview instead (e.g. SheetJS / mammoth.js / styled HTML).
			if (/\.(xlsx?|docx?|pptx?)$/i.test(file)) {
				return (
					`Error: "${file}" is an Office file, which the browser cannot display. Build an HTML preview instead ` +
					`(SheetJS for spreadsheets, mammoth.js for .docx, or render the content as styled HTML) and call ` +
					`playground_render_preview with type:"static". You can leave the original file in the workspace as a download.`
				);
			}
			// Server-side scripts cannot be executed by the browser — they'd download or show blank.
			if (/\.(php|py|rb|pl|aspx?|jsp|cgi|cfm|lua)$/i.test(file)) {
				return (
					`Error: "${file}" is a server-side script that the browser cannot execute. ` +
					`Instead, either: (1) start a local dev server that runs the script (php -S localhost:PORT, python -m http.server, etc.) ` +
					`and use type:"devserver", or (2) build a self-contained index.html that demonstrates the same output and use type:"static". ` +
					`If the runtime is not installed on this machine, option 2 is the safest choice.`
				);
			}
			// PDFs can't be shown by navigating the iframe to them (WebView2 blocks the native
			// PDF viewer), so route them through the server's PDF.js viewer.
			previewUrl = /\.pdf$/i.test(file)
				? `http://127.0.0.1:${PLAYGROUND_SERVER_PORT}/__pdf?file=${encodeURIComponent(file.replace(/^\/+/, ""))}`
				: staticUrl(file);
		} else {
			previewUrl = staticUrl(entry || "index.html");
		}

		const preview: PlaygroundPreview = {
			kind: type,
			url: previewUrl,
			title,
			description,
			createdAt: new Date().toISOString(),
		};

		try {
			writeFileSync(PREVIEW_FILE, JSON.stringify(preview, null, 2), "utf-8");
		} catch (err) {
			return `Error writing preview manifest: ${err instanceof Error ? err.message : String(err)}`;
		}

		await broadcast("playgroundPreviewReady", preview);
		return `Preview is now showing in the page: "${title}" (${type}) at ${previewUrl}. ` +
			`If the user asks for changes, update the files and call playground_render_preview again.`;
	},
});

const rejectTool = tool({
	description:
		"Decline a request that CANNOT be rendered and previewed inside this desktop app. Use this " +
		"for things like native mobile/desktop apps, cloud deployments, browser extensions, anything " +
		"that needs installation on the user's machine or external credentials/secrets. Provide a clear " +
		"reason and concrete guidance (e.g. suggest using 'Create Project' to turn this into a real project, " +
		"or describe what they could build here instead). Call this INSTEAD of building anything.",
	inputSchema: z.object({
		reason: z.string().describe("Why this cannot be rendered in the Playground"),
		guidance: z.string().describe("What the user should do instead (actionable next steps)"),
	}),
	execute: async ({ reason, guidance }): Promise<string> => {
		await broadcast("playgroundRejected", { reason, guidance, createdAt: new Date().toISOString() });
		return "Rejection shown to the user. Do not build anything for this request.";
	},
});

/** Build the playground-only tool set injected via runInlineAgent's extraTools. */
export function createPlaygroundTools(): Record<string, Tool> {
	return {
		playground_render_preview: renderPreviewTool,
		playground_reject: rejectTool,
	};
}
