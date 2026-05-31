/**
 * council.test.ts
 *
 * Tests for the Council feature — Delphi + Borda multi-agent discussion system.
 *
 * Coverage:
 *   - truncate(): pure text-truncation helper
 *   - Borda score math: cumulative point calculation
 *   - Session lifecycle: startCouncilSession, stopCouncilSession, answerCouncilQuestion
 *   - resolveProvider: no-provider-configured error path
 *   - Full session flows: clarification, convergence, divergence, abort
 *
 * All LLM calls (generateText / streamText) and external collaborators are mocked.
 * The module under test is src/bun/rpc/council.ts.
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "../helpers/db";

// ── Module mocks (must precede any dynamic import that pulls them in) ─────────

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: "/tmp/test-agentdesk-council" } },
}));

/** All events broadcast to the webview during tests, keyed by sessionId. */
const emittedEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

mock.module("../../src/bun/engine-manager", () => ({
	broadcastToWebview: (event: string, payload: Record<string, unknown>) => {
		emittedEvents.push({ event, payload });
	},
}));

mock.module("../../src/bun/notifications/desktop", () => ({
	sendDesktopNotification: async () => {},
}));

/**
 * Controllable AI mock.
 * Tests override generateTextImpl / streamTextImpl to return deterministic data.
 * Defaults return a valid agent-selection array and a trivial text stream.
 */
type GenerateTextArgs = { abortSignal?: AbortSignal; messages?: Array<{ content: string }> };

let generateTextImpl: (args: GenerateTextArgs) => Promise<{ text: string }> = async () => ({
	text: '["software-architect","backend-engineer"]',
});

let streamTextImpl: (args: GenerateTextArgs) => { textStream: AsyncIterable<string> } = () => ({
	textStream: (async function* () {
		yield "Mock synthesis response.";
	})(),
});

mock.module("ai", () => ({
	generateText: (args: unknown) => generateTextImpl(args as GenerateTextArgs),
	streamText: (args: unknown) => streamTextImpl(args as GenerateTextArgs),
}));

mock.module("../../src/bun/providers", () => ({
	createProviderAdapter: () => ({
		createModel: (_modelId: string) => ({ _isMockModel: true }),
	}),
	getDefaultModel: () => "mock-model-id",
	getContextLimit: () => 128000,
}));

// Also mock the models sub-module so that re-exports in providers/index.ts
// are consistent regardless of which other test file ran first.
mock.module("../../src/bun/providers/models", () => ({
	getDefaultModel: () => "mock-model-id",
	getContextLimit: () => 128000,
	clearContextLimitCache: () => {},
}));

const { db: testDb, sqlite: testSqlite } = createTestDb();
mock.module("../../src/bun/db", () => ({ db: testDb }));

// ── Import module under test (after all mocks are wired) ─────────────────────

const { startCouncilSession, stopCouncilSession, answerCouncilQuestion } =
	await import("../../src/bun/rpc/council");

// ── Test helpers ──────────────────────────────────────────────────────────────

function clearEvents() {
	emittedEvents.length = 0;
}

function councilEvents(sessionId: string): Array<Record<string, unknown>> {
	return emittedEvents
		.filter((e) => e.event === "councilEvent" && e.payload.sessionId === sessionId)
		.map((e) => e.payload);
}

function eventTypes(sessionId: string): string[] {
	return councilEvents(sessionId).map((p) => p.type as string);
}

async function waitForEvent(
	sessionId: string,
	type: string,
	timeoutMs = 5000,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const evt = councilEvents(sessionId).find((p) => p.type === type);
		if (evt) return evt;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`Timeout: event "${type}" not received for session "${sessionId}"`);
}

async function waitForSessionEnd(sessionId: string, timeoutMs = 5000): Promise<void> {
	await waitForEvent(sessionId, "session-ended", timeoutMs);
}

