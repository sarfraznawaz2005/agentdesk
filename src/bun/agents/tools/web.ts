import { tool } from "ai";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { parse as parseHtml } from "node-html-parser";
import { db } from "../../db";
import { settings } from "../../db/schema";
import type { ToolRegistryEntry } from "./index";

// ---------------------------------------------------------------------------
// Settings helper
// ---------------------------------------------------------------------------

async function getIntegrationKey(key: string): Promise<string | null> {
	const rows = await db
		.select()
		.from(settings)
		.where(and(eq(settings.key, key), eq(settings.category, "integrations")));
	if (rows.length === 0) return null;
	try { return JSON.parse(rows[0].value); } catch { return rows[0].value; }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
	const root = parseHtml(html);
	// Remove script and style blocks — their text content is not human-readable
	root.querySelectorAll("script, style").forEach((el) => el.remove());
	return root.textContent.replace(/\s+/g, " ").trim();
}

// Agent tool calls always receive a real (non-null) abortSignal from the AI
// SDK — it's the run's overall guardrail (30 min timeout / stuck-loop / user
// abort), not a per-request timeout. A plain `abortSignal ?? AbortSignal.timeout(ms)`
// therefore never falls through to the intended short timeout, so a silently
// dropped connection hangs until the OS's own TCP timeout (e.g. ~21s on
// Windows for a black-holed host) instead of failing fast. Combine both so
// whichever fires first wins.
function withTimeout(abortSignal: AbortSignal | undefined, ms: number): AbortSignal {
	return abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

// Thrown by each engine helper on any failure (rate limit, auth, network,
// empty parse). Carries which engine failed and why, so the fallback loop in
// webSearchTool can log a reason per engine and try the next one instead of
// having to re-parse an error-shaped JSON string.
export class SearchEngineError extends Error {
	constructor(public readonly engine: "exa" | "tavily" | "duckduckgo", message: string) {
		super(message);
		this.name = "SearchEngineError";
	}
}

interface SearchResult {
	query: string;
	answer?: string | null;
	results: Array<{ title: string; url: string; snippet: string }>;
}

export async function ddgSearch(
	query: string,
	maxResults: number,
	abortSignal?: AbortSignal,
): Promise<SearchResult> {
	const response = await fetch("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
		body: new URLSearchParams({ q: query, kl: "us-en" }),
		signal: withTimeout(abortSignal, 15_000),
	});

	if (!response.ok) {
		throw new SearchEngineError("duckduckgo", `DuckDuckGo returned HTTP ${response.status}`);
	}

	const html = await response.text();
	const results: Array<{ title: string; url: string; snippet: string }> = [];

	// Each organic result has: result__a (title+redirect href), result__url (display url), result__snippet
	const blocks = html.matchAll(
		/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__url"[^>]*>\s*([\s\S]*?)\s*<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g,
	);

	for (const match of blocks) {
		if (results.length >= maxResults) break;
		const [, titleHtml, urlText, snippetHtml] = match;
		const url = stripHtml(urlText);
		if (!url) continue;
		results.push({
			title: stripHtml(titleHtml),
			url: url.startsWith("http") ? url : `https://${url}`,
			snippet: stripHtml(snippetHtml),
		});
	}

	if (results.length === 0) {
		throw new SearchEngineError(
			"duckduckgo",
			"No results parsed — DuckDuckGo may have changed its HTML structure or blocked the request",
		);
	}

	return { query, results };
}

export async function tavilySearch(
	query: string,
	apiKey: string,
	maxResults: number,
	abortSignal?: AbortSignal,
): Promise<SearchResult> {
	const response = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			api_key: apiKey,
			query,
			search_depth: "advanced",
			// Tavily's API accepts up to 20 results; clamp to its ceiling so we
			// honour the caller's request across the tool's 1–25 range without
			// sending an out-of-range value.
			max_results: Math.min(maxResults, 20),
			include_answer: true,
			include_raw_content: false,
		}),
		signal: withTimeout(abortSignal, 30_000),
	});

	if (response.status === 401) {
		throw new SearchEngineError(
			"tavily",
			"Invalid Tavily API key. Update it in Settings → Integrations → Search.",
		);
	}
	if (response.status === 429) {
		throw new SearchEngineError("tavily", "Tavily API rate limit reached.");
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new SearchEngineError("tavily", `Tavily API error ${response.status}: ${body}`);
	}

	const data = await response.json() as {
		answer?: string;
		results: Array<{ title: string; url: string; content: string; score: number }>;
	};

	return {
		query,
		answer: data.answer ?? null,
		results: data.results.map((r) => ({
			title: r.title,
			url: r.url,
			snippet: r.content,
		})),
	};
}

