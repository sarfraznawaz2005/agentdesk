/**
 * tests/agents/web-search.test.ts
 *
 * Fetch-mocked fallback matrix for the web_search tool's engine ordering:
 * Exa -> Tavily -> DuckDuckGo, first configured/available engine wins.
 */

import { mock, describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createTestDb, type TestDb } from "../helpers/db";

// The db mock is resolved once, on the first dynamic import of a module that
// transitively imports "../../db" below — so a single shared instance is
// created here and its rows are cleared per-test, rather than recreating the
// database per test (which would leave the cached module bound to a closed
// sqlite handle).
const testDbInstance: TestDb = createTestDb();

mock.module("../../src/bun/db", () => ({ db: testDbInstance.db }));

const DDG_HTML = `
  <a class="result__a" href="//duckduckgo.com/l/?uddg=x">DDG Result Title</a>
  <a class="result__url" href="https://example.com">example.com</a>
  <a class="result__snippet">A duckduckgo snippet.</a>
`;

const TAVILY_BODY = JSON.stringify({
	answer: "The tavily answer",
	results: [{ title: "Tavily Result", url: "https://tavily.example.com", content: "Tavily snippet", score: 0.9 }],
});

const EXA_BODY = JSON.stringify({
	results: [{ title: "Exa Result", url: "https://exa.example.com", text: "Exa snippet" }],
});

function jsonResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function htmlResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

/** Queues one Response per call, matched strictly in call order. */
function queueFetch(responses: Response[]): void {
	let call = 0;
	globalThis.fetch = mock(async () => {
		const response = responses[call];
		call++;
		if (!response) throw new Error(`Unexpected extra fetch call (#${call})`);
		return response;
	}) as unknown as typeof fetch;
}

/** Same as queueFetch, but also records each call's (url, init) for inspection. */
function queueFetchCapturing(responses: Response[]): Array<[string, RequestInit | undefined]> {
	const calls: Array<[string, RequestInit | undefined]> = [];
	let call = 0;
	globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
		calls.push([url, init]);
		const response = responses[call];
		call++;
		if (!response) throw new Error(`Unexpected extra fetch call (#${call})`);
		return response;
	}) as unknown as typeof fetch;
	return calls;
}

async function saveIntegrationKey(db: TestDb["db"], key: string, value: string): Promise<void> {
	const { settings } = await import("../../src/bun/db/schema");
	await db.insert(settings).values({
		id: crypto.randomUUID(),
		key,
		value: JSON.stringify(value),
		category: "integrations",
	});
}