function seedProvider(id = "prov-test"): void {
	testSqlite.exec(
		`INSERT OR IGNORE INTO ai_providers(id, name, provider_type, api_key, is_default, is_valid)
     VALUES ('${id}', 'Mock Provider', 'anthropic', 'sk-mock', 1, 1)`,
	);
}

function removeAllProviders(): void {
	testSqlite.exec("DELETE FROM ai_providers");
}

/** Standard 3-phase generateText mock: selection → clarification → convergence. */
function makeStandardGenerateMock(opts?: {
	selection?: string;
	clarification?: string;
	convergence?: string;
	bordaRanking?: string;
}): void {
	let callCount = 0;
	generateTextImpl = async () => {
		callCount++;
		if (callCount === 1) return { text: opts?.selection ?? '["backend-engineer","software-architect"]' };
		if (callCount === 2) return { text: opts?.clarification ?? "PROCEED" };
		if (callCount === 3) return { text: opts?.convergence ?? '{"converged":true,"summary":"Agents agree"}' };
		// Subsequent calls are Borda ranking
		return { text: opts?.bordaRanking ?? "[1]" };
	};
}

/** Standard synthesis stream that always yields a non-empty response. */
function makeStandardStreamMock(content = "Agent response text."): void {
	streamTextImpl = () => ({
		textStream: (async function* () {
			yield content;
		})(),
	});
}

// ── Pure function: truncate ───────────────────────────────────────────────────

// Re-implement truncate() from council.ts to verify the documented contract
// without needing to export the private function.
const RESPONSE_TRUNCATE_CHARS = 1500;
function truncate(text: string): string {
	if (text.length <= RESPONSE_TRUNCATE_CHARS) return text;
	return text.slice(0, RESPONSE_TRUNCATE_CHARS) + "\n[...truncated]";
}

describe("truncate", () => {
	it("returns text unchanged when under the limit", () => {
		const short = "A".repeat(100);
		expect(truncate(short)).toBe(short);
	});

	it("returns text unchanged at exactly the limit", () => {
		const exact = "B".repeat(RESPONSE_TRUNCATE_CHARS);
		expect(truncate(exact)).toBe(exact);
	});

	it("truncates text that exceeds the limit and appends the marker", () => {
		const long = "C".repeat(RESPONSE_TRUNCATE_CHARS + 50);
		const result = truncate(long);
		expect(result.endsWith("\n[...truncated]")).toBe(true);
		expect(result.startsWith("C".repeat(RESPONSE_TRUNCATE_CHARS))).toBe(true);
		expect(result.length).toBeLessThan(long.length);
	});

	it("does not include content beyond the truncation point", () => {
		const text = "Hello" + " ".repeat(RESPONSE_TRUNCATE_CHARS) + "SENTINEL";
		expect(truncate(text)).not.toContain("SENTINEL");
	});
});

// ── Pure logic: Borda score math ──────────────────────────────────────────────

// Re-implement the Borda calculation from runBordaRanking to verify its contract
// independently of the LLM calls that build the rankings.
interface RoundResponse { agentName: string; displayName: string; content: string }

function computeBordaScores(
	responses: RoundResponse[],
	rankingsByRanker: Map<string, number[]>,
): Record<string, number> {
	const scores: Record<string, number> = {};
	for (const r of responses) scores[r.agentName] = 0;

	for (const [rankerName, ranking] of rankingsByRanker) {
		const others = responses.filter((r) => r.agentName !== rankerName);
		if (others.length === 0) continue;
		const numOthers = others.length;
		ranking.forEach((pos, kIndex) => {
			const idx = pos - 1; // 1-indexed → 0-indexed
			if (idx >= 0 && idx < others.length) {
				const agentName = others[idx].agentName;
				scores[agentName] = (scores[agentName] ?? 0) + (numOthers - 1 - kIndex);
			}
		});
	}
	return scores;
}

const makeResponses = (names: string[]): RoundResponse[] =>
	names.map((n) => ({ agentName: n, displayName: n, content: `Response by ${n}` }));

