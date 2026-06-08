import he from "he";
import { generateText, stepCountIs } from "ai";
import { z } from "zod";
import { eq, and, notInArray, desc } from "drizzle-orm";
import { parse as parseHtml } from "node-html-parser";
import { sqlite } from "../db/connection";
import { db } from "../db";
import { freelanceListings, aiProviders } from "../db/schema";
import { createProviderAdapter } from "../providers";
import { broadcastToWebview } from "../engine-manager";
import { getAllTools } from "../agents/tools/index";
import { autoApprovedShellTool } from "../agents/tools/shell";
import { buildSkillsDescriptionSection } from "../agents/prompts";
import { getFreelanceSettings, saveFreelanceSetting } from "../freelance/settings";
import { getAutoEarnSettings } from "../freelance/auto-earn-settings";
import { isAutoEarnFeatureAvailable } from "../freelance/feature-flag";
import { draftBidForListing } from "../freelance/bid-pipeline";
import { escalateToHuman } from "../freelance/expert/notify";
import { FREELANCE_EVENTS } from "../freelance/events";
import { formatBudget } from "../freelance/budget";
import { sendDesktopNotification } from "../notifications/desktop";
import type { WizardWorkableListing, WizardFailedListing } from "../../shared/rpc/freelance";

// ---------------------------------------------------------------------------
// Provider resolution for wizard / auto-shortlist
// Uses analysisProviderId from freelance settings if set; falls back to default.
// ---------------------------------------------------------------------------

async function getAnalysisProviderAndModel(): Promise<{
  adapter: ReturnType<typeof createProviderAdapter>;
  modelId: string;
}> {
  const s = await getFreelanceSettings();
  const providerId = s.analysisProviderId;

  let row: typeof aiProviders.$inferSelect | undefined;

  if (providerId) {
    const rows = await db.select().from(aiProviders).where(eq(aiProviders.id, providerId)).limit(1);
    row = rows[0];
  }

  // Fall back to default provider if no analysisProviderId or it no longer exists
  if (!row) {
    const rows = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
    row = rows[0];
  }

  if (!row) throw new Error("No AI provider configured");

  const adapter = createProviderAdapter({
    id: row.id,
    name: row.name,
    providerType: row.providerType,
    apiKey: row.apiKey,
    baseUrl: row.baseUrl ?? null,
    defaultModel: row.defaultModel ?? null,
  });

  return { adapter, modelId: row.defaultModel ?? "gpt-4o-mini" };
}

// ---------------------------------------------------------------------------
// Improvement 6 — Keyword pre-filter
// Patterns that strongly indicate non-software / non-digital work.
// Conservative list — only blindingly obvious physical/in-person cases.
// ---------------------------------------------------------------------------

const NON_SOFTWARE_PATTERNS = [
  /\bin[- ]person\b/i,
  /\bon[- ]?site\b/i,
  /\bmust be (present|local|on[- ]?site)\b/i,
  /\bphysical (installation|product|assembly|manufacturing)\b/i,
  /\b(plumbing|electrical wiring|welding|carpentry|masonry)\b/i,
  /\b(cooking|catering|food (prep|preparation))\b/i,
  /\b(house ?cleaning|janitorial|housekeeping)\b/i,
  /\b(courier|delivery driver|chauffeur|truck driver)\b/i,
  /\bcnc machining\b/i,
  /\binjection mold(ing)?\b/i,
  /\bmetal fabrication\b/i,
  /\bphoto ?shoot\b/i,
  /\bfilming on location\b/i,
  /\blive event (filming|photography|recording)\b/i,
];

function isObviouslyNonSoftware(listing: typeof freelanceListings.$inferSelect): boolean {
  let skills: string[] = [];
  try { skills = JSON.parse(listing.skills) as string[]; } catch { /* ignore */ }
  const corpus = [listing.title, listing.description, ...skills].join(" ");
  return NON_SOFTWARE_PATTERNS.some((p) => p.test(corpus));
}

// ---------------------------------------------------------------------------
// Tool subset (same as freelance chat)
// ---------------------------------------------------------------------------

const FREELANCE_TOOL_NAMES = new Set([
  "read_file", "list_directory", "search_files", "search_content", "directory_tree",
  "run_shell",
  "web_search", "web_fetch", "http_request", "enhanced_web_search",
  "environment_info", "get_env", "get_agentdesk_paths", "sleep",
  "run_background", "check_process", "kill_process", "list_background_jobs",
  "read_skill", "read_skill_file", "find_skills",
]);

function buildWizardTools() {
  const all = getAllTools();
  const result: Record<string, ReturnType<typeof getAllTools>[string]> = {};
  for (const [name, tool] of Object.entries(all)) {
    if (FREELANCE_TOOL_NAMES.has(name)) result[name] = tool;
  }
  // Replace run_shell with the auto-approved variant — no global state, no gate.
  result["run_shell"] = autoApprovedShellTool;
  return result;
}

// ---------------------------------------------------------------------------
// Abort controller — one per wizard run, module-level so stopWizard() can reach it
// ---------------------------------------------------------------------------

