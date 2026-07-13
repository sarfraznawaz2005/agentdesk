import { tool, generateText } from "ai";
import { z } from "zod";
import { createProviderAdapter } from "../../providers";
import type { ProviderConfig } from "../../providers/types";
import { internalCallModelId } from "../../providers/claude-subscription";
import { webTools, fetchPageText, type DateRangeOpts } from "./web";
import type { ToolRegistryEntry } from "./index";

// generateText's own maxRetries (default 2, i.e. 3 attempts total) already
// covers transient provider failures for these calls — made explicit here so
// the "retry with delay, up to 2 more times" requirement is visible at the
// call site rather than relying on an implicit SDK default.
const LLM_MAX_RETRIES = 2;

// generateText (not generateObject) throughout this file — same reasoning as
// src/bun/rpc/freelance-wizard.ts: generateObject relies on native structured
// output/forced tool-calling, which isn't reliably supported across every
// provider a user might configure (notably free/small models via OpenCode,
// Ollama, some OpenRouter-proxied models — see also web_search's own
// avoidance of forced toolChoice for the same portability reason). We ask
// for strict JSON in the system prompt and parse it defensively instead,
// with a safe non-throwing fallback if parsing fails.
function extractJsonFromText(text: string): Record<string, unknown> {
	const stripped = text.replace(/```[a-z]*\s*/gi, "").replace(/```\s*/g, "").trim();
	const start = stripped.indexOf("{");
	if (start === -1) throw new Error("No JSON object found in model output");
	let end = stripped.lastIndexOf("}");
	while (end > start) {
		try {
			return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
		} catch {
			end = stripped.lastIndexOf("}", end - 1);
		}
	}
	throw new Error("No valid JSON object found in model output");
}

// ---------------------------------------------------------------------------
// deep_research — research-expert only. Runs its OWN internal multi-step LLM
// loop (plan -> search -> read full pages -> optionally refine -> synthesize)
// inside a single tool call, mirroring how ChatGPT/Gemini/Perplexity/Grok's
// "Deep Research" mode works, on top of the existing Exa/Tavily/DuckDuckGo
// web_search chain. Never asks a human to clarify — research-expert can run
// headlessly via schedules with nobody present to answer questions, so every
// internal prompt below explicitly forbids it and requires an autonomous
// best-effort interpretation instead.
// ---------------------------------------------------------------------------

const PLAN_QUERY_HARD_CAP = 6;
const MAX_RESULTS_PER_QUERY = 6;
const MAX_SOURCES_FETCHED = 12; // top unique URLs read in full — the "read many pages" core
const FETCH_CONCURRENCY = 4;
const PER_FETCH_TIMEOUT_MS = 15_000; // mirrors web_fetch's default
const FETCH_MAX_CHARS = 8_000; // per-page stored text cap
const SYNTHESIS_CHARS_PER_SRC = 3_000; // per-source slice fed into the final report call
const MAX_ROUNDS = 2; // round 1 always; round 2 only on a real, evaluated gap
const MAX_REFINEMENT_QUERIES = 3;
const INTERNAL_TIMEOUT_MS = 8 * 60_000; // internal safety cap, well under the shared 30-min run budget

const NEVER_ASK_CLARIFYING = "Never ask the user a clarifying question — this runs unattended. " + "Assume the most reasonable interpretation and proceed.";

// Computed once per execute() call and prepended to every internal system
// prompt below. deep_research's planner/evaluator/synthesis calls are each a
// fresh, isolated LLM context (not the calling agent's own conversation), so
// none of them otherwise have any way to know what "today", "recent", or
// "this year" means.
function dateContext(): string {
	const now = new Date();
	return `Today's date is ${now.toISOString().slice(0, 10)}. Use this for any time-relative reasoning (e.g. "recent", "this year", "as of today").`;
}

