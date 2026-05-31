// ---------------------------------------------------------------------------
// AgentDesk Annotation Server  (port 4748)
// • GET  /toolbar.js?project=ID&conv=CID         — serves toolbar JS with IDs baked in
// • GET  /preview?url=URL&project=ID&conv=CID&enableAnnotation=1
//                                                — HTML proxy (bakes toolbar in on every load)
// • GET  /file-serve/<abs-path>                  — serves local filesystem assets for file:// proxy
// • GET  /projects                               — project list (kept for external use)
// • GET  /projects/:id/conversations             — conversation list (kept for external use)
// • POST /annotations                            — receives batch annotations → routes to engine
// ---------------------------------------------------------------------------

import { db } from "../db";
import { projects, conversations } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { getToolbarScript } from "./toolbar-script";
import { createConversation } from "../rpc/conversations";
import { getOrCreateEngine } from "../engine-manager";
import { readFileSync } from "fs";

// Live binding — may be reassigned at startup if the preferred port is taken.
// Consumers in this process read the current value when building URLs.
export let ANNOTATION_SERVER_PORT = 4748;
const PORT_CANDIDATES = [4748, 4749, 4750, 4751, 4752];

let server: ReturnType<typeof Bun.serve> | null = null;

// ---------------------------------------------------------------------------
// CORS — allow all origins including null (file:// pages)
// ---------------------------------------------------------------------------
const CORS: Record<string, string> = {
	"Access-Control-Allow-Origin":  "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function jsonRes(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { ...CORS, "Content-Type": "application/json" },
	});
}

// ---------------------------------------------------------------------------
// MIME types for /file-serve
// ---------------------------------------------------------------------------
const MIME_TYPES: Record<string, string> = {
	html:  "text/html; charset=utf-8",
	htm:   "text/html; charset=utf-8",
	css:   "text/css; charset=utf-8",
	js:    "application/javascript; charset=utf-8",
	mjs:   "application/javascript; charset=utf-8",
	json:  "application/json; charset=utf-8",
	xml:   "application/xml; charset=utf-8",
	svg:   "image/svg+xml",
	png:   "image/png",
	jpg:   "image/jpeg",
	jpeg:  "image/jpeg",
	gif:   "image/gif",
	webp:  "image/webp",
	ico:   "image/x-icon",
	avif:  "image/avif",
	woff:  "font/woff",
	woff2: "font/woff2",
	ttf:   "font/ttf",
	otf:   "font/otf",
	eot:   "application/vnd.ms-fontobject",
	mp4:   "video/mp4",
	webm:  "video/webm",
	mp3:   "audio/mpeg",
	wav:   "audio/wav",
	ogg:   "audio/ogg",
	pdf:   "application/pdf",
	txt:   "text/plain; charset=utf-8",
	md:    "text/markdown; charset=utf-8",
};