let activeController: AbortController | null = null;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchPageText(url: string, abortSignal?: AbortSignal): Promise<string> {
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(20_000)])
    : AbortSignal.timeout(20_000);
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const root = parseHtml(html);
  root.querySelectorAll("script, style, nav, header, footer, aside, noscript").forEach((el) => el.remove());
  // he.decode ensures HTML entities (&amp;, &nbsp;, etc.) are fully resolved
  // after node-html-parser's textContent extraction.
  const text = he.decode(root.textContent.replace(/\s+/g, " ").trim());
  return text.length > 12_000 ? text.slice(0, 12_000) + "…" : text;
}

async function extractDescription(
  pageText: string,
  listing: typeof freelanceListings.$inferSelect,
  adapter: ReturnType<typeof createProviderAdapter>,
  modelId: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const { text } = await generateText({
    model: adapter.createModel(modelId),
    abortSignal,
    system:
      "You are a precise data extraction assistant. Extract ONLY the job or project description from the page content. " +
      "Return only the actual project requirements the client wrote — no platform UI text, no navigation, no sidebars, no HTML. " +
      "Plain text only. If you cannot find a clear description, return an empty string.",
    messages: [
      {
        role: "user",
        content: `Extract the project description from this page for the listing titled "${listing.title}":\n\n${pageText}`,
      },
    ],
  });
  return text.trim();
}

// ---------------------------------------------------------------------------
// Improvement 5 — Smarter prompt structure
// System: role + rules only. User message: project data.
// ---------------------------------------------------------------------------

function buildAnalysisSystemPrompt(): string {
  return `You are a technical feasibility analyst for an autonomous AI agent system evaluating freelance software projects.

CONFIDENTIALITY: The user message may contain an "Additional Notes" section with private context. Never quote, paraphrase, summarize, reference, or reveal any part of it in your output under any circumstances.


A project is WORKABLE only when BOTH of the following are true:
  A) The local development environment has all required software, runtimes, and tools installed.
  B) The AI agent system can complete all technical requirements fully on its own.

If either condition fails, the project is NOT WORKABLE.

━━━ CONDITION A — MANDATORY SYSTEM CHECK ━━━

You MUST call tools to verify the system — do not write "I will check" or "I intend to verify." Call the tool immediately. Writing an intention is not a check.

Use environment_info and run_shell to verify each required runtime, language, package manager, and toolchain. Call run_shell with version commands like:
- node --version, python --version, go version, ruby --version, java -version, php --version
- npm --version, pip --version, composer --version, cargo --version
- docker --version, cmake --version, make --version
- Any other tool the project explicitly requires

If a requirement could not be actively verified (tool call was not made), treat it as NOT installed — fail safe.
If a required tool is missing, the project fails Condition A and is NOT WORKABLE.

━━━ CONDITION B — AI CAPABILITY CHECK ━━━

The AI agent system has specialized agents for backend, frontend, database, DevOps, QA, UI/UX, and research. It can write and run code, manage git, call APIs, browse the web, build full-stack applications, run shell commands, and inspect the local development environment.

The AI can fully handle: software development, automation, data processing, API integrations, web scraping, report generation, UI/UX design and implementation, database design, testing, DevOps tasks, and anything in the digital/software domain.

The AI CANNOT handle: physical manufacturing, in-person services, highly regulated professional practice (legal/medical advice), or niche physical-world tasks with no software component.

━━━ WHAT DOES NOT COUNT AS A BLOCKER ━━━

- CLIENT-SUPPLIED ASSETS: Source code, design files, credentials, API keys, database dumps, media — the client provides these. Treat them as available.
- EXPERIENCE/PORTFOLIO: "5+ years experience", "show past work" — these are proposal concerns, not technical blockers.
- BUDGET: Low or unspecified budget is a negotiation concern, not a technical one.
- CLIENT COMMUNICATION: Asking the client for clarification or assets is normal freelancing, not a technical gap.

━━━ REQUIRED OUTPUT FORMAT ━━━

You MUST still call the tools to verify the system — but the reader NEVER sees your tool calls. Do NOT list, echo, or paste individual tool calls, shell commands, raw command output, or JSON anywhere in your answer. Summarise what you found in natural language.

Write your analysis as clean **markdown prose** using this structure:

## Condition A — System Check: PASS / FAIL

In prose, name the required runtimes, tools, and dependencies you confirmed are installed (with the versions you found, e.g. "Node.js v24.3.0, npm 11.x, PHP 8.4, Git"), and any required ones that are missing or could not be verified. Treat anything you could not actively verify as NOT installed.

## Condition B — AI Capability: PASS / FAIL

One or two sentences on whether the AI agent system can fully deliver the project's requirements.

## Verdict: WORKABLE / NOT WORKABLE

WORKABLE only if Condition A and Condition B BOTH pass.

**Reason:** [one sentence summarising the decision]

**Blockers:**
- [specific missing tool/dependency, or specific AI limitation]
(write "none" if workable)

If you could not run any tool calls to verify the system, write one short paragraph saying so, mark Condition A as FAIL, and set the verdict NOT WORKABLE.`;
}

