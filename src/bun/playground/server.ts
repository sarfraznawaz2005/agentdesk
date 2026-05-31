// ---------------------------------------------------------------------------
// Playground static preview server (port 4760+)
//
// Serves the playground `files/` directory over HTTP so the in-app preview
// <iframe> can load static artifacts (HTML/CSS/JS, SVG, images, PDFs, etc.)
// at http://127.0.0.1:<PORT>/<entry>. Modeled on annotations/server.ts.
//
// Interactive apps that need a real dev server (Vite/Next/Python) are started
// by the agent itself via run_background; the preview then points at that
// server's own localhost URL. This static server is only for self-contained
// file output.
// ---------------------------------------------------------------------------

import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { PLAYGROUND_FILES_DIR, ensurePlaygroundDirs } from "./paths";

// Live binding — reassigned if the preferred port is taken.
export let PLAYGROUND_SERVER_PORT = 4760;
const PORT_CANDIDATES = [4760, 4761, 4762, 4763, 4764];

let server: ReturnType<typeof Bun.serve> | null = null;

const CORS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

const MIME_TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8",
	json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8",
	svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
	gif: "image/gif", webp: "image/webp", ico: "image/x-icon", avif: "image/avif",
	woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
	eot: "application/vnd.ms-fontobject",
	mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
	pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
	csv: "text/csv; charset=utf-8", wasm: "application/wasm",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function mimeFor(p: string): string {
	const ext = p.split(".").pop()?.toLowerCase() ?? "";
	return MIME_TYPES[ext] ?? "application/octet-stream";
}

// Injected into served HTML so the preview iframe forwards console errors /
// uncaught exceptions to the host page (Playground "Console" panel) via postMessage.
const CONSOLE_CAPTURE_SCRIPT = `<script>(function(){
function send(level,args){try{window.parent.postMessage({__agentdeskPlaygroundConsole:true,level:level,message:Array.prototype.map.call(args,function(a){try{return typeof a==="object"?JSON.stringify(a):String(a)}catch(e){return String(a)}}).join(" ")},"*")}catch(e){}}
var oe=console.error,ow=console.warn;
console.error=function(){send("error",arguments);return oe.apply(console,arguments)};
console.warn=function(){send("warn",arguments);return ow.apply(console,arguments)};
window.addEventListener("error",function(e){send("error",[(e.message||"Error")+" ("+(e.filename||"")+":"+(e.lineno||0)+")"])});
window.addEventListener("unhandledrejection",function(e){var r=e.reason;
  // Ignore Electrobun's injected webview-bridge RPC noise. Its runtime runs in every document
  // (including this preview iframe) and rejects with "Element not found (0x80070490)" — not a page bug.
  if(r&&typeof r==="object"&&("callId" in r||"remoteObjectId" in r))return;
  var m;try{m=r instanceof Error?(r.name+": "+r.message+(r.stack?" | "+r.stack:"")):(typeof r==="object"?JSON.stringify(r):String(r));}catch(x){m=String(r);}
  if(/0x80070490|Element not found/i.test(m))return;
  send("error",["Unhandled promise rejection: "+m]);});
})();</script>`;

function injectConsoleCapture(html: string): string {
	if (html.includes("</head>")) return html.replace("</head>", `${CONSOLE_CAPTURE_SCRIPT}</head>`);
	if (html.includes("<body")) return html.replace(/(<body[^>]*>)/i, `$1${CONSOLE_CAPTURE_SCRIPT}`);
	return CONSOLE_CAPTURE_SCRIPT + html;
}

