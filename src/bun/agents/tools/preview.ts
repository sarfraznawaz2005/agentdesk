// ---------------------------------------------------------------------------
// preview_project PM tool
// Handles /preview entirely in Bun — no sub-agent needed.
// Detects project type, starts the dev server if required, opens the
// annotation-proxy URL in chrome-devtools, and takes a screenshot.
// The toolbar is baked into the page server-side, so it survives refresh.
// ---------------------------------------------------------------------------

import { tool, generateText } from "ai";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { createConnection } from "node:net";
import { ANNOTATION_SERVER_PORT } from "../../annotations/server";
import { openPreviewWindow } from "../../annotations/preview-window";
import { Updater } from "electrobun/bun";
import { createProviderAdapter } from "../../providers";
import { getDefaultModel } from "../../providers/models";
import { internalCallModelId } from "../../providers/claude-subscription";
import type { ProviderConfig } from "../../providers/types";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------
interface PreviewConfig {
	projectType: string;
	url:          string;
	startCommand?: string;
	cwd?:          string;
}

// ---------------------------------------------------------------------------
// Project detection
// ---------------------------------------------------------------------------
function readText(path: string): string {
	try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function loadSavedConfig(workspacePath: string): PreviewConfig | null {
	const configPath = join(workspacePath, ".agentdeskai", "preview.json");
	if (!existsSync(configPath)) return null;
	try {
		const saved = JSON.parse(readFileSync(configPath, "utf-8")) as PreviewConfig;
		return saved.url ? saved : null;
	} catch { return null; }
}

function invalidateSavedConfig(workspacePath: string): void {
	try {
		const configPath = join(workspacePath, ".agentdeskai", "preview.json");
		if (existsSync(configPath)) unlinkSync(configPath);
	} catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// AI-based detection
// First /preview asks an LLM to inspect the workspace and return a structured
// {projectType, url, startCommand, cwd}. The result is saved to
// .agentdeskai/preview.json so subsequent runs are instant. Replaces the old
// heuristic detection, which struggled with ordering edge cases (Laravel +
// Vite, Rails + Vite, monorepos, etc.).
// ---------------------------------------------------------------------------

const KEY_FILES_FOR_AI = [
	"package.json", "composer.json", "requirements.txt", "pyproject.toml", "Pipfile",
	"Cargo.toml", "go.mod", "build.gradle", "build.gradle.kts", "pom.xml",
	"manage.py", "app.py", "main.py", "wsgi.py", "asgi.py",
	".env.example", ".env",
	"README.md", "README", "readme.md",
	"Gemfile", "hugo.toml", "hugo.yaml", "config.toml", "config.yaml",
	"vite.config.ts", "vite.config.js", "vite.config.mjs",
	"next.config.ts", "next.config.js", "next.config.mjs",
	"astro.config.ts", "astro.config.js", "astro.config.mjs",
	"remix.config.ts", "remix.config.js",
	"nuxt.config.ts", "nuxt.config.js",
	"svelte.config.js", "svelte.config.ts",
	"Dockerfile", "docker-compose.yml", "docker-compose.yaml",
	"Makefile",
];

function listTopLevel(workspacePath: string, limit = 80): string[] {
	try {
		const items = readdirSync(workspacePath, { withFileTypes: true });
		return items.slice(0, limit).map((d) => d.isDirectory() ? `${d.name}/` : d.name);
	} catch { return []; }
}

function buildWorkspaceContext(workspacePath: string): string {
	const tree = listTopLevel(workspacePath).map((e) => `- ${e}`).join("\n");

	const fileSections: string[] = [];
	for (const f of KEY_FILES_FOR_AI) {
		const p = join(workspacePath, f);
		if (!existsSync(p)) continue;
		const content = readText(p).slice(0, 3000);
		if (content) fileSections.push(`=== ${f} ===\n${content}`);
	}

	// "artisan" has no extension — surface it explicitly
	const markers: string[] = [];
	if (existsSync(join(workspacePath, "artisan"))) markers.push("artisan (Laravel root marker)");
	try {
		const entries = readdirSync(workspacePath);
		const csproj = entries.filter((e) => e.endsWith(".csproj") || e.endsWith(".sln"));
		if (csproj.length) markers.push(`${csproj.join(", ")} (.NET project files)`);
		const htmls = entries.filter((e) => e.endsWith(".html"));
		if (htmls.length) markers.push(`${htmls.length} top-level .html file(s): ${htmls.slice(0, 5).join(", ")}`);
	} catch { /* ignore */ }

	return [
		"Top-level entries:",
		tree || "(empty)",
		markers.length ? `\nNotable markers: ${markers.join("; ")}` : "",
		fileSections.length ? "\nKey file contents:\n\n" + fileSections.join("\n\n") : "",
	].filter(Boolean).join("\n");
}

function buildPreviewDetectionPrompt(workspacePath: string, ctx: string): string {
	return `You are detecting how to run a development preview server for a project.

Project workspace: ${workspacePath}

${ctx}

Return a JSON object with these fields:
- projectType: string identifier (e.g., "laravel", "django", "rails", "vite", "nextjs", "cra", "astro", "fastapi", "flask", "spring-boot", "dotnet", "rust-web", "go", "static", "unknown").
- url: the URL where the preview will be served (e.g., "http://127.0.0.1:8000"). For static HTML projects with no build system, use "file:///<absolute-path-to-entry.html>" with forward slashes.
- startCommand: the command to start the dev server. Omit (or set to null) for static file:// projects. For server projects this is required.
- cwd: working directory for the start command. Defaults to the workspace path.
- reasoning: 1-2 sentences explaining the choice.

STRICT RULES — follow exactly, these are non-negotiable:
- Use the OFFICIAL way to run the project. Never a custom shim.
- ALWAYS use 127.0.0.1 (not "localhost") in URLs and bind flags, to avoid IPv4/IPv6 ambiguity on Windows.
- Laravel: startCommand="php artisan serve --host=127.0.0.1 --port=8000", url="http://127.0.0.1:8000". Do NOT use Laragon/XAMPP/Valet virtual hosts — we want the artisan-managed server. If the project has BOTH artisan AND Vite (asset bundling), the answer is still Laravel.
- Django: startCommand="python manage.py runserver 127.0.0.1:8000", url="http://127.0.0.1:8000".
- Rails: startCommand="bundle exec rails server -b 127.0.0.1 -p 3000", url="http://127.0.0.1:3000".
- Flask: startCommand="flask run --host=127.0.0.1 --port=5000", url="http://127.0.0.1:5000".
- FastAPI: startCommand="uvicorn <module>:<app> --host 127.0.0.1 --port 8000 --reload" — substitute the actual module:app from the project (e.g., main:app, app.main:app). url="http://127.0.0.1:8000".
- Spring Boot (Maven): startCommand="mvn spring-boot:run", url="http://127.0.0.1:8080".
- Spring Boot (Gradle): startCommand="gradlew.bat bootRun" on Windows or "./gradlew bootRun" otherwise. url="http://127.0.0.1:8080".
- .NET (ASP.NET Core): startCommand="dotnet run", url="http://127.0.0.1:5000".
- Standalone Vite: startCommand="npm run dev", url="http://127.0.0.1:5173".
- Next.js: startCommand="npm run dev", url="http://127.0.0.1:3000".
- CRA: startCommand="npm start", url="http://127.0.0.1:3000".
- Astro: startCommand="npm run dev", url="http://127.0.0.1:4321".
- SvelteKit: startCommand="npm run dev", url="http://127.0.0.1:5173".
- Remix: startCommand="npm run dev", url="http://127.0.0.1:3000".
- Nuxt: startCommand="npm run dev", url="http://127.0.0.1:3000".
- Go web: startCommand="go run .", url="http://127.0.0.1:8080".
- Rust web (Actix/Axum/Rocket): startCommand="cargo run", url="http://127.0.0.1:8080".
- Hugo: startCommand="hugo server --bind 127.0.0.1 --port 1313", url="http://127.0.0.1:1313".
- Jekyll: startCommand="bundle exec jekyll serve --host 127.0.0.1 --port 4000", url="http://127.0.0.1:4000".
- Static HTML (no build system, no package.json): url="file:///<absolute path to index.html with forward slashes>", no startCommand.
- If you cannot determine how to run it, set projectType="unknown" and explain in reasoning.

Respond with ONLY the JSON object, no markdown fences, no commentary.`;
}

function extractJson(text: string): Record<string, unknown> | null {
	const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
	try { return JSON.parse(cleaned) as Record<string, unknown>; } catch { /* fall through */ }
	const m = cleaned.match(/\{[\s\S]*\}/);
	if (m) {
		try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { /* ignore */ }
	}
	return null;
}

async function detectWithAI(workspacePath: string, providerConfig: ProviderConfig | undefined): Promise<PreviewConfig | null> {
	if (!workspacePath || !existsSync(workspacePath)) return null;
	if (!providerConfig?.apiKey && !providerConfig?.baseUrl) {
		console.warn("[preview] AI detection unavailable — no provider configured");
		return null;
	}

	const ctx    = buildWorkspaceContext(workspacePath);
	const prompt = buildPreviewDetectionPrompt(workspacePath, ctx);

	console.log("[preview] asking AI to detect project (workspace context ~" + ctx.length + " chars)");

	try {
		const adapter = createProviderAdapter(providerConfig);
		const modelId = providerConfig.defaultModel ?? getDefaultModel(providerConfig.providerType);
		const { text } = await generateText({
			model:    adapter.createModel(internalCallModelId(providerConfig.providerType, modelId)),
			messages: [{ role: "user", content: prompt }],
		});

		const json = extractJson(text);
		if (!json || typeof json.projectType !== "string" || typeof json.url !== "string") {
			console.warn("[preview] AI returned unparseable response:", text.slice(0, 300));
			return null;
		}

		const config: PreviewConfig = {
			projectType: json.projectType,
			url:         json.url,
		};
		if (typeof json.startCommand === "string" && json.startCommand.trim()) {
			config.startCommand = json.startCommand.trim();
		}
		config.cwd = typeof json.cwd === "string" && json.cwd.trim() ? json.cwd.trim() : workspacePath;

		const reasoning = typeof json.reasoning === "string" ? json.reasoning : "";
		console.log(`[preview] AI detected: ${config.projectType} @ ${config.url}${config.startCommand ? ` (start: ${config.startCommand})` : ""}`);
		if (reasoning) console.log(`[preview] AI reasoning: ${reasoning}`);

		return config.projectType === "unknown" ? null : config;
	} catch (err) {
		console.error("[preview] AI detection error:", err instanceof Error ? err.message : err);
		return null;
	}
}

function saveConfig(workspacePath: string, config: PreviewConfig): void {
	try {
		const dir = join(workspacePath, ".agentdeskai");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "preview.json"), JSON.stringify(config, null, 2), "utf-8");
	} catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Server health check + start
// ---------------------------------------------------------------------------

// Raw TCP-connect check — the most reliable way to know "is the server
// bound and accepting connections?". Does NOT do an HTTP request. This is
// what we use during startup polling because:
//   • Cold frameworks (Laravel, Spring, Rails) can take 5-10s to respond to
//     the FIRST HTTP request even though the listening socket is open
//     immediately. A TCP handshake completes in <50ms regardless.
//   • Avoids any HTTP-level oddities (keep-alive bugs, CORS preflight,
//     fetch's body decoder choking on the response).
function canConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
		try {
			const sock = createConnection({ host, port });
			const timer = setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } finish(false); }, timeoutMs);
			sock.once("connect", () => { clearTimeout(timer); try { sock.destroy(); } catch { /* ignore */ } finish(true); });
			sock.once("error",   () => { clearTimeout(timer); finish(false); });
		} catch { finish(false); }
	});
}

