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

// Abortable delay — a plain setTimeout would keep the process waiting out a
// backoff even after the caller's run was cancelled (30-min run timeout,
// user abort, etc). Resolves early (without throwing) if the signal fires,
// so the retry loop's own "did we get cancelled" check still applies next.
function delay(ms: number, abortSignal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		abortSignal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
	});
}

// Retryable: network failures and transient server-side conditions (429 rate
// limit, 5xx). NOT retryable: 4xx client errors like 401/403/400 — retrying
// an invalid key or malformed request just wastes the budget and delays
// falling through to the next engine. Up to 2 retries (3 attempts total),
// exponential backoff with jitter so concurrent callers don't all retry in
// lockstep and re-trigger the same rate limit together.
async function fetchWithRetry(
	doFetch: () => Promise<Response>,
	opts: { maxRetries?: number; baseDelayMs?: number; abortSignal?: AbortSignal } = {},
): Promise<Response> {
	const { maxRetries = 2, baseDelayMs = 500, abortSignal } = opts;
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await doFetch();
			const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
			if (!retryable || attempt === maxRetries || abortSignal?.aborted) return response;
		} catch (err) {
			if (attempt === maxRetries || abortSignal?.aborted) throw err;
		}
		const backoff = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
		await delay(backoff, abortSignal);
	}
}

// ---------------------------------------------------------------------------
// Date-range helpers — shared by all three search engines. `range` is a
// rolling window from *today* (day/week/month/year), NOT a calendar period —
// callers wanting "this year" or "last N months" should compute exact
// start/end dates themselves and pass those instead.
// ---------------------------------------------------------------------------

export interface DateRangeOpts {
	range?: "day" | "week" | "month" | "year";
	startDate?: string; // YYYY-MM-DD
	endDate?: string; // YYYY-MM-DD
}

const RANGE_TO_DAYS: Record<NonNullable<DateRangeOpts["range"]>, number> = { day: 1, week: 7, month: 30, year: 365 };

function exaDateParams(opts: DateRangeOpts): { startPublishedDate?: string; endPublishedDate?: string } {
	if (opts.startDate || opts.endDate) {
		return {
			...(opts.startDate ? { startPublishedDate: `${opts.startDate}T00:00:00.000Z` } : {}),
			...(opts.endDate ? { endPublishedDate: `${opts.endDate}T23:59:59.999Z` } : {}),
		};
	}
	if (opts.range) {
		return { startPublishedDate: new Date(Date.now() - RANGE_TO_DAYS[opts.range] * 86_400_000).toISOString() };
	}
	return {};
}

function tavilyDateParams(opts: DateRangeOpts): { start_date?: string; end_date?: string; time_range?: string } {
	if (opts.startDate || opts.endDate) {
		return { ...(opts.startDate ? { start_date: opts.startDate } : {}), ...(opts.endDate ? { end_date: opts.endDate } : {}) };
	}
	if (opts.range) return { time_range: opts.range };
	return {};
}

const DDG_RANGE_CODE: Record<NonNullable<DateRangeOpts["range"]>, string> = { day: "d", week: "w", month: "m", year: "y" };

function ddgDateFilter(opts: DateRangeOpts): string | undefined {
	if (opts.startDate && opts.endDate) return `${opts.startDate}..${opts.endDate}`;
	if (opts.range) return DDG_RANGE_CODE[opts.range];
	return undefined;
}

// ---------------------------------------------------------------------------
// SSRF guard — deep_research fetches whatever URLs a search engine returns,
// in bulk, with no human reviewing each link first (unlike an agent manually
// picking one URL for web_fetch). Block obvious internal/private targets so
// a malicious or compromised page indexed by a search engine can't be used
// to reach loopback/private/link-local/cloud-metadata addresses. This is a
// pragmatic hostname/scheme check, not a DNS-resolution-based one (no
// protection against DNS rebinding) — proportionate for "engine-returned
// URLs", not a hardened SSRF gateway for arbitrary user-supplied input.
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAME_PATTERNS = [
	/^localhost$/i,
	/^127\./, /^0\.0\.0\.0$/, /^::1$/,
	/^10\./, /^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^169\.254\./, // link-local, includes the 169.254.169.254 cloud metadata endpoint
	/^metadata\.google\.internal$/i,
	/^\[::1\]$/,
];

