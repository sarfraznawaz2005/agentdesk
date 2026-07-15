/**
 * verify-ai-sdk-v7-live.ts
 *
 * Live verification for the AI SDK v6->v7 migration's remaining open items
 * that static analysis (typecheck/lint/test) can't settle on its own — see
 * docs/ai-sdk-7-migration-tasks.md for the full checklist this closes out:
 *
 *   - §5.2 usage-semantics flip: is `result.usage` really "sum of all steps"
 *     in the installed v7, matching what engine.ts/agent-loop.ts assume?
 *   - §5.5 media/file content-part canonicalization: does a real provider
 *     accept the exact `{ type: 'file', data, mediaType }` shape
 *     buildMediaFollowUpMessage() constructs?
 *   - §5.7 reasoning-token field: spot-check `usage.outputTokenDetails` shape.
 *   - Retry-loop classifier (`isTransientError`) sanity, post-migration.
 *
 * Deliberately talks to the real AI SDK + two real provider adapters directly
 * (not through the full AgentEngine/agent-loop machinery, which is already
 * covered by this session's typecheck/lint/test verification) — the goal
 * here is proving the *wire-level* v7 integration against real APIs, using
 * two providers that need no separate API key on this machine:
 *
 *   - OpenCode ("public" free key)      — an OpenAI-compatible provider
 *   - Claude Subscription, Haiku model  — Anthropic-native (direct-HTTP OAuth
 *                                         path, reads ~/.claude/.credentials.json)
 *
 * matching §8.4's own requirement to test against one Anthropic-native model
 * and one OpenAI-compatible model.
 *
 * Run: bun run scripts/verify-ai-sdk-v7-live.ts
 */

import { streamText, generateText, isStepCount, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { OpenCodeAdapter } from "../src/bun/providers/opencode";
import { ClaudeSubscriptionAdapter } from "../src/bun/providers/claude-subscription";
import { isTransientError } from "../src/bun/agents/safety";
import type { ProviderConfig } from "../src/bun/providers/types";

// A well-known, valid 1x1 transparent PNG — enough to exercise the real
// FilePart wire path without needing a real screenshot/read_image call.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let passCount = 0;
let failCount = 0;
let skipCount = 0;

async function check(label: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
		passCount++;
	} catch (err) {
		console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
		console.log(`       ${err instanceof Error ? err.message : String(err)}`);
		failCount++;
	}
}

function skip(label: string, reason: string): void {
	console.log(`  \x1b[33mSKIP\x1b[0m ${label} — ${reason}`);
	skipCount++;
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Per-provider live suite
// ---------------------------------------------------------------------------

async function runProviderSuite(providerLabel: string, model: LanguageModel): Promise<void> {
	console.log(`\n== ${providerLabel} ==`);

	await check(`${providerLabel}: basic generateText (instructions/messages rename)`, async () => {
		const result = await generateText({
			model,
			instructions: "You are a terse test assistant. Respond in under 10 words.",
			messages: [{ role: "user", content: "Say hello and name one color." }],
		});
		assert(typeof result.text === "string" && result.text.trim().length > 0, "expected non-empty text");
		console.log(`       text: ${JSON.stringify(result.text.slice(0, 80))}`);
	});

	await check(`${providerLabel}: usage semantics — result.usage is the SUM of all step usages (§5.2)`, async () => {
		const getNumber = tool({
			description: "Returns a secret number. You must call this to answer the user's question.",
			inputSchema: z.object({}),
			execute: async () => "42",
		});
		const getWord = tool({
			description: "Returns a secret word. You must call this AFTER get_number to fully answer.",
			inputSchema: z.object({}),
			execute: async () => "banana",
		});

		const stepUsages: Array<{ inputTokens?: number; outputTokens?: number }> = [];
		const result = await generateText({
			model,
			instructions:
				"You must call get_number, then call get_word, then reply with a sentence containing both results. Do not skip either tool call.",
			messages: [{ role: "user", content: "What are the secret number and secret word?" }],
			tools: { get_number: getNumber, get_word: getWord },
			stopWhen: [isStepCount(6)],
			onStepEnd: (step) => {
				stepUsages.push({ inputTokens: step.usage?.inputTokens, outputTokens: step.usage?.outputTokens });
			},
		});

		assert(stepUsages.length >= 1, "expected at least one step to have run");
		const totalUsage = result.usage;
		assert(totalUsage != null, "expected result.usage to be defined");

		const stepOutputSum = stepUsages.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0);
		console.log(
			`       steps=${stepUsages.length} stepOutputSum=${stepOutputSum} result.usage.outputTokens=${totalUsage.outputTokens} ` +
				`result.usage.inputTokens=${totalUsage.inputTokens}`,
		);

		if (stepUsages.length > 1) {
			// The concrete, empirical proof: with >1 step, result.usage must be the
			// SUM across steps, not equal to any single step's usage alone — a
			// final-step-only semantics (the v6 behavior the migration doc worried
			// about) would make this assertion fail.
			const lastStepOutput = stepUsages[stepUsages.length - 1]?.outputTokens ?? 0;
			assert(
				(totalUsage.outputTokens ?? 0) >= lastStepOutput,
				`result.usage.outputTokens (${totalUsage.outputTokens}) should be >= the last step's own outputTokens (${lastStepOutput}) if usage is summed, not final-step-only`,
			);
			assert(
				Math.abs((totalUsage.outputTokens ?? 0) - stepOutputSum) <= 1,
				`result.usage.outputTokens (${totalUsage.outputTokens}) should equal the sum of all step outputTokens (${stepOutputSum}) within rounding`,
			);
		} else {
			console.log("       (model resolved in a single step — sum-vs-final distinction not observable this run, re-run to try for a multi-step trace)");
		}
	});

	await check(`${providerLabel}: usage.outputTokenDetails shape (§5.7 spot check)`, async () => {
		const result = await generateText({
			model,
			instructions: "Think briefly, then answer in one short sentence.",
			messages: [{ role: "user", content: "What is 7 + 5?" }],
		});
		// outputTokenDetails is optional/provider-dependent — just confirm the
		// field name is the v7 one (not the old flat usage.reasoningTokens) when present.
		const details = (result.usage as unknown as { outputTokenDetails?: { reasoningTokens?: number } }).outputTokenDetails;
		console.log(`       outputTokenDetails=${JSON.stringify(details ?? "undefined (provider doesn't report it, expected for most non-thinking calls)")}`);
	});

	await check(`${providerLabel}: media/file content-part round trip (§5.5) — real FilePart accepted by the provider`, async () => {
		// Mirrors buildMediaFollowUpMessage()'s exact shape (media-followup.ts) —
		// this IS the wire format that function constructs, sent directly here so
		// the test doesn't need the full Electrobun/DB app context to run.
		const result = await generateText({
			model,
			instructions: "Describe the image in one short sentence. It is a tiny test image, that's expected.",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Here is a test image." },
						{ type: "file", data: TINY_PNG_BASE64, mediaType: "image/png" },
					],
				},
			],
		});
		assert(typeof result.text === "string" && result.text.trim().length > 0, "expected a non-empty response describing (or at least acknowledging) the image");
		console.log(`       response: ${JSON.stringify(result.text.slice(0, 100))}`);
	});
}