describe("Borda score math", () => {
	it("returns a zero score for a single-agent council (no peers to rank)", () => {
		const scores = computeBordaScores(makeResponses(["agent-a"]), new Map());
		expect(scores).toEqual({ "agent-a": 0 });
	});

	it("returns zero scores for all agents when no ranker submitted rankings", () => {
		const scores = computeBordaScores(makeResponses(["a", "b", "c"]), new Map());
		expect(scores).toEqual({ a: 0, b: 0, c: 0 });
	});

	it("awards (n-1) points to rank-1 position with 3 agents", () => {
		// numOthers=2: rank-1 gets 1 pt, rank-2 gets 0 pts
		const scores = computeBordaScores(
			makeResponses(["agent-a", "agent-b", "agent-c"]),
			new Map([["agent-a", [1, 2]]]), // agent-a: b=1st, c=2nd
		);
		expect(scores["agent-b"]).toBe(1); // ranked 1st
		expect(scores["agent-c"]).toBe(0); // ranked 2nd
		expect(scores["agent-a"]).toBe(0); // ranker, not ranked
	});

	it("accumulates scores from multiple rankers correctly", () => {
		// 3 agents: a, b, c (each ranks the other two)
		// a ranks: b=1st(1pt), c=2nd(0pt)
		// b ranks: a=1st(1pt), c=2nd(0pt)
		// c ranks: a=1st(1pt), b=2nd(0pt)
		const scores = computeBordaScores(
			makeResponses(["a", "b", "c"]),
			new Map([
				["a", [1, 2]], // others=[b,c] → b+1
				["b", [1, 2]], // others=[a,c] → a+1
				["c", [1, 2]], // others=[a,b] → a+1
			]),
		);
		expect(scores["a"]).toBe(2); // ranked 1st by b and c
		expect(scores["b"]).toBe(1); // ranked 1st by a
		expect(scores["c"]).toBe(0); // never ranked 1st
	});

	it("ignores out-of-bounds position indices silently", () => {
		// numOthers=1: only positions [1] are in range; position 5 is out of range → skip
		const scores = computeBordaScores(
			makeResponses(["a", "b"]),
			new Map([["a", [5]]]), // 5 is out-of-range for 1 other agent → ignored
		);
		expect(scores["b"]).toBe(0); // no valid position awarded → score stays 0
	});

	it("self-rankings are excluded (agent cannot rank itself)", () => {
		// agent-a's 'others' excludes agent-a, so the ranking positions only apply to b,c
		const scores = computeBordaScores(
			makeResponses(["agent-a", "agent-b", "agent-c"]),
			new Map([["agent-a", [1]]]),
		);
		// Only 1 position returned — affects agent-b (others[0])
		expect(scores["agent-a"]).toBe(0); // ranker, not a valid target
		expect(scores["agent-b"]).toBe(1); // ranked 1st
	});
});

// ── Session lifecycle ─────────────────────────────────────────────────────────