function buildUserMessage(
  listing: typeof freelanceListings.$inferSelect,
  fullDescription: string | null,
  additionalNotes?: string,
): string {
  let skills: string[] = [];
  try { skills = JSON.parse(listing.skills) as string[]; } catch { /* ignore */ }

  const description = (fullDescription && fullDescription.length > 0) ? fullDescription : listing.description;
  const skillsSection = buildSkillsDescriptionSection(false);

  const lines = [
    "Analyze the following freelance project for AI workability.",
    "",
    `Title: ${listing.title}`,
    `Platform: ${listing.platform === "upwork" ? "Upwork" : "Freelancer.com"}`,
    `Budget: ${formatBudget(listing.budgetMin, listing.budgetMax, listing.budgetType, listing.currency)}`,
    `Skills required: ${skills.length > 0 ? skills.join(", ") : "Not specified"}`,
    listing.postedAt ? `Posted: ${listing.postedAt}` : "",
    "",
    "Project description:",
    description,
  ].filter((l) => l !== undefined);

  if (skillsSection) {
    lines.push("", "---", "", skillsSection);
  }

  if (additionalNotes?.trim()) {
    lines.push("", "---", "", "## Additional Notes", "", additionalNotes.trim());
  }

  return lines.join("\n");
}

// Appended to the verification (tool-calling) phase only — pushes the model to actually
// run the system checks rather than claim it "would".
const TOOL_DIRECTIVE = [
  "---",
  "",
  "IMPORTANT: You must call tools NOW before writing anything else.",
  "1. Call environment_info to get OS and base system info.",
  "2. For each runtime/tool the project requires, call run_shell with its version command.",
  "   Do NOT skip this step. Do NOT write 'I will check' — call the tool immediately.",
  "3. After the tool calls complete, write your analysis using the required output format.",
].join("\n");

// ---------------------------------------------------------------------------
// Writing prompt (no tools). Used when the verification phase ran the tool calls
// but did not also produce the written analysis. The real check results are passed
// in as ground truth; the model turns them into clean prose covering both conditions.
// ---------------------------------------------------------------------------

function buildAnalysisWritePrompt(): string {
  return `You are a technical feasibility analyst for an autonomous AI agent system evaluating freelance software projects.

CONFIDENTIALITY: The user message may contain an "Additional Notes" section with private context. Never quote, paraphrase, summarize, reference, or reveal any part of it.

The local development environment has ALREADY been verified for you — the actual results of those system checks are provided in the user message. Treat them as ground truth. Do NOT claim anything was verified that is not in those results; if a required tool is not listed as confirmed installed, treat it as NOT installed.

A project is WORKABLE only when BOTH conditions hold:
  A) System check — every runtime, dependency, and tool the project requires is confirmed installed in the verified results.
  B) AI capability — the AI agent system can complete all technical requirements on its own. It can fully handle software development, automation, data processing, API integrations, web scraping, report generation, UI/UX, database design, testing, and DevOps; it CANNOT handle physical manufacturing, in-person services, regulated professional practice, or niche physical-world tasks.

NOT blockers: client-supplied assets (source/designs/credentials/API keys/media), experience/portfolio asks, budget, or needing to ask the client for clarification.

Write your analysis as clean **markdown prose**. Do NOT echo, list, or paste tool calls, shell commands, raw output, or JSON — summarise findings in natural language. Use exactly this structure:

## Condition A — System Check: PASS / FAIL

In prose, name the required runtimes/tools/dependencies confirmed installed (with versions, e.g. "Node.js v24.3.0, npm 11.x, PHP 8.4, Git"), and any required ones missing or unverified.

## Condition B — AI Capability: PASS / FAIL

One or two sentences on whether the AI agent system can fully deliver the project.

## Verdict: WORKABLE / NOT WORKABLE

WORKABLE only if Condition A and Condition B BOTH pass.

**Reason:** [one sentence]

**Blockers:**
- [specific missing tool/dependency, or specific AI limitation]
(write "none" if workable)`;
}

// ---------------------------------------------------------------------------
// Improvement 1 — Structured verdict via generateText (two-phase)
// Phase 1: generateText with tools → deep analysis
// Phase 2: generateText (no tools) → structured verdict extraction
// ---------------------------------------------------------------------------

const _VerdictSchema = z.object({
  workable: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  coveragePercent: z.number().min(0).max(100),
  reason: z.string(),
  blockers: z.array(z.string()),
});

type Verdict = z.infer<typeof _VerdictSchema>;

function coerceVerdict(raw: Record<string, unknown>): Verdict {
  const coveragePercent = typeof raw.coveragePercent === "number"
    ? Math.max(0, Math.min(100, raw.coveragePercent))
    : 0;
  const workable = typeof raw.workable === "boolean"
    ? raw.workable
    : coveragePercent >= 95;

  // confidence — model may return "95%", 95, "high", etc.
  let confidence: "high" | "medium" | "low" = "medium";
  const rawConf = raw.confidence;
  if (rawConf === "high" || rawConf === "medium" || rawConf === "low") {
    confidence = rawConf;
  } else {
    const num = typeof rawConf === "number" ? rawConf : parseFloat(String(rawConf ?? ""));
    if (!isNaN(num)) confidence = num >= 80 ? "high" : num >= 50 ? "medium" : "low";
  }

  // reason — model may use "reason", "answer", or join array "reasons"
  let reason = "";
  if (typeof raw.reason === "string" && raw.reason) {
    reason = raw.reason;
  } else if (typeof raw.answer === "string" && raw.answer) {
    reason = raw.answer;
  } else if (Array.isArray(raw.reasons) && raw.reasons.length > 0) {
    reason = (raw.reasons as string[]).slice(0, 2).join(" ");
  } else if (Array.isArray(raw.reason) && raw.reason.length > 0) {
    reason = (raw.reason as string[]).slice(0, 2).join(" ");
  }

  // blockers — model may use "blockers", "reasons", or omit entirely
  let blockers: string[] = [];
  if (Array.isArray(raw.blockers)) {
    blockers = raw.blockers as string[];
  } else if (!workable && Array.isArray(raw.reasons)) {
    blockers = (raw.reasons as string[]).slice(0, 5);
  }

  return { workable, confidence, coveragePercent, reason, blockers };
}