describe("web_search fallback matrix", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(async () => {
		const { settings } = await import("../../src/bun/db/schema");
		await testDbInstance.db.delete(settings);
		globalThis.fetch = originalFetch;
	});

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	it("no keys configured -> routes to duckduckgo", async () => {
		queueFetch([htmlResponse(DDG_HTML)]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "1", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.engine).toBe("duckduckgo");
		expect(parsed.results[0].title).toBe("DDG Result Title");
	});

	it("valid Tavily key (no Exa key) -> routes to tavily", async () => {
		await saveIntegrationKey(testDbInstance.db, "tavily_api_key", "tvly-valid");
		queueFetch([jsonResponse(TAVILY_BODY)]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "2", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.engine).toBe("tavily");
		expect(parsed.answer).toBe("The tavily answer");
		expect(parsed.results[0].title).toBe("Tavily Result");
	});

	it("only Exa key -> routes to exa", async () => {
		await saveIntegrationKey(testDbInstance.db, "exa_api_key", "exa-valid");
		queueFetch([jsonResponse(EXA_BODY)]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "3", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.engine).toBe("exa");
		expect(parsed.results[0].title).toBe("Exa Result");
	});

	it("Exa rate-limited, Tavily configured -> falls back to tavily (after Exa's 3 retry attempts)", async () => {
		await saveIntegrationKey(testDbInstance.db, "exa_api_key", "exa-valid");
		await saveIntegrationKey(testDbInstance.db, "tavily_api_key", "tvly-valid");
		// 429 is retryable — fetchWithRetry makes up to 3 attempts (1 + 2 retries)
		// per engine before giving up and falling through to the next one.
		queueFetch([
			jsonResponse("rate limited", 429),
			jsonResponse("rate limited", 429),
			jsonResponse("rate limited", 429),
			jsonResponse(TAVILY_BODY),
		]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "4", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.engine).toBe("tavily");
		expect(parsed.results[0].title).toBe("Tavily Result");
	}, 15_000);

	it("Exa and Tavily both rate-limited -> falls back to duckduckgo (after both exhaust retries)", async () => {
		await saveIntegrationKey(testDbInstance.db, "exa_api_key", "exa-valid");
		await saveIntegrationKey(testDbInstance.db, "tavily_api_key", "tvly-valid");
		queueFetch([
			jsonResponse("rate limited", 429), jsonResponse("rate limited", 429), jsonResponse("rate limited", 429), // exa x3
			jsonResponse("rate limited", 429), jsonResponse("rate limited", 429), jsonResponse("rate limited", 429), // tavily x3
			htmlResponse(DDG_HTML),
		]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "5", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.engine).toBe("duckduckgo");
		expect(parsed.results[0].title).toBe("DDG Result Title");
	}, 20_000);

	it("all engines fail -> returns an aggregated error", async () => {
		await saveIntegrationKey(testDbInstance.db, "exa_api_key", "exa-valid");
		await saveIntegrationKey(testDbInstance.db, "tavily_api_key", "tvly-valid");
		// DuckDuckGo's failure here is a 200 OK with unparseable content (not a
		// retryable HTTP status), so it only needs one queued response.
		queueFetch([
			jsonResponse("rate limited", 429), jsonResponse("rate limited", 429), jsonResponse("rate limited", 429), // exa x3
			jsonResponse("rate limited", 429), jsonResponse("rate limited", 429), jsonResponse("rate limited", 429), // tavily x3
			htmlResponse("<html>no results</html>"),
		]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "6", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.error).toBe("All search engines failed");
		expect(parsed.details).toHaveLength(3);
		expect(parsed.details.map((d: { engine: string }) => d.engine)).toEqual(["exa", "tavily", "duckduckgo"]);
	}, 20_000);

	it("Exa returns zero results -> treated as a valid (empty) answer, not a fallback trigger", async () => {
		// Unlike DuckDuckGo's HTML scrape (where zero parsed results is ambiguous
		// with a blocked/changed page), Exa is a structured JSON API like Tavily
		// — a genuinely empty result set is a real answer, not a failure signal.
		await saveIntegrationKey(testDbInstance.db, "exa_api_key", "exa-valid");
		queueFetch([jsonResponse(JSON.stringify({ results: [] }))]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "7", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.engine).toBe("exa");
		expect(parsed.results).toEqual([]);
	});

	it("Exa returns a transient 500 once, then succeeds -> retry recovers, no fallback needed", async () => {
		await saveIntegrationKey(testDbInstance.db, "exa_api_key", "exa-valid");
		queueFetch([jsonResponse("server error", 500), jsonResponse(EXA_BODY)]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "8", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		// Recovered via retry — engine is still "exa", not a fallback to a lower tier.
		expect(parsed.engine).toBe("exa");
		expect(parsed.results[0].title).toBe("Exa Result");
	}, 10_000);

	it("Exa returns 401 (invalid key) -> falls back immediately, no wasted retries", async () => {
		await saveIntegrationKey(testDbInstance.db, "exa_api_key", "exa-invalid");
		await saveIntegrationKey(testDbInstance.db, "tavily_api_key", "tvly-valid");
		// Only 2 responses queued (one per engine) — if 401 were retried like 429/5xx,
		// this would throw "Unexpected extra fetch call" instead of reaching Tavily.
		queueFetch([jsonResponse("invalid key", 401), jsonResponse(TAVILY_BODY)]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "9", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.engine).toBe("tavily");
	});

	it("dateRange is threaded into Exa's request body as startPublishedDate", async () => {
		await saveIntegrationKey(testDbInstance.db, "exa_api_key", "exa-valid");
		const calls = queueFetchCapturing([jsonResponse(EXA_BODY)]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5, dateRange: "week" },
			{ toolCallId: "10", messages: [] } as never,
		);

		expect(calls).toHaveLength(1);
		const body = JSON.parse(calls[0][1]?.body as string);
		expect(body.startPublishedDate).toBeDefined();
		expect(typeof body.startPublishedDate).toBe("string");
	});

	it("startDate/endDate is threaded into Tavily's request body verbatim", async () => {
		await saveIntegrationKey(testDbInstance.db, "tavily_api_key", "tvly-valid");
		const calls = queueFetchCapturing([jsonResponse(TAVILY_BODY)]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5, startDate: "2026-01-01", endDate: "2026-06-30" },
			{ toolCallId: "11", messages: [] } as never,
		);

		expect(calls).toHaveLength(1);
		const body = JSON.parse(calls[0][1]?.body as string);
		expect(body.start_date).toBe("2026-01-01");
		expect(body.end_date).toBe("2026-06-30");
	});

	it("fetchPageText refuses non-http(s) and internal/private URLs without making a network call", async () => {
		const calls = queueFetchCapturing([]); // any real call here is itself a test failure

		const { fetchPageText } = await import("../../src/bun/agents/tools/web");
		const blocked = await Promise.all([
			fetchPageText("http://127.0.0.1:8080/admin"),
			fetchPageText("http://localhost/secret"),
			fetchPageText("http://169.254.169.254/latest/meta-data/"),
			fetchPageText("http://192.168.1.1/"),
			fetchPageText("file:///etc/passwd"),
		]);

		for (const page of blocked) {
			expect(page.ok).toBe(false);
			expect(page.error).toMatch(/non-http\(s\)|internal\/private/i);
		}
		expect(calls).toHaveLength(0);
	});

	it("fetchPageText allows a normal public https URL through", async () => {
		queueFetch([htmlResponse("<html><body>hello</body></html>")]);

		const { fetchPageText } = await import("../../src/bun/agents/tools/web");
		const page = await fetchPageText("https://example.com/");

		expect(page.ok).toBe(true);
		expect(page.text).toContain("hello");
	});
});