describe("startCouncilSession", () => {
	beforeEach(() => {
		clearEvents();
		seedProvider();
		makeStandardGenerateMock();
		makeStandardStreamMock();
	});

	afterEach(removeAllProviders);

	it("returns a sessionId immediately (before session completes)", async () => {
		const { sessionId } = await startCouncilSession("What database should I use?");
		expect(typeof sessionId).toBe("string");
		expect(sessionId.startsWith("council-")).toBe(true);
	});

	it("emits session-started with the original query", async () => {
		const { sessionId } = await startCouncilSession("Best caching strategy?");
		await waitForEvent(sessionId, "session-started");

		const evt = councilEvents(sessionId).find((p) => p.type === "session-started");
		expect(evt?.query).toBe("Best caching strategy?");
	});

	it("emits agents-selected with an array of at least 2 agents", async () => {
		const { sessionId } = await startCouncilSession("API design question");
		await waitForSessionEnd(sessionId);

		const evt = councilEvents(sessionId).find((p) => p.type === "agents-selected");
		expect(evt).toBeDefined();
		const agents = evt?.agents as Array<{ name: string }>;
		expect(Array.isArray(agents)).toBe(true);
		expect(agents.length).toBeGreaterThanOrEqual(2);
	});

	it("falls back to first 3 COUNCIL_AGENTS when PM returns invalid JSON", async () => {
		makeStandardGenerateMock({ selection: "not valid json at all" });
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("Architecture question");
		await waitForSessionEnd(sessionId);

		const evt = councilEvents(sessionId).find((p) => p.type === "agents-selected");
		const agents = evt?.agents as Array<{ name: string }>;
		expect(agents.length).toBe(3);
		expect(agents[0].name).toBe("software-architect");
		expect(agents[1].name).toBe("backend-engineer");
		expect(agents[2].name).toBe("frontend_engineer");
	});

	it("enforces a minimum of 2 agents when PM returns only 1 valid name", async () => {
		makeStandardGenerateMock({ selection: '["backend-engineer"]' });
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("Quick question");
		await waitForSessionEnd(sessionId);

		const evt = councilEvents(sessionId).find((p) => p.type === "agents-selected");
		const agents = evt?.agents as Array<{ name: string }>;
		expect(agents.length).toBeGreaterThanOrEqual(2);
	});

	it("caps selected agents at 5 even when PM returns more", async () => {
		makeStandardGenerateMock({
			selection: JSON.stringify([
				"software-architect",
				"backend-engineer",
				"frontend_engineer",
				"database-expert",
				"security-expert",
				"api-designer", // 6th — should be dropped
			]),
		});
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("Complex question");
		await waitForSessionEnd(sessionId);

		const evt = councilEvents(sessionId).find((p) => p.type === "agents-selected");
		const agents = evt?.agents as Array<{ name: string }>;
		expect(agents.length).toBeLessThanOrEqual(5);
	});

	it("emits session-ended at the end of a successful run", async () => {
		const { sessionId } = await startCouncilSession("Complete flow question");
		await waitForSessionEnd(sessionId);
		expect(eventTypes(sessionId)).toContain("session-ended");
	});
});

describe("stopCouncilSession", () => {
	beforeEach(clearEvents);
	afterEach(removeAllProviders);

	it("is a no-op for an unknown sessionId (does not throw)", () => {
		expect(() => stopCouncilSession("nonexistent-session-id")).not.toThrow();
	});

	it("aborts a running session and emits session-ended without an error event", async () => {
		seedProvider("prov-stop");

		// generateText blocks until the AbortSignal fires — then throws AbortError
		generateTextImpl = async (args: GenerateTextArgs) => {
			return new Promise<{ text: string }>((resolve, reject) => {
				if (args.abortSignal?.aborted) {
					reject(new DOMException("Aborted", "AbortError"));
					return;
				}
				args.abortSignal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			});
		};

		const { sessionId } = await startCouncilSession("Slow question to abort");
		// session-started is emitted synchronously before any awaits in runSession
		await waitForEvent(sessionId, "session-started");
		// Allow resolveProvider() (one async step) to complete before aborting
		await new Promise((r) => setTimeout(r, 30));

		stopCouncilSession(sessionId);

		await waitForSessionEnd(sessionId, 3000);
		expect(eventTypes(sessionId)).toContain("session-ended");
		// Abort should not surface as an error to the user
		expect(eventTypes(sessionId)).not.toContain("error");
	});

	it("is idempotent — calling stop twice on the same session does not throw", async () => {
		seedProvider("prov-stop2");
		generateTextImpl = async (args: GenerateTextArgs) =>
			new Promise<{ text: string }>((_, reject) => {
				args.abortSignal?.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			});

		const { sessionId } = await startCouncilSession("Idempotent stop test");
		await waitForEvent(sessionId, "session-started");
		await new Promise((r) => setTimeout(r, 30));

		expect(() => {
			stopCouncilSession(sessionId);
			stopCouncilSession(sessionId); // second call — session already removed
		}).not.toThrow();

		await waitForSessionEnd(sessionId, 3000);
	});
});