function extractJsonFromText(text: string): Record<string, unknown> {
  // Strip markdown code fences (```json ... ``` and plain ``` ... ```)
  const stripped = text.replace(/```[a-z]*\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = stripped.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in verdict text");

  // Walk backwards from each candidate closing brace so trailing prose after
  // the JSON object doesn't break parsing (e.g. "} Some explanation here")
  let end = stripped.lastIndexOf("}");
  while (end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      end = stripped.lastIndexOf("}", end - 1);
    }
  }
  throw new Error("No valid JSON object found in verdict text");
}

function formatToolOutput(toolName: string, output: unknown): string {
  // For run_shell: extract readable stdout/stderr instead of the raw JSON envelope
  if (toolName === "run_shell" && typeof output === "object" && output !== null) {
    const o = output as { exitCode?: number; stdout?: string; stderr?: string };
    const clean = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    const stdout = clean(String(o.stdout ?? ""));
    const stderr = clean(String(o.stderr ?? ""));
    const code = Number(o.exitCode ?? 0);
    if (stdout) return stdout.slice(0, 500);
    if (stderr) return `(stderr) ${stderr.slice(0, 500)}`;
    return code === 0 ? "(no output)" : `(exit ${code})`;
  }
  const raw = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().slice(0, 1500);
}

async function analyzeListingWorkability(
  listing: typeof freelanceListings.$inferSelect,
  fullDescription: string | null,
  adapter: ReturnType<typeof createProviderAdapter>,
  modelId: string,
  abortSignal?: AbortSignal,
  additionalNotes?: string,
): Promise<{ verdict: Verdict; analysisText: string }> {
  const tools = buildWizardTools();
  const userMessage = buildUserMessage(listing, fullDescription, additionalNotes);

  // Phase 1 — VERIFY the system with real tool calls (environment_info + run_shell version
  // checks) AND write the prose analysis. toolChoice "auto" lets the model run the checks
  // and then write its analysis in the same loop. If it skips the checks entirely we force
  // them below — Condition A requires actual verification.
  let phase1Result = await generateText({
    model: adapter.createModel(modelId),
    abortSignal,
    system: buildAnalysisSystemPrompt(),
    messages: [{ role: "user", content: `${userMessage}\n\n${TOOL_DIRECTIVE}` }],
    tools,
    toolChoice: "auto",
    stopWhen: [stepCountIs(8)],
  });

  const collectToolResults = (r: typeof phase1Result): string[] => {
    const out: string[] = [];
    for (const step of r.steps) {
      const results = step.toolResults as unknown as Array<{ toolName: string; output: unknown }> | undefined;
      for (const tr of results ?? []) {
        out.push(`- ${tr.toolName}: ${formatToolOutput(tr.toolName, tr.output)}`);
      }
    }
    return out;
  };

  let toolResultLines = collectToolResults(phase1Result);

  // The model MUST actually verify the system. If it skipped every tool call, force them.
  // (Some reasoning models reject toolChoice "required" — if so we proceed with what we
  // have, and the analysis correctly fails Condition A as unverified.)
  if (toolResultLines.length === 0) {
    try {
      phase1Result = await generateText({
        model: adapter.createModel(modelId),
        abortSignal,
        system: buildAnalysisSystemPrompt(),
        messages: [{ role: "user", content: `${userMessage}\n\n${TOOL_DIRECTIVE}` }],
        tools,
        toolChoice: "required",
        stopWhen: [stepCountIs(6)],
      });
      toolResultLines = collectToolResults(phase1Result);
    } catch (forceErr) {
      if (isAbortError(forceErr)) throw forceErr;
      console.warn(`[wizard] forced tool verification failed: ${forceErr instanceof Error ? forceErr.message : forceErr}`);
    }
  }

  // Real tool results stay INTERNAL — used to write the analysis (if needed) and to ground
  // the verdict. They are NEVER persisted or shown to the user (no raw tool dumps in the UI).
  const toolContext = toolResultLines.length > 0
    ? toolResultLines.join("\n")
    : "No system checks could be performed.";

  let analysisText = phase1Result.text.trim();

  // If verification ran but the model didn't also write the analysis (common when tools were
  // forced), produce the prose now from the real results — no tools, no raw dump.
  if (!analysisText) {
    try {
      const written = await generateText({
        model: adapter.createModel(modelId),
        abortSignal,
        system: buildAnalysisWritePrompt(),
        messages: [{
          role: "user",
          content: `${userMessage}\n\n---\n\n## Verified system results (ground truth — summarise in prose, never list raw)\n${toolContext}\n\nNow write the analysis in the required format.`,
        }],
      });
      analysisText = written.text.trim();
    } catch (writeErr) {
      if (isAbortError(writeErr)) throw writeErr;
      console.warn(`[wizard] analysis write phase failed: ${writeErr instanceof Error ? writeErr.message : writeErr}`);
    }
  }

  // Verdict extraction — structured reason/blockers. Grounded in BOTH the written analysis
  // and the real tool results (internal). generateText (not generateObject) for broad
  // provider support; the JSON is parsed defensively.
  const fullContext = `## Analysis\n\n${analysisText || "(no written analysis was produced)"}\n\n## System checks (internal)\n\n${toolContext}`;
  const { text: verdictText } = await generateText({
    model: adapter.createModel(modelId),
    abortSignal,
    system:
      "You are a strict data extractor. Read the provided feasibility analysis and return ONLY a JSON object — " +
      "no markdown, no explanation, no code fences. Use exactly these field names:\n" +
      '{"workable": boolean, "confidence": "high"|"medium"|"low", "coveragePercent": number 0-100, "reason": "one or two sentence summary", "blockers": ["blocker 1", "blocker 2"]}\n\n' +
      "workable=true ONLY if: (A) all required system software was confirmed installed AND (B) the AI can fully complete the project. " +
      "If either condition failed, workable=false. " +
      "blockers must list the concrete reasons: specific missing tools/dependencies, or specific AI limitations. " +
      "Do NOT list 'incomplete analysis' as a blocker — if the system could not be verified, list the unverified requirements as missing instead.",
    messages: [
      { role: "user", content: `Extract a structured verdict from this feasibility analysis:\n\n${fullContext}` },
    ],
  });

  let verdict: Verdict;
  try {
    const rawJson = extractJsonFromText(verdictText);
    verdict = coerceVerdict(rawJson);
  } catch (parseErr) {
    console.warn(`[wizard] verdict JSON parse failed (${parseErr}), falling back to heuristic`);
    // Conservative: only trust an explicit JSON-like workable=true signal in the verdict text.
    const vLower = verdictText.toLowerCase();
    const workable =
      (vLower.includes('"workable":true') || vLower.includes('"workable": true')) &&
      !vLower.includes('"workable":false') &&
      !vLower.includes('"workable": false');
    verdict = {
      workable,
      confidence: "low",
      coveragePercent: workable ? 100 : 0,
      reason: "Verdict extracted from analysis text (structured parsing failed).",
      blockers: [],
    };
  }

  // The displayed/persisted analysis is the AI's written prose ONLY — never the raw tool
  // output. Normalise Windows line endings so \r doesn't render as a visible symbol.
  const normalizeNewlines = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const persistedAnalysis = normalizeNewlines(
    analysisText || "The analysis could not be generated this time. Please try analysing again.",
  );

  return { verdict, analysisText: persistedAnalysis };
}

