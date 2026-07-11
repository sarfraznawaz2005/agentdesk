/**
 * tests/agents/web-search.test.ts
 *
 * Fetch-mocked fallback matrix for the web_search tool's engine ordering:
 * Tavily -> Brave -> DuckDuckGo, first configured/available engine wins.
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

const BRAVE_BODY = JSON.stringify({
	web: { results: [{ title: "Brave Result", url: "https://brave.example.com", description: "Brave snippet" }] },
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

	it("valid Tavily key -> routes to tavily", async () => {
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

	it("only Brave key -> routes to brave", async () => {
		await saveIntegrationKey(testDbInstance.db, "brave_api_key", "brave-valid");
		queueFetch([jsonResponse(BRAVE_BODY)]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "3", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.engine).toBe("brave");
		expect(parsed.results[0].title).toBe("Brave Result");
	});

	it("Tavily rate-limited, Brave configured -> falls back to brave", async () => {
		await saveIntegrationKey(testDbInstance.db, "tavily_api_key", "tvly-valid");
		await saveIntegrationKey(testDbInstance.db, "brave_api_key", "brave-valid");
		queueFetch([jsonResponse("rate limited", 429), jsonResponse(BRAVE_BODY)]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "4", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.engine).toBe("brave");
		expect(parsed.results[0].title).toBe("Brave Result");
	});

	it("Tavily and Brave both rate-limited -> falls back to duckduckgo", async () => {
		await saveIntegrationKey(testDbInstance.db, "tavily_api_key", "tvly-valid");
		await saveIntegrationKey(testDbInstance.db, "brave_api_key", "brave-valid");
		queueFetch([jsonResponse("rate limited", 429), jsonResponse("rate limited", 429), htmlResponse(DDG_HTML)]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "5", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.engine).toBe("duckduckgo");
		expect(parsed.results[0].title).toBe("DDG Result Title");
	});

	it("all engines fail -> returns an aggregated error", async () => {
		await saveIntegrationKey(testDbInstance.db, "tavily_api_key", "tvly-valid");
		await saveIntegrationKey(testDbInstance.db, "brave_api_key", "brave-valid");
		queueFetch([jsonResponse("rate limited", 429), jsonResponse("rate limited", 429), htmlResponse("<html>no results</html>")]);

		const { webTools } = await import("../../src/bun/agents/tools/web");
		const raw = await webTools.web_search.tool.execute!(
			{ query: "test", maxResults: 5 },
			{ toolCallId: "6", messages: [] } as never,
		);
		const parsed = JSON.parse(raw as string);

		expect(parsed.error).toBe("All search engines failed");
		expect(parsed.details).toHaveLength(3);
		expect(parsed.details.map((d: { engine: string }) => d.engine)).toEqual(["tavily", "brave", "duckduckgo"]);
	});
});