function isBlockedUrl(url: string): boolean {
	let parsed: URL;
	try { parsed = new URL(url); } catch { return true; }
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
	const hostname = parsed.hostname;
	return BLOCKED_HOSTNAME_PATTERNS.some((p) => p.test(hostname));
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
	dateRangeOpts: DateRangeOpts = {},
): Promise<SearchResult> {
	const df = ddgDateFilter(dateRangeOpts);
	const response = await fetchWithRetry(
		() => fetch("https://html.duckduckgo.com/html/", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			},
			body: new URLSearchParams({ q: query, kl: "us-en", ...(df ? { df } : {}) }),
			signal: withTimeout(abortSignal, 15_000),
		}),
		{ abortSignal },
	);

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
	dateRangeOpts: DateRangeOpts = {},
): Promise<SearchResult> {
	const response = await fetchWithRetry(
		() => fetch("https://api.tavily.com/search", {
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
				...tavilyDateParams(dateRangeOpts),
			}),
			signal: withTimeout(abortSignal, 30_000),
		}),
		{ abortSignal },
	);

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
	dateRangeOpts: DateRangeOpts = {},
): Promise<SearchResult> {
	const response = await fetchWithRetry(
		() => fetch("https://api.exa.ai/search", {
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
				...exaDateParams(dateRangeOpts),
			}),
			signal: withTimeout(abortSignal, 15_000),
		}),
		{ abortSignal },
	);

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
		"Use this to research errors, find packages, or look up documentation — including code, " +
		"library, and API questions. Prefer this over deep_research for anything that's a quick " +
		"lookup rather than a genuinely broad research question.",
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
		dateRange: z
			.enum(["day", "week", "month", "year"])
			.optional()
			.describe(
				"Restrict results to this ROLLING window from today (e.g. 'week' = last 7 days). " +
				"Not a calendar period — for 'this year', 'last 6 months', or any other exact span, " +
				"use startDate/endDate instead (compute them from today's date, given in your system prompt).",
			),
		startDate: z.string().optional().describe("YYYY-MM-DD. Exact range start — use with endDate. Overrides dateRange if both are given."),
		endDate: z.string().optional().describe("YYYY-MM-DD. Exact range end — use with startDate."),
	}),
	execute: async ({ query, maxResults = 10, dateRange, startDate, endDate }, { abortSignal }): Promise<string> => {
		const dateRangeOpts: DateRangeOpts = { range: dateRange, startDate, endDate };
		const [exaKey, tavilyKey] = await Promise.all([
			getIntegrationKey("exa_api_key"),
			getIntegrationKey("tavily_api_key"),
		]);

		const engines: Array<{ name: EngineName; run: () => Promise<SearchResult> }> = [];
		if (exaKey) engines.push({ name: "exa", run: () => exaSearch(query, exaKey, maxResults, abortSignal, dateRangeOpts) });
		if (tavilyKey) engines.push({ name: "tavily", run: () => tavilySearch(query, tavilyKey, maxResults, abortSignal, dateRangeOpts) });
		engines.push({ name: "duckduckgo", run: () => ddgSearch(query, maxResults, abortSignal, dateRangeOpts) });

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

export interface FetchedPage {
	url: string;
	ok: boolean;
	status: number;
	contentType: string;
	text: string;
	truncated: boolean;
	error?: string;
}

// Shared by web_fetch and deep_research. Unlike the search engine helpers,
// this never throws — a caller reading many URLs (deep_research fetches up
// to a dozen in parallel) needs to keep going past individual failures, not
// have one bad URL abort the whole batch.
export async function fetchPageText(
	url: string,
	opts: { abortSignal?: AbortSignal; timeoutMs?: number; maxChars?: number; headers?: Record<string, string> } = {},
): Promise<FetchedPage> {
	const { abortSignal, timeoutMs = 15_000, maxChars = MAX_FETCH_CHARS, headers } = opts;
	if (isBlockedUrl(url)) {
		return { url, ok: false, status: 0, contentType: "", text: "", truncated: false, error: "Refused to fetch a non-http(s) or internal/private URL." };
	}
	try {
		const response = await fetchWithRetry(
			() => fetch(url, {
				redirect: "follow",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					...headers,
				},
				signal: withTimeout(abortSignal, timeoutMs),
			}),
			{ abortSignal },
		);

		const contentType = response.headers.get("content-type") ?? "";

		if (!response.ok) {
			return { url, ok: false, status: response.status, contentType, text: "", truncated: false, error: `HTTP ${response.status} ${response.statusText}` };
		}

		if (
			!contentType.includes("text") &&
			!contentType.includes("json") &&
			!contentType.includes("xml") &&
			!contentType.includes("javascript")
		) {
			return { url, ok: false, status: response.status, contentType, text: "", truncated: false, error: `Non-text content type: ${contentType}` };
		}

		const raw = await response.text();
		const text = contentType.includes("html") ? stripHtml(raw) : raw;
		const truncated = text.length > maxChars;
		const body = truncated ? text.slice(0, maxChars) + `\n... (truncated at ${maxChars} chars)` : text;

		return { url, ok: true, status: response.status, contentType, text: body, truncated };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const hint = msg.includes("redirect") ? " Try providing the final URL directly." : "";
		return { url, ok: false, status: 0, contentType: "", text: "", truncated: false, error: msg + hint };
	}
}

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
		const page = await fetchPageText(url, { abortSignal, timeoutMs: timeout, headers });
		if (!page.ok) {
			return JSON.stringify({ error: page.error, url, ...(page.status ? { status: page.status } : {}) });
		}
		return JSON.stringify({
			url,
			status: page.status,
			contentType: page.contentType,
			truncated: page.truncated,
			body: page.text,
		});
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