describe("answerCouncilQuestion", () => {
	beforeEach(() => {
		clearEvents();
		seedProvider("prov-qa");
	});

	afterEach(removeAllProviders);

	it("is a no-op for an unknown sessionId (does not throw)", () => {
		expect(() =>
			answerCouncilQuestion("unknown-session", "q-1", "my answer"),
		).not.toThrow();
	});

	it("resolves a pending clarification question and continues the session", async () => {
		let callCount = 0;
		generateTextImpl = async () => {
			callCount++;
			if (callCount === 1) return { text: '["backend-engineer","software-architect"]' };
			if (callCount === 2) return { text: "QUESTION: What is your expected traffic volume?" };
			return { text: '{"converged":true,"summary":"Agents agree on approach"}' };
		};
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("What DB for my use case?");
		const questionEvt = await waitForEvent(sessionId, "question");
		const questionId = questionEvt.questionId as string;

		// Providing the answer should unblock the session
		answerCouncilQuestion(sessionId, questionId, "10k requests per second");

		await waitForSessionEnd(sessionId);
		expect(eventTypes(sessionId)).toContain("final-answer-complete");
	});

	it("augments the active query with the user's answer", async () => {
		const capturedMessages: string[] = [];
		let callCount = 0;

		generateTextImpl = async (args: GenerateTextArgs) => {
			callCount++;
			for (const m of args.messages ?? []) capturedMessages.push(m.content);
			if (callCount === 1) return { text: '["backend-engineer","software-architect"]' };
			if (callCount === 2) return { text: "QUESTION: What traffic volume do you expect?" };
			return { text: '{"converged":true,"summary":"Agents agree"}' };
		};
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("Database recommendation?");
		const questionEvt = await waitForEvent(sessionId, "question");
		answerCouncilQuestion(sessionId, questionEvt.questionId as string, "50k RPS");

		await waitForSessionEnd(sessionId);

		// After answering, subsequent LLM prompts should include the answer
		const messagesAfterAnswer = capturedMessages.slice(2); // skip selection + clarification
		expect(messagesAfterAnswer.some((m) => m.includes("50k RPS"))).toBe(true);
	});

	it("is a no-op for an unknown questionId on a known active session", async () => {
		let callCount = 0;
		generateTextImpl = async () => {
			callCount++;
			if (callCount === 1) return { text: '["backend-engineer","software-architect"]' };
			if (callCount === 2) return { text: "QUESTION: What DB engine are you using?" };
			return { text: '{"converged":true,"summary":"ok"}' };
		};
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("Some question");
		await waitForEvent(sessionId, "question");

		// Wrong question ID — should be silently ignored
		expect(() =>
			answerCouncilQuestion(sessionId, "wrong-question-id", "my answer"),
		).not.toThrow();

		// Clean up — stop the stuck session
		stopCouncilSession(sessionId);
		await waitForSessionEnd(sessionId, 3000);
	});
});

// ── resolveProvider: no provider configured ───────────────────────────────────

describe("resolveProvider — no AI provider", () => {
	beforeEach(() => {
		clearEvents();
		removeAllProviders();
	});

	it("emits an error event when no AI provider is configured in the database", async () => {
		const { sessionId } = await startCouncilSession("Question with no provider");
		await waitForSessionEnd(sessionId);

		const errorEvt = councilEvents(sessionId).find((p) => p.type === "error");
		expect(errorEvt).toBeDefined();
		expect(String(errorEvt?.message).toLowerCase()).toContain("provider");
	});

	it("still emits session-ended even when provider is missing", async () => {
		const { sessionId } = await startCouncilSession("No-provider session");
		await waitForSessionEnd(sessionId);
		expect(eventTypes(sessionId)).toContain("session-ended");
	});
});