function tcpProbe(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const u = new URL(url);
		if (u.protocol !== "http:" && u.protocol !== "https:") return Promise.resolve(false);
		const host = u.hostname || "127.0.0.1";
		const port = parseInt(u.port || (u.protocol === "https:" ? "443" : "80"), 10);
		if (!port) return Promise.resolve(false);
		return canConnect(host, port, timeoutMs);
	} catch { return Promise.resolve(false); }
}

// Single fetch with timeout — used for the optional HTTP layer check.
async function probeOnce(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
		return res.status < 500;
	} catch { return false; }
}

// Fast reachability probe — primary check is a TCP handshake (immune to
// slow first HTTP responses). Falls back to an HTTP probe, then a localhost
// → 127.0.0.1 retry, in case the URL is non-HTTP or DNS-only.
async function isReachable(url: string): Promise<boolean> {
	if (await tcpProbe(url)) return true;
	if (await probeOnce(url)) return true;
	if (/\/\/localhost(?::|\/|$)/i.test(url)) {
		const ipv4 = url.replace(/\/\/localhost/i, "//127.0.0.1");
		if (await tcpProbe(ipv4)) return true;
		if (await probeOnce(ipv4)) return true;
	}
	return false;
}

// Refuse to treat AgentDesk's own dev server (or any embedded AgentDesk webview)
// as a valid preview target. Without this, a user previewing a real Vite
// project at :5173 while AgentDesk runs its own :5173 dev server would end up
// loading AgentDesk inside the preview window.
async function AgentDeskMarkerOn(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(1500),
			headers: { Accept: "text/html" },
		});
		const ct = res.headers.get("content-type") ?? "";
		if (!ct.includes("text/html")) return false;
		const body = await res.text();
		const head = body.slice(0, 2048);
		return head.includes('name="x-agentdesk-app"') ||
			head.includes("name='x-agentdesk-app'") ||
			/<title>\s*AgentDesk\s*<\/title>/i.test(head);
	} catch { return false; }
}