// PDF.js-based viewer (renders to canvas in the main thread — no native PDF plugin needed,
// which is what WebView2 blocks). `__PDF_URL__` is replaced with the same-origin PDF path.
const PDF_VIEWER_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PDF Preview</title>
<style>
  html,body{margin:0;height:100%;background:#525659;}
  #pages{display:flex;flex-direction:column;align-items:center;gap:16px;padding:20px;box-sizing:border-box;}
  #pages canvas{background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.5);max-width:100%;height:auto;}
  #msg{color:#ddd;font-family:system-ui,sans-serif;text-align:center;padding:48px;font-size:14px;}
</style></head>
<body>
<div id="pages"><div id="msg">Loading PDF…</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
(function(){
  var msg = document.getElementById("msg");
  var container = document.getElementById("pages");
  if (!window.pdfjsLib){ msg.textContent = "Could not load the PDF viewer library."; return; }
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  pdfjsLib.getDocument("__PDF_URL__").promise.then(function(pdf){
    container.innerHTML = "";
    var scale = 1.5, chain = Promise.resolve();
    for (var i=1;i<=pdf.numPages;i++){ (function(n){
      chain = chain.then(function(){ return pdf.getPage(n).then(function(page){
        var vp = page.getViewport({scale:scale});
        var canvas = document.createElement("canvas");
        var ctx = canvas.getContext("2d");
        canvas.width = vp.width; canvas.height = vp.height;
        container.appendChild(canvas);
        return page.render({canvasContext:ctx, viewport:vp}).promise;
      }); });
    })(i); }
    return chain;
  }).catch(function(err){ msg.textContent = "Failed to render PDF: " + ((err && err.message) || err); container.appendChild(msg); });
})();
</script>
</body></html>`;

/**
 * Resolve a request path to an absolute file inside the files dir, rejecting
 * any traversal that escapes the root.
 */
function resolveSafe(urlPath: string): string | null {
	const decoded = decodeURIComponent(urlPath).replace(/^\/+/, "");
	const abs = path.resolve(PLAYGROUND_FILES_DIR, decoded);
	const root = path.resolve(PLAYGROUND_FILES_DIR);
	if (abs !== root && !abs.startsWith(root + path.sep)) return null;
	return abs;
}

export function startPlaygroundServer(): void {
	if (server) return;

	const serveConfig = {
		port: 0,
		idleTimeout: 120,

		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
			if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });

			// PDF viewer route — WebView2 blocks navigating an iframe straight to a PDF
			// ("This page has been blocked by Microsoft Edge"), so render PDFs with PDF.js
			// (canvas) instead. ?file=<path relative to the files/ root>.
			if (url.pathname === "/__pdf") {
				const file = (url.searchParams.get("file") ?? "").replace(/^\/+/, "").replace(/["'<>]/g, "");
				if (!file) return new Response("Missing ?file=", { status: 400, headers: CORS });
				const html = PDF_VIEWER_HTML.replace("__PDF_URL__", "/" + encodeURI(file));
				return new Response(html, { headers: { ...CORS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
			}

			let reqPath = url.pathname;
			if (reqPath === "/" || reqPath === "") reqPath = "/index.html";

			const safe = resolveSafe(reqPath);
			if (!safe) return new Response("Forbidden", { status: 403, headers: CORS });

			// Directory request → serve its index.html
			let target = safe;
			let file = Bun.file(target);
			let exists = await file.exists();
			if (!exists && !path.extname(target)) {
				target = path.join(safe, "index.html");
				file = Bun.file(target);
				exists = await file.exists();
			}

			// SPA fallback: extension-less, not-found paths fall back to root index.html
			// so client-side routers (React Router etc.) work in the preview.
			if (!exists && !path.extname(safe)) {
				target = path.join(PLAYGROUND_FILES_DIR, "index.html");
				file = Bun.file(target);
				exists = await file.exists();
			}

			if (!exists) return new Response("Not found", { status: 404, headers: CORS });

			const contentType = mimeFor(target);

			// Inject the console-capture shim into HTML so runtime errors surface in the app.
			if (contentType.startsWith("text/html")) {
				const html = injectConsoleCapture(await file.text());
				return new Response(html, {
					headers: { ...CORS, "Content-Type": contentType, "Cache-Control": "no-store" },
				});
			}

			return new Response(file, {
				headers: { ...CORS, "Content-Type": contentType, "Cache-Control": "no-store" },
			});
		},

		error(err: Error) {
			console.error("[playground-server]", err);
			return new Response("Internal error", { status: 500 });
		},
	};

	for (const port of PORT_CANDIDATES) {
		try {
			server = Bun.serve({ ...serveConfig, port });
			PLAYGROUND_SERVER_PORT = port;
			console.log(`[playground-server] Listening on port ${port}`);
			startPlaygroundFileWatcher();
			return;
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code !== "EADDRINUSE") {
				console.error("[playground-server] failed to start:", err);
				throw err;
			}
			console.warn(`[playground-server] port ${port} in use, trying next`);
		}
	}
	console.error(`[playground-server] could not bind to any port in [${PORT_CANDIDATES.join(", ")}] — preview will not work`);
}

export function shutdownPlaygroundServer(): void {
	server?.stop();
	server = null;
	stopPlaygroundFileWatcher();
}

// ---------------------------------------------------------------------------
// File watcher — auto-reload the preview iframe when the agent changes files
// after the initial render (e.g. follow-up edits). Debounced to coalesce the
// bursts of writes during a build. Recursive watch is supported on Windows and
// macOS; on Linux it degrades gracefully (manual Refresh still works).
// ---------------------------------------------------------------------------

let watcher: FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function broadcastReload(): void {
	import("../engine-manager")
		.then(({ broadcastToWebview }) => broadcastToWebview("playgroundFilesChanged", {}))
		.catch(() => {});
}

export function startPlaygroundFileWatcher(): void {
	ensurePlaygroundDirs();
	stopPlaygroundFileWatcher();
	try {
		watcher = watch(PLAYGROUND_FILES_DIR, { recursive: true }, () => {
			if (reloadTimer) clearTimeout(reloadTimer);
			reloadTimer = setTimeout(broadcastReload, 400);
		});
	} catch (err) {
		console.warn("[playground-server] file watcher unavailable (manual refresh still works):", err);
	}
}

export function stopPlaygroundFileWatcher(): void {
	if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
	try { watcher?.close(); } catch { /* ignore */ }
	watcher = null;
}

/** Re-establish the watcher after the files dir is wiped/recreated (New Playground). */
export function restartPlaygroundFileWatcher(): void {
	startPlaygroundFileWatcher();
}