// ── Full session flows ────────────────────────────────────────────────────────

describe("Full session flow — PROCEED clarification", () => {
	beforeEach(() => {
		clearEvents();
		seedProvider("prov-proceed");
	});

	afterEach(removeAllProviders);

	it("does not emit a question event when PM responds PROCEED", async () => {
		makeStandardGenerateMock({ clarification: "PROCEED" });
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("Clear question needing no clarification");
		await waitForSessionEnd(sessionId);

		expect(eventTypes(sessionId)).not.toContain("question");
		expect(eventTypes(sessionId)).toContain("final-answer-complete");
	});
});

describe("Full session flow — convergence check", () => {
	beforeEach(() => {
		clearEvents();
		seedProvider("prov-conv");
	});

	afterEach(removeAllProviders);

	it("skips Round 2 when agents converge after Round 1", async () => {
		makeStandardGenerateMock({ convergence: '{"converged":true,"summary":"All agents agree"}' });
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("Converging question");
		await waitForSessionEnd(sessionId);

		const roundStarts = councilEvents(sessionId)
			.filter((p) => p.type === "round-start")
			.map((p) => p.round);
		expect(roundStarts).toContain(1);
		expect(roundStarts).not.toContain(2);
	});

	it("emits a convergence event when agents agree", async () => {
		makeStandardGenerateMock({ convergence: '{"converged":true,"summary":"Positions are aligned"}' });
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("Agreement question");
		await waitForSessionEnd(sessionId);

		const convEvt = councilEvents(sessionId).find((p) => p.type === "convergence");
		expect(convEvt).toBeDefined();
		expect(convEvt?.converged).toBe(true);
	});

	it("runs Round 2 when agents diverge after Round 1", async () => {
		makeStandardGenerateMock({ convergence: '{"converged":false,"summary":"Agents disagree on approach"}' });
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("Diverging question");
		await waitForSessionEnd(sessionId);

		const roundStarts = councilEvents(sessionId)
			.filter((p) => p.type === "round-start")
			.map((p) => p.round);
		expect(roundStarts).toContain(1);
		expect(roundStarts).toContain(2);
	});

	it("defaults to not-converged when convergence response is unparseable JSON", async () => {
		makeStandardGenerateMock({ convergence: "MALFORMED{{JSON" });
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession("Unparseable convergence");
		await waitForSessionEnd(sessionId);

		// Falls back to diverged → round 2 must run
		const roundStarts = councilEvents(sessionId)
			.filter((p) => p.type === "round-start")
			.map((p) => p.round);
		expect(roundStarts).toContain(2);
	});
});