async function isAgentDeskItself(url: string): Promise<boolean> {
	if (await AgentDeskMarkerOn(url)) return true;
	if (/\/\/localhost(?::|\/|$)/i.test(url)) {
		const ipv4 = url.replace(/\/\/localhost/i, "//127.0.0.1");
		if (await AgentDeskMarkerOn(ipv4)) return true;
	}
	return false;
}

// One-time validation: is this URL up AND not AgentDesk itself?
// Slower than isReachable because it reads the response body. Use only for
// saved-config checks, fresh-detect verification, and port-scan results —
// NOT inside the polling loop.
async function isUsableTarget(url: string): Promise<boolean> {
	if (!await isReachable(url)) return false;
	if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url)) {
		if (await isAgentDeskItself(url)) return false;
	}
	return true;
}

// Drain a process stream to the console (line-by-line) AND accumulate output
// into a shared buffer so we can include the tail in error messages.
function drainStream(stream: unknown, prefix: string, buffer: { tail: string }): void {
	if (!stream || typeof stream === "number") return;
	(async () => {
		const s = stream as ReadableStream<Uint8Array>;
		const reader  = s.getReader();
		const decoder = new TextDecoder();
		let partial = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				const text = decoder.decode(value, { stream: true });
				buffer.tail = (buffer.tail + text).slice(-2000);
				partial += text;
				let nl: number;
				while ((nl = partial.indexOf("\n")) >= 0) {
					const line = partial.slice(0, nl).replace(/\r$/, "");
					partial = partial.slice(nl + 1);
					if (line) console.log(prefix, line);
				}
			}
			if (partial) console.log(prefix, partial);
		} catch { /* stream closed */ }
	})().catch(() => {});
}