function plannerSystem(today: string): string {
	return (
		"You are a research planner. Given a topic, produce 3-6 concrete, diverse web search queries " +
		"that together cover it well — e.g. definitions/background, current state, comparisons or " +
		"alternatives, recent developments, and notable criticisms or limitations where relevant. " +
		"Record your interpretation of what the user is actually asking for. " +
		today + " " + NEVER_ASK_CLARIFYING + " " +
		"Return ONLY a JSON object — no markdown, no code fences, no explanation. Use exactly these " +
		'field names: {"interpretation": "one sentence", "queries": ["query 1", "query 2", ...]} ' +
		"with 3 to 6 entries in queries."
	);
}

function evaluatorSystem(today: string): string {
	return (
		"You are assessing whether a research pass has adequate source coverage for its topic. " +
		"Be conservative: only propose follow-up queries if there is a clear, important gap — " +
		"missing a major angle, or sources that are too shallow/off-topic to answer the question. " +
		"If coverage is already reasonable, say so and propose no follow-ups. " +
		today + " " + NEVER_ASK_CLARIFYING + " " +
		"Return ONLY a JSON object — no markdown, no code fences, no explanation. Use exactly these " +
		'field names: {"needMore": boolean, "followupQueries": ["query 1", ...]} with at most 3 ' +
		"entries in followupQueries (empty array if needMore is false)."
	);
}

function synthesisSystem(today: string): string {
	return (
		"You are writing a thorough, long-form research report in markdown, using ONLY the numbered " +
		"sources provided — do not invent facts beyond them. Add inline numbered citations like [1] or " +
		"[2] immediately after claims drawn from a source. End with a '## Sources' section listing each " +
		"number, its title, and its URL. If some sub-topics were only thinly covered by the available " +
		"sources, say so explicitly rather than overstating confidence. Write the best possible report " +
		"from what was gathered — " +
		today + " " + NEVER_ASK_CLARIFYING
	);
}

interface GatheredSource {
	title: string;
	url: string;
	text: string;
}

interface PlanResult {
	interpretation: string;
	queries: string[];
}

function coercePlan(raw: Record<string, unknown>, topic: string): PlanResult {
	const queries = Array.isArray(raw.queries) ? raw.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0) : [];
	return {
		interpretation: typeof raw.interpretation === "string" && raw.interpretation.trim() ? raw.interpretation : topic,
		// Never leave queries empty even if parsing degraded — fall back to the raw topic
		// itself as a single query so the loop always has something to search for.
		queries: queries.length > 0 ? queries.slice(0, PLAN_QUERY_HARD_CAP) : [topic],
	};
}

interface EvalResult {
	needMore: boolean;
	followupQueries: string[];
}

function coerceEvaluation(raw: Record<string, unknown>): EvalResult {
	const followupQueries = Array.isArray(raw.followupQueries)
		? raw.followupQueries.filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, MAX_REFINEMENT_QUERIES)
		: [];
	// Conservative on parse failure: don't refine if we can't trust the verdict.
	return { needMore: raw.needMore === true && followupQueries.length > 0, followupQueries };
}

async function runSearch(
	query: string,
	signal: AbortSignal,
	dateRangeOpts: DateRangeOpts,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
	const execute = webTools.web_search.tool.execute;
	if (!execute) return [];
	try {
		const raw = await execute(
			{ query, maxResults: MAX_RESULTS_PER_QUERY, dateRange: dateRangeOpts.range, startDate: dateRangeOpts.startDate, endDate: dateRangeOpts.endDate },
			{ toolCallId: crypto.randomUUID(), messages: [], abortSignal: signal } as never,
		);
		const parsed = JSON.parse(raw as string) as { results?: Array<{ title: string; url: string; snippet: string }>; error?: string };
		return parsed.results ?? [];
	} catch {
		return [];
	}
}

async function searchAndDedupe(
	queries: string[],
	signal: AbortSignal,
	seen: Map<string, { title: string; snippet: string }>,
	dateRangeOpts: DateRangeOpts,
): Promise<void> {
	const batches = await Promise.all(queries.map((q) => runSearch(q, signal, dateRangeOpts)));
	for (const results of batches) {
		for (const r of results) {
			if (!seen.has(r.url)) seen.set(r.url, { title: r.title, snippet: r.snippet });
		}
	}
}