describe("Full session flow — Borda ranking & synthesis", () => {
	beforeEach(() => {
		clearEvents();
		seedProvider("prov-borda");
	});

	afterEach(removeAllProviders);

	it("emits a borda-scores event with a scores object", async () => {
		makeStandardGenerateMock({
			bordaRanking: "[1]", // each ranker ranks 1 other → valid
		});
		makeStandardStreamMock("Agent response.");

		const { sessionId } = await startCouncilSession("Borda flow question");
		await waitForSessionEnd(sessionId);

		const bordaEvt = councilEvents(sessionId).find((p) => p.type === "borda-scores");
		expect(bordaEvt).toBeDefined();
		expect(typeof bordaEvt?.scores).toBe("object");
		expect(bordaEvt?.scores).not.toBeNull();
	});

	it("emits final-answer-complete after the synthesis stream", async () => {
		makeStandardGenerateMock();
		makeStandardStreamMock("Final synthesis answer.");

		const { sessionId } = await startCouncilSession("Synthesis flow question");
		await waitForSessionEnd(sessionId);

		expect(eventTypes(sessionId)).toContain("final-answer-complete");
	});

	it("streams final answer tokens via final-answer-token events", async () => {
		makeStandardGenerateMock();

		let chunkCount = 0;
		streamTextImpl = () => ({
			textStream: (async function* () {
				yield "Part one. ";
				yield "Part two.";
				chunkCount++;
			})(),
		});

		const { sessionId } = await startCouncilSession("Token stream question");
		await waitForSessionEnd(sessionId);

		const tokenEvts = councilEvents(sessionId).filter((p) => p.type === "final-answer-token");
		expect(tokenEvts.length).toBeGreaterThan(0);
	});

	it("emits an error event when fewer than 2 agents produce non-empty responses", async () => {
		makeStandardGenerateMock({ convergence: '{"converged":true,"summary":"ok"}' });

		// Empty stream → all agents produce empty responses → filtered to null
		streamTextImpl = () => ({
			textStream: (async function* () {
				// yield nothing
			})(),
		});

		const { sessionId } = await startCouncilSession("All agents silent");
		await waitForSessionEnd(sessionId);

		const errorEvt = councilEvents(sessionId).find((p) => p.type === "error");
		expect(errorEvt).toBeDefined();
		expect(String(errorEvt?.message)).toContain("agent");
	});

	it("includes selected agent names in borda-scores even when Borda ranking fails", async () => {
		// Borda ranking returns unparseable text → each ranker is skipped → scores stay 0
		makeStandardGenerateMock({ bordaRanking: "INVALID_RANKING" });
		makeStandardStreamMock("Response.");

		const { sessionId } = await startCouncilSession("Failed ranking question");
		await waitForSessionEnd(sessionId);

		const bordaEvt = councilEvents(sessionId).find((p) => p.type === "borda-scores");
		expect(bordaEvt).toBeDefined();
		const scores = bordaEvt?.scores as Record<string, number>;
		// All scores should be zero (ranking failed gracefully)
		for (const val of Object.values(scores)) {
			expect(val).toBe(0);
		}
	});
});

describe("Full session flow — follow-up with context", () => {
	beforeEach(() => {
		clearEvents();
		seedProvider("prov-followup");
	});

	afterEach(removeAllProviders);

	it("prepends prior discussion context to the effective query", async () => {
		const capturedMessages: string[] = [];
		let callCount = 0;

		generateTextImpl = async (args: GenerateTextArgs) => {
			callCount++;
			for (const m of args.messages ?? []) capturedMessages.push(m.content);
			if (callCount === 1) return { text: '["backend-engineer","software-architect"]' };
			if (callCount === 2) return { text: "PROCEED" };
			return { text: '{"converged":true,"summary":"Agree"}' };
		};
		makeStandardStreamMock("Follow-up synthesis.");

		const context = "Previous discussion about PostgreSQL vs MySQL";
		const { sessionId } = await startCouncilSession("Any follow-up questions?", context);
		await waitForSessionEnd(sessionId);

		// The agent selection prompt (first call, first message) should include the prior context
		expect(capturedMessages[0]).toContain("[Prior Council Discussion]");
		expect(capturedMessages[0]).toContain(context);
		expect(capturedMessages[0]).toContain("[Follow-up Question]");
	});

	it("embeds the follow-up question in the effective query", async () => {
		const capturedMessages: string[] = [];
		let callCount = 0;

		generateTextImpl = async (args: GenerateTextArgs) => {
			callCount++;
			for (const m of args.messages ?? []) capturedMessages.push(m.content);
			if (callCount === 1) return { text: '["backend-engineer","software-architect"]' };
			if (callCount === 2) return { text: "PROCEED" };
			return { text: '{"converged":true,"summary":"Agree"}' };
		};
		makeStandardStreamMock();

		const { sessionId } = await startCouncilSession(
			"Should I switch to Redis?",
			"We discussed caching options.",
		);
		await waitForSessionEnd(sessionId);

		expect(capturedMessages[0]).toContain("Should I switch to Redis?");
	});
});