// ---------------------------------------------------------------------------
// Improvement 2 — Verdict caching (24-hour TTL)
// ---------------------------------------------------------------------------

const VERDICT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function isCacheValid(listing: typeof freelanceListings.$inferSelect): boolean {
  if (!listing.wizardVerdict || !listing.wizardAnalyzedAt) return false;
  const age = Date.now() - new Date(listing.wizardAnalyzedAt).getTime();
  return age < VERDICT_TTL_MS;
}

// ---------------------------------------------------------------------------
// Core wizard runner
// ---------------------------------------------------------------------------

async function runWizard(count: number): Promise<void> {
  const controller = new AbortController();
  activeController = controller;
  const { signal } = controller;

  const workableListings: WizardWorkableListing[] = [];
  const failedListings: WizardFailedListing[] = [];
  // Verdicts are only persisted to DB when the wizard completes successfully (not when stopped).
  // This prevents stopped runs from polluting the cache for future runs.
  const verdictMap = new Map<string, { verdict: "workable" | "not_workable"; reason: string; blockers: string[]; analysisText: string }>();
  try {
    let adapter: ReturnType<typeof createProviderAdapter>;
    let modelId: string;
    try {
      ({ adapter, modelId } = await getAnalysisProviderAndModel());
    } catch {
      broadcastToWebview(FREELANCE_EVENTS.WIZARD_ERROR, { error: "No AI provider configured" });
      return;
    }

    const additionalNotes = await getFreelanceSettings().then((s) => s.additionalNotes).catch(() => "");

    // Always take the N most-recent listings regardless of prior analysis.
    // Cached entries get an instant verdict read; new entries get AI analysis.
    // Shortlisted entries are included — they're still recent and their cached
    // workable verdict should remain visible on re-runs.
    // Only approved and closed listings are excluded (they're done).
    const baseWhere = and(
      eq(freelanceListings.isDeleted, 0),
      notInArray(freelanceListings.status, ["approved", "closed"]),
    );

    const candidates = await db
      .select()
      .from(freelanceListings)
      .where(baseWhere)
      .orderBy(desc(freelanceListings.fetchedAt))
      .limit(count);

    if (candidates.length === 0) {
      broadcastToWebview(FREELANCE_EVENTS.WIZARD_COMPLETE, { workableListings: [], failedListings: [] });
      return;
    }

    const total = candidates.length;

    // ---------------------------------------------------------------------------
    // Phase 1 — Pre-fetch full descriptions in parallel (I/O-bound, 3 at a time)
    // This runs before the sequential AI analysis phase to minimise wall time.
    // Only listings that need a fresh fetch (fullDescription === null and not
    // obviously non-software and not cached) are fetched here.
    // ---------------------------------------------------------------------------
    const DESC_CONCURRENCY = 3;
    const needsDescFetch = candidates.filter(
      (l) => l.fullDescription === null && !isObviouslyNonSoftware(l) && !isCacheValid(l),
    );

    for (let i = 0; i < needsDescFetch.length; i += DESC_CONCURRENCY) {
      if (signal.aborted) break;
      const batch = needsDescFetch.slice(i, i + DESC_CONCURRENCY);
      await Promise.all(batch.map(async (listing) => {
        if (signal.aborted) return;
        const idx = candidates.indexOf(listing);
        broadcastToWebview(FREELANCE_EVENTS.WIZARD_PROGRESS, {
          current: idx + 1, total, listingId: listing.id, title: listing.title, phase: "fetching",
        });
        try {
          const pageText = await fetchPageText(listing.url, signal);
          if (signal.aborted) return;
          listing.fullDescription = await extractDescription(pageText, listing, adapter, modelId, signal);
        } catch (err) {
          if (!isAbortError(err)) console.error(`[wizard] Failed to fetch description for ${listing.id}:`, err);
          listing.fullDescription = "";
        }
        if (!signal.aborted && listing.fullDescription !== null) {
          await db.update(freelanceListings)
            .set({ fullDescription: listing.fullDescription })
            .where(eq(freelanceListings.id, listing.id));
        }
      }));
    }

    // ---------------------------------------------------------------------------
    // Phase 2 — Sequential AI analysis
    // ---------------------------------------------------------------------------
    for (let i = 0; i < candidates.length; i++) {
      if (signal.aborted) break;

      const listing = candidates[i];
      const current = i + 1;

      // Keyword pre-filter: skip obvious non-software listings immediately
      if (isObviouslyNonSoftware(listing)) {
        verdictMap.set(listing.id, { verdict: "not_workable", reason: "Non-software or in-person project detected.", blockers: [], analysisText: "This listing was automatically filtered out by keyword detection. It appears to require non-software or in-person work that AI agents cannot perform remotely." });
        failedListings.push({ id: listing.id, title: listing.title, reason: "Non-software or in-person project detected.", blockers: [] });
        broadcastToWebview(FREELANCE_EVENTS.WIZARD_PROGRESS, {
          current, total, listingId: listing.id, title: listing.title, phase: "done", workable: false,
        });
        continue;
      }

      // Use cached verdict if still fresh
      if (isCacheValid(listing)) {
        const workable = listing.wizardVerdict === "workable";
        broadcastToWebview(FREELANCE_EVENTS.WIZARD_PROGRESS, {
          current, total, listingId: listing.id, title: listing.title, phase: "done", workable,
        });
        if (workable) {
          workableListings.push({
            id: listing.id,
            title: listing.title,
            budgetMin: listing.budgetMin,
            budgetMax: listing.budgetMax,
            budgetType: listing.budgetType as "fixed" | "hourly",
            currency: listing.currency,
          });
        } else {
          failedListings.push({ id: listing.id, title: listing.title, reason: "Did not pass workability check (cached result).", blockers: [] });
        }
        continue;
      }

      if (signal.aborted) break;

      // AI feasibility analysis (two-phase, structured output)
      broadcastToWebview(FREELANCE_EVENTS.WIZARD_PROGRESS, {
        current, total, listingId: listing.id, title: listing.title, phase: "analyzing",
      });

      let workable = false;
      let failReason = "Analysis did not complete.";
      let failBlockers: string[] = [];
      try {
        const { verdict, analysisText } = await analyzeListingWorkability(
          listing, listing.fullDescription, adapter, modelId, signal, additionalNotes,
        );
        workable = verdict.workable;
        failReason = verdict.reason || failReason;
        failBlockers = verdict.blockers;
        verdictMap.set(listing.id, { verdict: workable ? "workable" : "not_workable", reason: verdict.reason, blockers: verdict.blockers, analysisText });
      } catch (err) {
        if (isAbortError(err)) break;
        console.error(`[wizard] AI analysis failed for ${listing.id}:`, err);
        workable = false;
        failReason = "Analysis encountered an error.";
      }

      if (signal.aborted) break;

      broadcastToWebview(FREELANCE_EVENTS.WIZARD_PROGRESS, {
        current, total, listingId: listing.id, title: listing.title, phase: "done", workable,
      });

      if (workable) {
        workableListings.push({
          id: listing.id,
          title: listing.title,
          budgetMin: listing.budgetMin,
          budgetMax: listing.budgetMax,
          budgetType: listing.budgetType as "fixed" | "hourly",
          currency: listing.currency,
        });
      } else {
        failedListings.push({ id: listing.id, title: listing.title, reason: failReason, blockers: failBlockers });
      }
    }

    if (signal.aborted) {
      broadcastToWebview(FREELANCE_EVENTS.WIZARD_STOPPED, { workableListings, failedListings });
    } else {
      broadcastToWebview(FREELANCE_EVENTS.WIZARD_COMPLETE, { workableListings, failedListings });
      // Persist verdicts only after a successful complete run (stopped runs stay
      // unanalyzed and will be re-examined fresh on the next wizard run).
      // All writes are done in a single transaction for atomicity.
      if (verdictMap.size > 0) {
        const now = new Date().toISOString();
        const stmt = sqlite.prepare(
          "UPDATE freelance_listings SET wizard_verdict = ?, wizard_analyzed_at = ?, wizard_reason = ?, wizard_blockers = ?, wizard_analysis_text = ? WHERE id = ?",
        );
        sqlite.transaction(() => {
          for (const [id, { verdict, reason, blockers, analysisText }] of verdictMap) {
            stmt.run(verdict, now, reason, JSON.stringify(blockers), analysisText, id);
          }
        })();
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      broadcastToWebview(FREELANCE_EVENTS.WIZARD_STOPPED, { workableListings, failedListings });
      return;
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[wizard] Fatal error:", err);
    broadcastToWebview(FREELANCE_EVENTS.WIZARD_ERROR, { error: errorMsg });
  } finally {
    if (activeController === controller) activeController = null;
  }
}

// ---------------------------------------------------------------------------
// RPC: startWizard
// ---------------------------------------------------------------------------

export async function startWizard(params: { count: number }): Promise<{ success: boolean }> {
  const count = Math.max(1, Math.min(25, params.count));
  runWizard(count).catch(() => {});
  return { success: true };
}

export function stopWizard(_params: Record<string, never>): { success: boolean } {
  if (activeController) {
    activeController.abort();
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// Auto Shortlist — silent background runner triggered after scheduled/startup fetch
// ---------------------------------------------------------------------------

// Guard to prevent concurrent auto-shortlist runs
let autoShortlistRunning = false;

export async function runAutoShortlist(source: "scheduled" | "startup"): Promise<void> {
  const s = await getFreelanceSettings();
  if (!s.autoShortlistEnabled) return;
  if (source === "startup" && !s.autoShortlistOnStartup) return;

  // Don't conflict with the user-facing wizard
  if (activeController !== null) {
    console.log("[auto-shortlist] Wizard is active, skipping.");
    return;
  }
  if (autoShortlistRunning) return;
  autoShortlistRunning = true;

  const controller = new AbortController();
  const { signal } = controller;

  const workableListings: WizardWorkableListing[] = [];
  const verdictMap = new Map<string, { verdict: "workable" | "not_workable"; reason: string; blockers: string[]; analysisText: string }>();

  try {
    let adapter: ReturnType<typeof createProviderAdapter>;
    let modelId: string;
    try {
      ({ adapter, modelId } = await getAnalysisProviderAndModel());
    } catch {
      return;
    }

    const additionalNotes = s.additionalNotes ?? "";
    const count = Math.max(1, Math.min(25, s.autoShortlistCount));

    const baseWhere = and(
      eq(freelanceListings.isDeleted, 0),
      notInArray(freelanceListings.status, ["approved", "closed", "shortlisted"]),
    );

    const candidates = await db
      .select()
      .from(freelanceListings)
      .where(baseWhere)
      .orderBy(desc(freelanceListings.fetchedAt))
      .limit(count);

    if (candidates.length === 0) return;

    for (const listing of candidates) {
      if (signal.aborted) break;

      if (isObviouslyNonSoftware(listing)) {
        verdictMap.set(listing.id, { verdict: "not_workable", reason: "Non-software or in-person project detected.", blockers: [], analysisText: "This listing was automatically filtered out by keyword detection. It appears to require non-software or in-person work that AI agents cannot perform remotely." });
        continue;
      }

      if (isCacheValid(listing)) {
        if (listing.wizardVerdict === "workable") {
          workableListings.push({
            id: listing.id,
            title: listing.title,
            budgetMin: listing.budgetMin,
            budgetMax: listing.budgetMax,
            budgetType: listing.budgetType as "fixed" | "hourly",
            currency: listing.currency,
          });
        }
        continue;
      }

      let fullDescription = listing.fullDescription;
      if (fullDescription === null) {
        try {
          const pageText = await fetchPageText(listing.url, signal);
          if (signal.aborted) break;
          fullDescription = await extractDescription(pageText, listing, adapter, modelId, signal);
        } catch (err) {
          if (isAbortError(err)) break;
          fullDescription = "";
        }
        if (signal.aborted) break;
        await db.update(freelanceListings).set({ fullDescription }).where(eq(freelanceListings.id, listing.id));
      }

      if (signal.aborted) break;

      try {
        const { verdict, analysisText } = await analyzeListingWorkability(listing, fullDescription, adapter, modelId, signal, additionalNotes);
        verdictMap.set(listing.id, { verdict: verdict.workable ? "workable" : "not_workable", reason: verdict.reason, blockers: verdict.blockers, analysisText });
        if (verdict.workable) {
          workableListings.push({
            id: listing.id,
            title: listing.title,
            budgetMin: listing.budgetMin,
            budgetMax: listing.budgetMax,
            budgetType: listing.budgetType as "fixed" | "hourly",
            currency: listing.currency,
          });
        }
      } catch (err) {
        if (isAbortError(err)) break;
        console.error(`[auto-shortlist] Analysis failed for ${listing.id}:`, err);
      }
    }

    if (!signal.aborted) {
      // Persist verdicts in a single transaction (same as runWizard)
      if (verdictMap.size > 0) {
        const now = new Date().toISOString();
        const stmt = sqlite.prepare(
          "UPDATE freelance_listings SET wizard_verdict = ?, wizard_analyzed_at = ?, wizard_reason = ?, wizard_blockers = ?, wizard_analysis_text = ? WHERE id = ?",
        );
        sqlite.transaction(() => {
          for (const [id, { verdict, reason, blockers, analysisText }] of verdictMap) {
            stmt.run(verdict, now, reason, JSON.stringify(blockers), analysisText, id);
          }
        })();
      }

      // Auto-shortlist workable listings
      if (workableListings.length > 0) {
        const nowTs = new Date().toISOString();
        for (const listing of workableListings) {
          await db.update(freelanceListings)
            .set({ status: "shortlisted", updatedAt: nowTs })
            .where(eq(freelanceListings.id, listing.id));
        }
        broadcastToWebview(FREELANCE_EVENTS.LISTINGS_UPDATED, { count: 0 });

        const body = workableListings.length === 1
          ? `"${workableListings[0].title}" has been auto-shortlisted.`
          : `${workableListings.length} listings have been auto-shortlisted.`;
        sendDesktopNotification("Auto Shortlist", body).catch(() => {});

        // Auto-bid (opt-in): draft a proposal for each newly shortlisted listing so
        // the user just reviews + places it. Off by default; gated on the autoearn
        // flag + master switch. Capped per run so the queue is never flooded; bids
        // are still never auto-placed.
        try {
          const ae = await getAutoEarnSettings();
          if (ae.enabled && ae.autoBidShortlisted && isAutoEarnFeatureAvailable()) {
            let drafted = 0;
            let failed = 0;
            let firstErr = "";
            for (const listing of workableListings) {
              if (drafted >= 5) break;
              const dup = sqlite
                .prepare(`SELECT 1 FROM freelance_outbox WHERE listing_id = ? AND kind = 'bid' AND status != 'rejected' LIMIT 1`)
                .get(listing.id);
              if (dup) continue;
              try {
                await draftBidForListing("freelancer", listing.id);
                drafted++;
              } catch (e) {
                failed++;
                if (!firstErr) firstErr = e instanceof Error ? e.message : String(e);
                console.error("[auto-bid] draft failed:", e);
              }
            }
            if (drafted > 0) broadcastToWebview(FREELANCE_EVENTS.OUTBOX_UPDATED, { count: drafted });
            // Surface drafting failures (provider down / config) instead of failing silently.
            if (failed > 0) {
              await escalateToHuman({
                platform: "freelancer",
                reason: "Auto-bid couldn't draft proposals",
                detail: `Failed to draft ${failed} proposal(s) for shortlisted listings. First error: ${firstErr}`,
                severity: "warn",
              });
            }
          }
        } catch (e) {
          console.error("[auto-bid] error:", e);
        }
      }

      // Update last run metadata
      const runTs = new Date().toISOString();
      await saveFreelanceSetting("autoShortlistLastRun", runTs);
      await saveFreelanceSetting("autoShortlistLastCount", workableListings.length);
    }
  } catch (err) {
    if (!isAbortError(err)) {
      console.error("[auto-shortlist] Fatal error:", err);
    }
  } finally {
    autoShortlistRunning = false;
  }
}

// ---------------------------------------------------------------------------
// RPC: analyzeListing — single-listing workability analysis
// ---------------------------------------------------------------------------

export async function analyzeListing(params: { listingId: string }): Promise<{
  verdict: "workable" | "not_workable";
  reason: string;
  blockers: string[];
  analysisText: string;
}> {
  const rows = await db.select().from(freelanceListings).where(eq(freelanceListings.id, params.listingId)).limit(1);
  const listing = rows[0];
  if (!listing) throw new Error(`Listing ${params.listingId} not found`);

  let adapter: ReturnType<typeof createProviderAdapter>;
  let modelId: string;
  try {
    ({ adapter, modelId } = await getAnalysisProviderAndModel());
  } catch {
    throw new Error("No AI provider configured");
  }

  let fullDescription = listing.fullDescription;
  if (fullDescription === null) {
    try {
      const pageText = await fetchPageText(listing.url);
      fullDescription = await extractDescription(pageText, listing, adapter, modelId);
    } catch {
      fullDescription = "";
    }
    await db.update(freelanceListings).set({ fullDescription }).where(eq(freelanceListings.id, listing.id));
  }

  const additionalNotes = await getFreelanceSettings().then((s) => s.additionalNotes).catch(() => "");

  try {
    const { verdict, analysisText } = await analyzeListingWorkability(listing, fullDescription, adapter, modelId, undefined, additionalNotes);

    const now = new Date().toISOString();
    sqlite.prepare(
      "UPDATE freelance_listings SET wizard_verdict = ?, wizard_analyzed_at = ?, wizard_reason = ?, wizard_blockers = ?, wizard_analysis_text = ? WHERE id = ?",
    ).run(
      verdict.workable ? "workable" : "not_workable",
      now,
      verdict.reason,
      JSON.stringify(verdict.blockers),
      analysisText,
      listing.id,
    );

    const result = {
      verdict: verdict.workable ? "workable" : "not_workable" as "workable" | "not_workable",
      reason: verdict.reason,
      blockers: verdict.blockers,
      analysisText,
    };

    broadcastToWebview(FREELANCE_EVENTS.LISTINGS_UPDATED, { count: 0 });
    return result;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ---------------------------------------------------------------------------
// RPC: shortlistListings
// ---------------------------------------------------------------------------

export async function shortlistListings(params: { listingIds: string[] }): Promise<{ success: boolean }> {
  if (params.listingIds.length === 0) return { success: true };
  const now = new Date().toISOString();
  for (const id of params.listingIds) {
    await db
      .update(freelanceListings)
      .set({ status: "shortlisted", updatedAt: now })
      .where(eq(freelanceListings.id, id));
  }
  broadcastToWebview(FREELANCE_EVENTS.LISTINGS_UPDATED, { count: 0 });
  return { success: true };
}