function mimeFor(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return MIME_TYPES[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// HTML proxy helpers
// ---------------------------------------------------------------------------

function injectToolbar(html: string, projectId: string, conversationId: string, baseOrigin: string | null): string {
	const scriptTag = `<script src="http://localhost:${ANNOTATION_SERVER_PORT}/toolbar.js?project=${encodeURIComponent(projectId)}&conv=${encodeURIComponent(conversationId)}"></script>`;
	const baseTag   = baseOrigin ? `<base href="${baseOrigin}">` : "";

	// Inject <base> right after <head> (if present) so all relative URLs resolve to the original server
	let out = baseTag
		? html.replace(/(<head[^>]*>)/i, `$1${baseTag}`)
		: html;
	if (baseTag && !out.includes(baseTag)) out = baseTag + out;

	// Inject toolbar just before </body> (or append as fallback)
	if (out.includes("</body>")) {
		out = out.replace(/<\/body>/i, `${scriptTag}</body>`);
	} else {
		out += scriptTag;
	}
	return out;
}

async function proxyHttp(targetUrl: string, projectId: string, conversationId: string): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(targetUrl, { headers: { "Accept": "text/html,*/*" } });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return new Response(
			`<html><body style="font-family:sans-serif;padding:24px;color:#ef4444">` +
			`<b>AgentDesk Preview</b><br><br>Could not load <code>${targetUrl}</code><br><small>${msg}</small></body></html>`,
			{ headers: { "Content-Type": "text/html" } },
		);
	}

	const ct = res.headers.get("content-type") ?? "";
	if (!ct.includes("text/html")) {
		return new Response(await res.arrayBuffer(), {
			headers: { "Content-Type": ct },
		});
	}

	const origin = new URL(targetUrl).origin + "/"; // e.g. http://localhost:3000/
	const html   = await res.text();
	return new Response(injectToolbar(html, projectId, conversationId, origin), {
		headers: { ...CORS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	});
}

function proxyFile(filePath: string, projectId: string, conversationId: string): Response {
	// filePath comes from new URL("file:///C:/...").pathname → "/C:/path/..."
	// On Windows strip the leading slash
	const normalized = process.platform === "win32" && filePath.startsWith("/")
		? filePath.slice(1)
		: filePath;

	let html: string;
	try {
		html = readFileSync(normalized, "utf-8");
	} catch {
		return new Response(
			`<html><body style="font-family:sans-serif;padding:24px;color:#ef4444">` +
			`<b>AgentDesk Preview</b><br><br>Could not read file: <code>${normalized}</code></body></html>`,
			{ headers: { "Content-Type": "text/html" } },
		);
	}

	// Derive the directory and serve it through /file-serve/ so CSS/JS/images
	// load over http:// (avoids browsers blocking file:// from an http:// page).
	const sep = process.platform === "win32" ? "\\" : "/";
	const dir = normalized.includes(sep)
		? normalized.substring(0, normalized.lastIndexOf(sep) + 1)
		: normalized;
	const dirForUrl = dir.replace(/\\/g, "/");
	const baseHref  = `http://localhost:${ANNOTATION_SERVER_PORT}/file-serve/${dirForUrl}`;

	return new Response(injectToolbar(html, projectId, conversationId, baseHref), {
		headers: { ...CORS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	});
}

// ---------------------------------------------------------------------------
// /file-serve — read a local file from disk and serve over HTTP with correct
// content-type. Used as the <base> for file:// proxied pages so relative
// assets load without mixed-content blocking.
// ---------------------------------------------------------------------------
function serveLocalFile(rawPath: string): Response {
	const decoded = decodeURIComponent(rawPath);

	// On Windows the URL path looks like "C:/project/style.css" (no leading slash).
	// On POSIX it looks like "/abs/path/style.css".
	let absPath: string;
	if (process.platform === "win32") {
		// Trim any leading slash some clients add (e.g. "/C:/project/...")
		absPath = decoded.startsWith("/") ? decoded.slice(1) : decoded;
	} else {
		absPath = decoded.startsWith("/") ? decoded : "/" + decoded;
	}

	try {
		const data = readFileSync(absPath);
		return new Response(data, {
			headers: { ...CORS, "Content-Type": mimeFor(absPath), "Cache-Control": "no-store" },
		});
	} catch {
		return new Response("File not found", { status: 404, headers: CORS });
	}
}

// ---------------------------------------------------------------------------
// Preview event buffer — console errors / unhandled rejections from the
// preview window get POSTed to /preview-events and stored here keyed by
// conversationId. They get attached to the next annotation submission so
// the engine sees runtime errors alongside UI annotations.
// ---------------------------------------------------------------------------
interface PreviewEvent {
	level:   "error" | "warn";
	message: string;
	stack:   string;
	url:     string;
	ts:      number;
}

const EVENT_BUFFER_LIMIT = 50; // per conversation
const eventBuffer = new Map<string, PreviewEvent[]>();

function pushEvent(conversationId: string, ev: PreviewEvent): void {
	if (!conversationId) return;
	let arr = eventBuffer.get(conversationId);
	if (!arr) { arr = []; eventBuffer.set(conversationId, arr); }
	arr.push(ev);
	if (arr.length > EVENT_BUFFER_LIMIT) arr.splice(0, arr.length - EVENT_BUFFER_LIMIT);
}

function drainEvents(conversationId: string): PreviewEvent[] {
	const arr = eventBuffer.get(conversationId) ?? [];
	eventBuffer.delete(conversationId);
	return arr;
}

function formatEvents(events: PreviewEvent[]): string {
	if (!events.length) return "";
	const lines: string[] = ["", "## Runtime Console Events", ""];
	events.forEach((e, i) => {
		lines.push(`**${i + 1}. [${e.level.toUpperCase()}]** ${e.message}`);
		if (e.stack) lines.push("```\n" + e.stack.slice(0, 800) + "\n```");
		lines.push(`*at ${e.url}*`);
		lines.push("");
	});
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Annotation message formatter (batch)
// ---------------------------------------------------------------------------
function formatBatchMessage(opts: {
	annotations: Array<{
		element: { selector: string; text?: string; bounds?: Record<string, number> };
		comment:  string;
	}>;
	url:       string;
	pageTitle: string;
}): string {
	const lines: string[] = [
		`[UI Annotations] ${opts.annotations.length} annotation${opts.annotations.length > 1 ? "s" : ""} from ${opts.pageTitle || opts.url}`,
		"",
		`**Page:** ${opts.pageTitle ? `${opts.pageTitle} — ` : ""}${opts.url}`,
		"",
	];

	opts.annotations.forEach((ann, i) => {
		lines.push(`### Annotation ${i + 1}`);
		lines.push(`**Element:** \`${ann.element.selector}\``);
		if (ann.element.text) lines.push(`**Text:** "${ann.element.text}"`);
		if (ann.element.bounds) {
			const b = ann.element.bounds;
			lines.push(`**Bounds:** x:${b.x} y:${b.y} w:${b.w} h:${b.h}`);
		}
		lines.push(`**Issue:** ${ann.comment}`);
		lines.push("");
	});

	lines.push("Please inspect each annotated element and fix all issues.");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export function startAnnotationServer(): void {
	if (server) return;

	const serveConfig = {
		port: 0, // placeholder — set per attempt below
		// Bun.serve defaults to a 10s idle timeout. The /preview proxy route
		// fetches the user's dev server (Laravel/Django/etc.), which may take
		// longer than that on a cold first request — especially when the
		// upstream is also loading framework debugbars/queries. 120s leaves
		// plenty of head-room for real-world dev servers without holding
		// truly stuck connections forever.
		idleTimeout: 120,

		async fetch(req: Request) {
			const url    = new URL(req.url);
			const path   = url.pathname;
			const method = req.method;

			if (method === "OPTIONS") {
				return new Response(null, { status: 204, headers: CORS });
			}

			// ── GET /toolbar.js ───────────────────────────────────────────
			if (method === "GET" && path === "/toolbar.js") {
				const projectId      = url.searchParams.get("project") ?? "";
				const conversationId = url.searchParams.get("conv") ?? "";
				return new Response(getToolbarScript(ANNOTATION_SERVER_PORT, projectId, conversationId), {
					headers: { ...CORS, "Content-Type": "application/javascript; charset=utf-8" },
				});
			}

			// ── GET /file-serve/<abs-path> ────────────────────────────────
			if (method === "GET" && path.startsWith("/file-serve/")) {
				return serveLocalFile(path.slice("/file-serve/".length));
			}

			// ── GET /preview?url=...&project=...&conv=...&enableAnnotation=1
			// HTML proxy: fetches target URL and bakes the toolbar in so it
			// persists on every refresh without re-injection. Toolbar is only
			// injected when enableAnnotation=1 is present.
			if (method === "GET" && path === "/preview") {
				const targetUrl       = url.searchParams.get("url") ?? "";
				const projectId       = url.searchParams.get("project") ?? "";
				const conversationId  = url.searchParams.get("conv") ?? "";
				const enableAnnotation = url.searchParams.get("enableAnnotation") === "1";

				if (!targetUrl) {
					return new Response("Missing ?url=", { status: 400 });
				}

				// If annotation is not requested, redirect to the raw URL — no proxy needed.
				if (!enableAnnotation) {
					return Response.redirect(targetUrl, 302);
				}

				if (targetUrl.startsWith("file://")) {
					const filePath = new URL(targetUrl).pathname;
					return proxyFile(filePath, projectId, conversationId);
				}

				return proxyHttp(targetUrl, projectId, conversationId);
			}

			// ── POST /preview-events ──────────────────────────────────────
			// Receives console errors / unhandled rejections from the preview
			// window's injected hook script. Buffered per conversation, drained
			// on the next annotation submission.
			if (method === "POST" && path === "/preview-events") {
				try {
					const body = await req.json() as Partial<PreviewEvent> & { conversationId?: string };
					if (body.conversationId && body.level && body.message) {
						pushEvent(body.conversationId, {
							level:   body.level === "warn" ? "warn" : "error",
							message: body.message,
							stack:   body.stack ?? "",
							url:     body.url ?? "",
							ts:      body.ts ?? Date.now(),
						});
					}
				} catch { /* malformed body — ignore */ }
				return jsonRes({ ok: true });
			}

			// ── GET /projects ─────────────────────────────────────────────
			if (method === "GET" && path === "/projects") {
				const rows = await db
					.select({ id: projects.id, name: projects.name })
					.from(projects)
					.orderBy(desc(projects.createdAt));
				return jsonRes(rows);
			}

			// ── GET /projects/:id/conversations ───────────────────────────
			const convMatch = /^\/projects\/([^/]+)\/conversations$/.exec(path);
			if (method === "GET" && convMatch) {
				const rows = await db
					.select({ id: conversations.id, title: conversations.title })
					.from(conversations)
					.where(eq(conversations.projectId, convMatch[1]))
					.orderBy(desc(conversations.updatedAt))
					.limit(20);
				return jsonRes(rows);
			}

			// ── POST /annotations ─────────────────────────────────────────
			if (method === "POST" && path === "/annotations") {
				let body: {
					projectId:      string;
					conversationId: string;
					annotations:    Array<{
						element: { selector: string; text?: string; bounds?: Record<string, number> };
						comment:  string;
					}>;
					url:       string;
					pageTitle: string;
				};

				try {
					body = await req.json() as typeof body;
				} catch {
					return jsonRes({ error: "Invalid JSON" }, 400);
				}

				const { projectId, annotations: anns, url: pageUrl, pageTitle = "" } = body;
				let { conversationId } = body;

				if (!projectId || !anns?.length) {
					return jsonRes({ error: "projectId and annotations[] are required" }, 400);
				}

				if (!conversationId || conversationId === "new") {
					const created = await createConversation(projectId, "UI Annotations");
					conversationId = created.id;
				}

				const events  = drainEvents(conversationId);
				const content = formatBatchMessage({ annotations: anns, url: pageUrl, pageTitle }) +
					formatEvents(events);

				getOrCreateEngine(projectId)
					.sendMessage(conversationId, content)
					.catch((err: unknown) => console.error("[annotation-server] engine error:", err));

				return jsonRes({ ok: true, conversationId, count: anns.length, consoleEvents: events.length });
			}

			return new Response("Not found", { status: 404, headers: CORS });
		},

		error(err: Error) {
			console.error("[annotation-server]", err);
			return new Response("Internal error", { status: 500 });
		},
	};

	// Try each candidate port — handles the case where a previous AgentDesk
	// instance still holds 4748 (orphaned subprocess, debug session, etc.).
	for (const port of PORT_CANDIDATES) {
		try {
			server = Bun.serve({ ...serveConfig, port });
			ANNOTATION_SERVER_PORT = port;
			console.log(`[annotation-server] Listening on port ${port}`);
			return;
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code !== "EADDRINUSE") {
				console.error("[annotation-server] failed to start:", err);
				throw err;
			}
			console.warn(`[annotation-server] port ${port} in use, trying next`);
		}
	}

	console.error(`[annotation-server] could not bind to any port in [${PORT_CANDIDATES.join(", ")}] — preview will not work until you close the conflicting process`);
}

export function shutdownAnnotationServer(): void {
	server?.stop();
	server = null;
}