export async function exaSearch(
	query: string,
	apiKey: string,
	maxResults: number,
	abortSignal?: AbortSignal,
): Promise<SearchResult> {
	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": apiKey },
		body: JSON.stringify({
			query,
			// "auto" (~1s) keeps this a quick lookup call, not a research-grade
			// job — "deep"/"deep-reasoning" are a separate, separately-billed
			// product we deliberately never request here.
			type: "auto",
			numResults: maxResults,
			// `text` (compact, capped at 1000 chars) reads as continuous prose —
			// `highlights` was tried first but returns disjointed, "..."-joined
			// fragments that are harder for an agent to parse than a clean excerpt.
			contents: { text: { maxCharacters: 1000, verbosity: "compact" } },
		}),
		signal: withTimeout(abortSignal, 15_000),
	});

	if (response.status === 401 || response.status === 403) {
		throw new SearchEngineError(
			"exa",
			"Invalid Exa API key. Update it in Settings → Integrations → Search.",
		);
	}
	if (response.status === 429) {
		throw new SearchEngineError("exa", "Exa API rate limit reached.");
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new SearchEngineError("exa", `Exa API error ${response.status}: ${body}`);
	}

	const data = await response.json() as {
		results: Array<{ title: string | null; url: string; text?: string }>;
	};

	return {
		query,
		results: data.results.map((r) => ({
			title: r.title ?? "",
			url: r.url,
			snippet: r.text ?? "",
		})),
	};
}

// ---------------------------------------------------------------------------
// web_search — Exa → Tavily → DuckDuckGo, first available engine wins
// ---------------------------------------------------------------------------

type EngineName = "exa" | "tavily" | "duckduckgo";

const webSearchTool = tool({
	description:
		"Search the web. Routes through Exa when a key is configured in Settings → " +
		"Integrations → Search (neural search built for agents, token-efficient results), " +
		"falling back to Tavily if a Tavily key is configured and Exa is unavailable or " +
		"rate-limited, and finally to DuckDuckGo (no key required) if neither is configured or " +
		"both fail. The fallback is automatic — always call this single tool. " +
		"Use this to research errors, find packages, or look up documentation.",
	inputSchema: z.object({
		query: z.string().describe("The search query"),
		maxResults: z
			.number()
			.int()
			.min(1)
			.max(25)
			.optional()
			.describe(
				"Maximum number of results to return (default: 10). " +
				"Note: the Tavily backend caps this at 20; Exa and DuckDuckGo honour the full range.",
			),
	}),
	execute: async ({ query, maxResults = 10 }, { abortSignal }): Promise<string> => {
		const [exaKey, tavilyKey] = await Promise.all([
			getIntegrationKey("exa_api_key"),
			getIntegrationKey("tavily_api_key"),
		]);

		const engines: Array<{ name: EngineName; run: () => Promise<SearchResult> }> = [];
		if (exaKey) engines.push({ name: "exa", run: () => exaSearch(query, exaKey, maxResults, abortSignal) });
		if (tavilyKey) engines.push({ name: "tavily", run: () => tavilySearch(query, tavilyKey, maxResults, abortSignal) });
		engines.push({ name: "duckduckgo", run: () => ddgSearch(query, maxResults, abortSignal) });

		const failures: Array<{ engine: EngineName; reason: string }> = [];
		for (const engine of engines) {
			try {
				const result = await engine.run();
				return JSON.stringify({ ...result, engine: engine.name });
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				failures.push({ engine: engine.name, reason });
			}
		}

		return JSON.stringify({ error: "All search engines failed", details: failures });
	},
});

// ---------------------------------------------------------------------------
// web_fetch — Fetch a URL and return its text content
// ---------------------------------------------------------------------------

const MAX_FETCH_CHARS = 15_000; // 15 000 characters of plain text per page