async function startAndWaitForServer(config: PreviewConfig): Promise<string | null> {
	if (!config.startCommand) return null;

	const cwd = config.cwd ?? process.cwd();
	console.log(`[preview] spawning '${config.startCommand}' (cwd: ${cwd})`);

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(config.startCommand.split(" "), {
			cwd,
			// Closing stdin matters — some interpreters (PHP CLI in particular)
			// can hang on startup if stdin is left open without input.
			stdin:  "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// Inherit env so PATH (and Laragon's PHP path additions) propagate.
			env: process.env,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[preview] spawn failed: ${msg}`);
		return `Could not spawn '${config.startCommand}': ${msg}`;
	}

	// Stream the process output to the terminal as it happens — critical for
	// debugging "why didn't my server start?" without guessing. Also keeps a
	// rolling tail of the last 2KB to attach to timeout/exit error messages.
	const captured = { tail: "" };
	drainStream(proc.stdout, "[preview:stdout]", captured);
	drainStream(proc.stderr, "[preview:stderr]", captured);

	// Poll up to ~20s. Most servers bind in <3s. We use a TCP-handshake probe
	// (isReachable) which detects "port open" the instant the listener appears,
	// so this rarely needs the full window.
	const POLL_ITERATIONS = 20;

	for (let i = 0; i < POLL_ITERATIONS; i++) {
		await new Promise((r) => setTimeout(r, 1000));

		if (proc.exitCode !== null) {
			console.warn(`[preview] process exited early (code ${proc.exitCode})`);
			return `Process exited (code ${proc.exitCode}). Output:\n${captured.tail || "(no output)"}`;
		}

		if (await isReachable(config.url)) {
			console.log(`[preview] server reachable at ${config.url} after ${i + 1}s`);
			return null;
		}
	}

	try { proc.kill(); } catch { /* ignore */ }
	console.warn(`[preview] ${config.url} did not respond within ${POLL_ITERATIONS}s (process still running)`);
	return `Server at ${config.url} did not respond within ${POLL_ITERATIONS}s.\nProcess output:\n${captured.tail || "(no output)"}`;
}

// Bring a config "up" — verifies the URL responds (and isn't AgentDesk itself),
// starting the server if needed. Returns true when the URL is a usable target.
async function ensureRunning(config: PreviewConfig): Promise<boolean> {
	if (config.projectType === "static") return true; // file:// — no server needed
	if (await isUsableTarget(config.url)) return true;
	if (config.startCommand) {
		const err = await startAndWaitForServer(config);
		if (err) return false;
		return isUsableTarget(config.url);
	}
	return false;
}


// ---------------------------------------------------------------------------
// Build the annotation-proxy URL for a given raw target URL.
// The proxy bakes the toolbar into the HTML server-side, so it survives refresh.
// ---------------------------------------------------------------------------
function buildPreviewUrl(rawUrl: string, projectId: string, conversationId: string): string {
	const qs = new URLSearchParams({
		url:              rawUrl,
		project:          projectId,
		conv:             conversationId,
		enableAnnotation: "1",
	});
	return `http://localhost:${ANNOTATION_SERVER_PORT}/preview?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// The PM tool
// ---------------------------------------------------------------------------
export function createPreviewTool(
	projectId:      string,
	workspacePath:  string,
	conversationId: string,
	providerConfig: ProviderConfig | undefined,
) {
	return tool({
		description:
			"Open this project in a dedicated AgentDesk preview window with the annotation toolbar active. " +
			"Detects the project type, starts the dev server if needed, opens the window beside the main app. " +
			"The toolbar is baked into the proxied page so it survives refresh and navigation. " +
			"Always use this tool when the user runs /preview.",
		inputSchema: z.object({}),

		execute: async (): Promise<{
			success: boolean;
			projectType?: string;
			url?: string;
			previewUrl?: string;
			savedConfig?: boolean;
			error?: string;
			diagnostic?: string;
		}> => {
			// ── 1. Resolve config: saved (fast) → AI detection (first time) ─
			// Saved config wins when it responds. If it doesn't respond, we
			// invalidate it and let AI re-derive. AI sees the workspace top
			// level + key file contents and returns {projectType, url,
			// startCommand, cwd}. Once saved, subsequent /preview calls skip AI.
			let config: PreviewConfig | null = null;
			let needsSave = false;
			let diagnostic = "";

			const t0 = Date.now();
			console.log(`[preview] /preview triggered (workspace: ${workspacePath || "(none)"})`);

			const saved = loadSavedConfig(workspacePath);
			if (saved) {
				if (await ensureRunning(saved)) {
					config = saved;
					diagnostic = "Using saved config from .agentdeskai/preview.json";
					console.log(`[preview] saved config OK: ${saved.projectType} @ ${saved.url}`);
				} else {
					invalidateSavedConfig(workspacePath);
					diagnostic = "Saved config was unreachable — asking AI to re-detect. ";
					console.log(`[preview] saved config unreachable, invalidated`);
				}
			}

			if (!config) {
				const detected = await detectWithAI(workspacePath, providerConfig);
				if (!detected) {
					return {
						success: false,
						error: (diagnostic ? diagnostic + " " : "") +
							"AI could not determine how to run this project. " +
							"Either start your server manually, or create .agentdeskai/preview.json with " +
							`{projectType, url, startCommand, cwd}. ` +
							(!providerConfig?.apiKey ? "Hint: configure an AI provider in Settings first." : ""),
					};
				}

				if (await ensureRunning(detected)) {
					config = detected;
					needsSave = true;
					diagnostic += `AI detected ${detected.projectType}.`;
				} else {
					return {
						success: false,
						url:     detected.url,
						error:   (diagnostic ? diagnostic + " " : "") +
							`AI detected ${detected.projectType} (${detected.url}) but it did not respond` +
							(detected.startCommand ? ` after running '${detected.startCommand}'. Check the terminal for [preview:stdout/stderr] output.` : "."),
					};
				}
			}

			if (needsSave) saveConfig(workspacePath, config);
			console.log(`[preview] resolved in ${Date.now() - t0}ms → ${config.projectType} @ ${config.url}`);

			// ── 2. Build proxy URL (toolbar baked in by annotation server) ─
			const previewUrl = buildPreviewUrl(config.url, projectId, conversationId);

			// ── 3. Open / reuse the internal preview window ───────────────
			let channel = "stable";
			try { channel = await Updater.localInfo.channel(); } catch { /* default to stable */ }
			try {
				await openPreviewWindow({
					proxyUrl:       previewUrl,
					rawUrl:         config.url,
					title:          "AgentDesk Preview",
					projectId,
					conversationId,
					workspacePath,
					projectType:    config.projectType,
					devMode:        channel === "dev",
				});
			} catch (err) {
				return {
					success:    false,
					url:        config.url,
					previewUrl,
					error:      `Could not open preview window: ${err instanceof Error ? err.message : String(err)}`,
				};
			}

			// ── 4. Return result ──────────────────────────────────────────
			return {
				success:     true,
				projectType: config.projectType,
				url:         config.url,
				previewUrl,
				savedConfig: needsSave,
				diagnostic,
			};
		},
	});
}
