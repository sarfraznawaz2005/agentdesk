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

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

async function ddgSearch(
	query: string,
	maxResults: number,
	abortSignal?: AbortSignal,
): Promise<string> {
	const response = await fetch("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
		body: new URLSearchParams({ q: query, kl: "us-en" }),
		signal: abortSignal ?? AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		return JSON.stringify({ error: `DuckDuckGo returned HTTP ${response.status}` });
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
		return JSON.stringify({
			error: "No results parsed — DuckDuckGo may have changed its HTML structure or blocked the request",
		});
	}

	return JSON.stringify({ query, results });
}

async function tavilySearch(
	query: string,
	apiKey: string,
	maxResults: number,
	abortSignal?: AbortSignal,
): Promise<string> {
	const response = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			api_key: apiKey,
			query,
			search_depth: "advanced",
			max_results: Math.min(maxResults, 10),
			include_answer: true,
			include_raw_content: false,
		}),
		signal: abortSignal ?? AbortSignal.timeout(30_000),
	});

	if (response.status === 401) {
		return JSON.stringify({
			error: "Invalid Tavily API key. Update it in Settings → Integrations → Tavily.",
		});
	}
	if (response.status === 429) {
		return JSON.stringify({
			error: "Tavily API rate limit reached. Try again shortly.",
		});
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		return JSON.stringify({ error: `Tavily API error ${response.status}: ${body}` });
	}

	const data = await response.json() as {
		answer?: string;
		results: Array<{ title: string; url: string; content: string; score: number }>;
	};

	return JSON.stringify({
		query,
		answer: data.answer ?? null,
		results: data.results.map((r) => ({
			title: r.title,
			url: r.url,
			content: r.content,
			score: r.score,
		})),
	});
}

// ---------------------------------------------------------------------------
// web_search — Tavily (if configured) with DuckDuckGo fallback
// ---------------------------------------------------------------------------

const webSearchTool = tool({
	description:
		"Search the web. Uses Tavily API if configured in Settings → Integrations (higher quality, structured results). " +
		"Falls back to DuckDuckGo when no Tavily key is set (no API key required). " +
		"Use this to research errors, find packages, or look up documentation.",
	inputSchema: z.object({
		query: z.string().describe("The search query"),
		maxResults: z
			.number()
			.int()
			.min(1)
			.max(25)
			.optional()
			.describe("Maximum number of results to return (default: 10)"),
	}),
	execute: async ({ query, maxResults = 10 }, { abortSignal }): Promise<string> => {
		try {
			const tavilyKey = await getIntegrationKey("tavily_api_key");
			if (tavilyKey) {
				return tavilySearch(query, tavilyKey, maxResults, abortSignal);
			}
			return ddgSearch(query, maxResults, abortSignal);
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
		}
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
				signal: abortSignal ?? AbortSignal.timeout(timeout),
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
				signal: abortSignal ?? AbortSignal.timeout(timeout),
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
// enhanced_web_search — Tavily API (requires API key in settings)
// ---------------------------------------------------------------------------

const enhancedWebSearchTool = tool({
	description:
		"Perform a high-quality web search using the Tavily API with advanced search depth. " +
		"Returns titles, URLs, content snippets, relevance scores, and a synthesised answer. " +
		"Much more accurate than basic DuckDuckGo search for research-heavy tasks. " +
		"Requires a Tavily API key configured in Settings → Integrations → Tavily.",
	inputSchema: z.object({
		query: z.string().describe("The search query"),
		maxResults: z
			.number()
			.int()
			.min(1)
			.max(10)
			.optional()
			.describe("Maximum number of results to return (default: 5)"),
	}),
	execute: async ({ query, maxResults = 5 }, { abortSignal }): Promise<string> => {
		const apiKey = await getIntegrationKey("tavily_api_key");

		if (!apiKey) {
			return JSON.stringify({
				error:
					"Tavily API key not configured. " +
					"Go to Settings → Integrations → Tavily and add your API key. " +
					"You can get a free key at tavily.com (1,000 searches/month free). " +
					"Alternatively, use the web_search tool which falls back to DuckDuckGo.",
			});
		}

		try {
			return tavilySearch(query, apiKey, maxResults, abortSignal);
		} catch (err) {
			return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
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
	enhanced_web_search: { tool: enhancedWebSearchTool, category: "web" },
};