const webFetchTool = tool({
	description:
		"Fetch the text content of a URL. Returns the response body as a string (HTML stripped to plain text, JSON, etc.). " +
		"Useful for reading documentation, API specs, or any public URL. Response is truncated at 15 000 characters.",
	inputSchema: z.object({
		url: z.string().url().describe("The URL to fetch"),
		headers: z
			.record(z.string())
			.optional()
			.describe("Optional HTTP headers to include in the request"),
		timeout: z
			.number()
			.int()
			.optional()
			.describe("Request timeout in milliseconds (default: 15000)"),
	}),
	execute: async ({ url, headers, timeout = 15_000 }, { abortSignal }): Promise<string> => {
		try {
			const response = await fetch(url, {
				redirect: "follow",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					...headers,
				},
				signal: withTimeout(abortSignal, timeout),
			});

			const contentType = response.headers.get("content-type") ?? "";
			const statusLine = `HTTP ${response.status} ${response.statusText}`;

			if (!response.ok) {
				return JSON.stringify({ error: statusLine, url });
			}

			// Only decode text-based responses
			if (
				!contentType.includes("text") &&
				!contentType.includes("json") &&
				!contentType.includes("xml") &&
				!contentType.includes("javascript")
			) {
				return JSON.stringify({
					error: `Non-text content type: ${contentType}`,
					status: response.status,
					url,
				});
			}

			const raw = await response.text();
			const text = contentType.includes("html") ? stripHtml(raw) : raw;
			const truncated = text.length > MAX_FETCH_CHARS;
			const body = truncated
				? text.slice(0, MAX_FETCH_CHARS) + `\n... (truncated at ${MAX_FETCH_CHARS} chars)`
				: text;

			return JSON.stringify({
				url,
				status: response.status,
				contentType,
				truncated,
				body,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const hint = msg.includes("redirect") ? " Try providing the final URL directly." : "";
			return JSON.stringify({ error: msg + hint, url });
		}
	},
});

// ---------------------------------------------------------------------------
// http_request — Arbitrary HTTP requests (for API testing)
// ---------------------------------------------------------------------------

const httpRequestTool = tool({
	description:
		"Make an HTTP request with full control over method, headers, and body. " +
		"Use this to test APIs you have built, call webhooks, or interact with external services. " +
		"Returns status code, response headers, and body.",
	inputSchema: z.object({
		url: z.string().url().describe("The request URL"),
		method: z
			.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
			.optional()
			.describe("HTTP method (default: GET)"),
		headers: z
			.record(z.string())
			.optional()
			.describe("HTTP headers to include"),
		body: z
			.string()
			.optional()
			.describe(
				"Request body as a string. For JSON APIs pass a JSON string and set Content-Type: application/json",
			),
		timeout: z
			.number()
			.int()
			.optional()
			.describe("Request timeout in milliseconds (default: 30000)"),
	}),
	execute: async (
		{ url, method = "GET", headers, body, timeout = 30_000 },
		{ abortSignal },
	): Promise<string> => {
		try {
			const response = await fetch(url, {
				method,
				headers,
				body: body !== undefined ? body : undefined,
				signal: withTimeout(abortSignal, timeout),
			});

			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				responseHeaders[key] = value;
			});

			const contentType = response.headers.get("content-type") ?? "";
			let responseBody: string;

			if (
				contentType.includes("text") ||
				contentType.includes("json") ||
				contentType.includes("xml") ||
				contentType.includes("javascript")
			) {
				const text = await response.text();
				responseBody = text.length > MAX_FETCH_CHARS
					? text.slice(0, MAX_FETCH_CHARS) + `\n... (truncated at ${MAX_FETCH_CHARS} chars)`
					: text;
			} else {
				responseBody = `(binary content, content-type: ${contentType})`;
			}

			return JSON.stringify({
				url,
				method,
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
				body: responseBody,
			});
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err), url, method });
		}
	},
});

// ---------------------------------------------------------------------------
// Exported tool registry
// ---------------------------------------------------------------------------

export const webTools: Record<string, ToolRegistryEntry> = {
	web_search: { tool: webSearchTool, category: "web" },
	web_fetch: { tool: webFetchTool, category: "web" },
	http_request: { tool: httpRequestTool, category: "web" },
};