async function fetchSourcesWithConcurrencyCap(urls: string[], titles: Map<string, string>, signal: AbortSignal): Promise<GatheredSource[]> {
	const out: GatheredSource[] = [];
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < urls.length) {
			const url = urls[cursor++];
			const page = await fetchPageText(url, { abortSignal: signal, timeoutMs: PER_FETCH_TIMEOUT_MS, maxChars: FETCH_MAX_CHARS });
			if (page.ok && page.text.length > 0) {
				out.push({ title: titles.get(url) ?? url, url, text: page.text });
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, () => worker()));
	return out;
}

export interface DeepResearchContext {
	providerConfig: ProviderConfig;
	modelId: string;
	thinkingBudget?: number;
	projectId?: string;
}

export function createDeepResearchTool(ctx: DeepResearchContext): Record<string, ToolRegistryEntry> {
	const model = createProviderAdapter(ctx.providerConfig).createModel(
		internalCallModelId(ctx.providerConfig.providerType, ctx.modelId),
		ctx.thinkingBudget,
	);

	const deepResearchTool = tool({
		description:
			"Autonomously research a BROAD topic in depth: plans sub-questions, searches the web " +
			"multiple times, reads full pages from many sources, and synthesizes a long-form cited " +
			"markdown report — in ONE call, instead of you making many manual web_search calls " +
			"yourself. Use this whenever a task asks you to: research across several distinct " +
			"sources/platforms/communities (e.g. Reddit, X, Indie Hackers, Product Hunt, G2, forums) " +
			"and cross-check or synthesize findings; validate or evaluate a business/product idea, " +
			"market, or investment opportunity against evidence from multiple sources; compare options " +
			"or survey the state of something; or produce ONE consolidated recommendation/report that " +
			"depends on cross-referencing many independent sources rather than one lookup. That is " +
			"exactly this tool's job — reach for it instead of a string of individual web_search calls " +
			"whenever a task's own instructions describe that kind of broad, multi-source research. " +
			"For quick lookups instead — error messages, package/library questions, API docs, or " +
			"checking one specific fact — use web_search, which is faster and cheaper. Give it one " +
			"topic (condense a long task into its research question if needed); it never asks " +
			"clarifying questions — it assumes a reasonable interpretation and proceeds autonomously, " +
			"which is required since this may run unattended via schedules.",
		inputSchema: z.object({
			topic: z
				.string()
				.min(1)
				.describe(
					"The research topic or question to investigate in depth. Provide as much context as " +
					"you have — the tool autonomously plans sub-questions and will NOT ask you to clarify.",
				),
			dateRange: z
				.enum(["day", "week", "month", "year"])
				.optional()
				.describe(
					"Restrict sources to this ROLLING window from today (e.g. 'month' = last 30 days). " +
					"Not a calendar period — for 'this year', 'last 6 months', etc., use startDate/endDate.",
				),
			startDate: z.string().optional().describe("YYYY-MM-DD. Exact range start — use with endDate. Overrides dateRange if both are given."),
			endDate: z.string().optional().describe("YYYY-MM-DD. Exact range end — use with startDate."),
		}),
		execute: async ({ topic, dateRange, startDate, endDate }, { abortSignal: execAbortSignal }): Promise<string> => {
			const signal = execAbortSignal
				? AbortSignal.any([execAbortSignal, AbortSignal.timeout(INTERNAL_TIMEOUT_MS)])
				: AbortSignal.timeout(INTERNAL_TIMEOUT_MS);
			const dateRangeOpts: DateRangeOpts = { range: dateRange, startDate, endDate };
			const today = dateContext();

			let queriesUsed: string[] = [];
			const seen = new Map<string, { title: string; snippet: string }>();
			let sources: GatheredSource[] = [];
			let roundsUsed = 1;
			let interpretation = "";

			try {
				// Step 1 — plan
				const planRaw = await generateText({
					model,
					abortSignal: signal,
					maxRetries: LLM_MAX_RETRIES,
					system: plannerSystem(today),
					prompt: `Research topic:\n${topic}`,
				});
				const plan = coercePlan(
					(() => {
						try { return extractJsonFromText(planRaw.text); } catch { return {}; }
					})(),
					topic,
				);
				interpretation = plan.interpretation;
				queriesUsed = plan.queries;

				// Step 2 — search + dedupe
				await searchAndDedupe(queriesUsed, signal, seen, dateRangeOpts);

				// Step 3 — fetch full text for top unique sources
				const titles = new Map(Array.from(seen.entries()).map(([url, v]) => [url, v.title]));
				const urls = Array.from(seen.keys()).slice(0, MAX_SOURCES_FETCHED);
				sources = await fetchSourcesWithConcurrencyCap(urls, titles, signal);

				// Step 4 — optional refinement round
				if (sources.length > 0 && MAX_ROUNDS > 1) {
					const evalPrompt =
						`Topic: ${topic}\n\nSources gathered so far:\n` +
						sources.map((s, i) => `${i + 1}. ${s.title} — ${s.url}\n${s.text.slice(0, 500)}`).join("\n\n");
					const evalRaw = await generateText({
						model,
						abortSignal: signal,
						maxRetries: LLM_MAX_RETRIES,
						system: evaluatorSystem(today),
						prompt: evalPrompt,
					});
					const evaluation = coerceEvaluation(
						(() => {
							try { return extractJsonFromText(evalRaw.text); } catch { return {}; }
						})(),
					);
					if (evaluation.needMore && evaluation.followupQueries.length > 0) {
						const followups = evaluation.followupQueries.slice(0, MAX_REFINEMENT_QUERIES);
						queriesUsed.push(...followups);
						await searchAndDedupe(followups, signal, seen, dateRangeOpts);
						const remaining = MAX_SOURCES_FETCHED - sources.length;
						if (remaining > 0) {
							const newUrls = Array.from(seen.keys())
								.filter((u) => !sources.some((s) => s.url === u))
								.slice(0, remaining);
							const newTitles = new Map(Array.from(seen.entries()).map(([url, v]) => [url, v.title]));
							const newSources = await fetchSourcesWithConcurrencyCap(newUrls, newTitles, signal);
							sources.push(...newSources);
						}
						roundsUsed = 2;
					}
				}

				// Step 5 — synthesize
				if (sources.length === 0) {
					return JSON.stringify({
						topic,
						interpretation,
						queriesUsed,
						sourcesUsed: [],
						roundsUsed,
						report: "No usable sources could be retrieved for this topic — all searches and/or page fetches failed. Consider retrying, or falling back to `web_search` for a lighter-weight attempt.",
					});
				}

				const sourcesBlock = sources
					.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${s.text.slice(0, SYNTHESIS_CHARS_PER_SRC)}`)
					.join("\n\n---\n\n");
				const synthesis = await generateText({
					model,
					abortSignal: signal,
					maxRetries: LLM_MAX_RETRIES,
					system: synthesisSystem(today),
					prompt: `Topic: ${topic}\n\nInterpretation: ${interpretation}\n\nSources:\n${sourcesBlock}`,
				});

				return JSON.stringify({
					topic,
					interpretation,
					queriesUsed,
					sourcesUsed: sources.map((s) => ({ title: s.title, url: s.url })),
					roundsUsed,
					report: synthesis.text,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// Best-effort: if we'd already gathered sources before the failure
				// (e.g. the internal timeout fired during synthesis), still hand
				// back what was found rather than losing it entirely.
				if (sources.length > 0) {
					return JSON.stringify({
						topic,
						interpretation,
						queriesUsed,
						sourcesUsed: sources.map((s) => ({ title: s.title, url: s.url })),
						roundsUsed,
						report: `Research was interrupted before a final report could be synthesized (${message}). Sources gathered so far are listed below.`,
						error: message,
					});
				}
				return JSON.stringify({ topic, error: message, queriesUsed, sourcesUsed: [] });
			}
		},
	});

	return { deep_research: { tool: deepResearchTool, category: "web" } };
}