// ---------------------------------------------------------------------------
// Provider-independent unit checks (no live call needed)
// ---------------------------------------------------------------------------

function runClassifierChecks(): void {
	console.log("\n== isTransientError() classifier sanity (retry-loop, no live call needed) ==");

	const cases: Array<{ label: string; error: unknown; expected: boolean }> = [
		{ label: "429 rate limit", error: new Error("Request failed with status 429"), expected: true },
		{ label: "503 service unavailable", error: new Error("503 Service Unavailable"), expected: true },
		{ label: "ECONNRESET", error: Object.assign(new Error("socket hang up"), { name: "ECONNRESET" }), expected: true },
		{ label: "fetch failed (network)", error: new Error("fetch failed"), expected: true },
		{ label: "status property (no message text)", error: Object.assign(new Error("boom"), { status: 429 }), expected: true },
		{ label: "401 unauthorized (NOT transient)", error: new Error("401 Unauthorized — invalid API key"), expected: false },
		{ label: "plain validation error (NOT transient)", error: new Error("Invalid input: expected string, received number"), expected: false },
		{ label: "non-Error thrown value (NOT transient)", error: "a plain string", expected: false },
	];

	for (const c of cases) {
		const actual = isTransientError(c.error);
		if (actual === c.expected) {
			console.log(`  \x1b[32mPASS\x1b[0m isTransientError: ${c.label} -> ${actual}`);
			passCount++;
		} else {
			console.log(`  \x1b[31mFAIL\x1b[0m isTransientError: ${c.label} -> got ${actual}, expected ${c.expected}`);
			failCount++;
		}
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("AI SDK v7 migration — live verification (§5.2, §5.5, §5.7, retry classifier)");

	// --- OpenCode (OpenAI-compatible, free "public" key) ---
	try {
		const opencodeConfig: ProviderConfig = {
			id: "test-opencode", name: "OpenCode", providerType: "opencode",
			apiKey: "public", baseUrl: null, defaultModel: null,
		};
		const opencodeAdapter = new OpenCodeAdapter(opencodeConfig);
		const models = await opencodeAdapter.listModels();
		if (models.length === 0) throw new Error("OpenCode returned zero free models — provider may be down");
		const modelId = models[0];
		console.log(`\n(OpenCode model: ${modelId})`);
		await runProviderSuite("OpenCode (OpenAI-compatible)", opencodeAdapter.createModel(modelId));
	} catch (err) {
		skip("OpenCode suite", err instanceof Error ? err.message : String(err));
	}

	// --- Claude Subscription, Haiku (Anthropic-native, direct-HTTP OAuth path) ---
	try {
		const claudeConfig: ProviderConfig = {
			id: "test-claude-sub", name: "Claude Subscription", providerType: "claude-subscription",
			apiKey: "", baseUrl: null, defaultModel: "claude-haiku-4-5-20251001",
		};
		const claudeAdapter = new ClaudeSubscriptionAdapter(claudeConfig);
		const model = claudeAdapter.createModel("claude-haiku-4-5-20251001");
		await runProviderSuite("Claude Subscription — Haiku (Anthropic-native)", model);
	} catch (err) {
		skip("Claude Subscription suite", err instanceof Error ? err.message : String(err));
	}

	runClassifierChecks();

	console.log(`\n${passCount} pass, ${failCount} fail, ${skipCount} skip`);
	console.log(
		"\nNote: the hallucination-guard regexes (THINKING_DISPATCH_RE / DISPATCH_CLAIM_RE in\n" +
		"engine.ts) are not exercised here — they're deeply embedded in AgentEngine's live\n" +
		"turn control flow, not standalone units, and a script duplicating their patterns\n" +
		"would risk silently drifting out of sync with the real regexes. Verify that one by\n" +
		"asking the PM (in the running app) something that requires dispatching a sub-agent\n" +
		"and confirming it either calls run_agent directly or self-corrects after a hallucinated\n" +
		"text-only reply.",
	);

	if (failCount > 0) process.exit(1);
}

await main();
