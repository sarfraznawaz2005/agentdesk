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

After your tool calls, write your analysis as **markdown** using exactly this structure:

## System Verification

List every tool call and its result as bullet points:
- environment_info() → Windows 10, Node v20.x ✓, Python 3.11 ✓
- run_shell("node --version") → v20.x ✓
- run_shell("python --version") → not found ✗

## Condition A — System Check: PASS / FAIL

**Required:** [comma-separated list of every detected requirement]

**Verified:**
- [tool command] → [result] ✓ or ✗
- (one bullet per requirement)

## Condition B — AI Capability: PASS / FAIL

[One clear sentence explaining why it passes or fails]

## Verdict: WORKABLE / NOT WORKABLE

**Reason:** [One sentence summarising the overall decision]

**Blockers:**
- [Specific blocker 1 — e.g. "Adobe After Effects not installed"]
- [Specific blocker 2]
(write "none" if workable)

If you did not make any tool calls, write:
## System Verification

No tool calls made — system requirements could not be verified.

## Condition A — System Check: FAIL

Not verified.

## Verdict: NOT WORKABLE

**Reason:** System requirements could not be verified because no tool calls were made.`;
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

  lines.push(
    "",
    "---",
    "",
    "IMPORTANT: You must call tools NOW before writing anything else.",
    "1. Call environment_info to get OS and base system info.",
    "2. For each runtime/tool the project requires, call run_shell with its version command.",
    "   Do NOT skip this step. Do NOT write 'I will check' — call the tool immediately.",
    "3. After tool calls complete, write your analysis using the required output format from the system prompt.",
  );

  return lines.join("\n");
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

  // Phase 1 — system verification + capability analysis with forced tool calls.
  // toolChoice: "required" prevents the model from skipping tool calls and writing prose
  // about what it "would" check — it must actually call run_shell / environment_info.
  // Some reasoning/thinking models (DeepSeek-R1, o1, etc.) reject toolChoice entirely and
  // throw a hard error instead of silently falling back, so we retry with "auto" on that path.
  let phase1Result: Awaited<ReturnType<typeof generateText>>;
  try {
    phase1Result = await generateText({
      model: adapter.createModel(modelId),
      abortSignal,
      system: buildAnalysisSystemPrompt(),
      messages: [{ role: "user", content: userMessage }],
      tools,
      toolChoice: "required",
      stopWhen: [stepCountIs(5)],
    });
  } catch (toolChoiceErr) {
    if (isAbortError(toolChoiceErr)) throw toolChoiceErr;
    const errMsg = toolChoiceErr instanceof Error ? toolChoiceErr.message : String(toolChoiceErr);
    // Reasoning/thinking models (DeepSeek R1, etc.) and some providers reject toolChoice.
    // Fall back to "auto" — the system prompt already instructs the model to call tools first.
    if (/tool.?choice|thinking mode|tool_choice/i.test(errMsg)) {
      console.warn(`[wizard] toolChoice "required" rejected by model, retrying with "auto": ${errMsg}`);
      phase1Result = await generateText({
        model: adapter.createModel(modelId),
        abortSignal,
        system: buildAnalysisSystemPrompt(),
        messages: [{ role: "user", content: userMessage }],
        tools,
        toolChoice: "auto",
        stopWhen: [stepCountIs(5)],
      });
    } else {
      throw toolChoiceErr;
    }
  }
  const { text: analysisText, steps } = phase1Result;

  // Phase 1 `text` only captures model prose — actual tool outputs live in step.toolResults.
  // Build a combined context so Phase 2 can evaluate real tool output, not just stated intentions.
  const toolResultLines: string[] = [];
  for (const step of steps) {
    const results = step.toolResults as unknown as Array<{ toolName: string; output: unknown }> | undefined;
    for (const tr of results ?? []) {
      toolResultLines.push(`- **${tr.toolName}**: ${formatToolOutput(tr.toolName, tr.output)}`);
    }
  }

  const systemCheckSection = toolResultLines.length > 0
    ? `## System Check Results\n\n${toolResultLines.join("\n")}`
    : "## System Check Results\n\nNo tool calls were made — system verification incomplete. Condition A automatically fails.";

  const fullContext = systemCheckSection
    + (analysisText.trim() ? `\n\n## Analysis\n\n${analysisText}` : "");

  // Phase 2 — extract structured verdict from combined tool results + analysis.
  // Uses generateText (not generateObject) so it works with any provider.
  const { text: verdictText } = await generateText({
    model: adapter.createModel(modelId),
    abortSignal,
    system:
      "You are a strict data extractor. Read the provided feasibility analysis and return ONLY a JSON object — " +
      "no markdown, no explanation, no code fences. Use exactly these field names:\n" +
      '{"workable": boolean, "confidence": "high"|"medium"|"low", "coveragePercent": number 0-100, "reason": "one or two sentence summary", "blockers": ["blocker 1", "blocker 2"]}\n\n' +
      "workable=true ONLY if: (A) all required system software was confirmed installed via tool calls AND (B) the AI can fully complete the project. " +
      "If either condition failed, workable=false. " +
      "blockers must list the concrete reasons: specific missing tools, or specific AI limitations. " +
      "Do NOT list 'incomplete analysis' as a blocker — if the analysis lacked tool calls, list the unverified requirements as missing instead.",
    messages: [
      {
        role: "user",
        content: `Extract a structured verdict from this feasibility analysis:\n\n${fullContext}`,
      },
    ],
  });

  let verdict: Verdict;
  try {
    const rawJson = extractJsonFromText(verdictText);
    verdict = coerceVerdict(rawJson);
  } catch (parseErr) {
    console.warn(`[wizard] Phase 2 JSON parse failed (${parseErr}), falling back to heuristic`);
    // Conservative: only trust an explicit JSON-like workable=true signal in the verdict text.
    // Avoids false positives from the word "workable" appearing in our own system prompt.
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

  // The persisted analysis text is the AI's full written synthesis from Phase 1.
  // If Phase 1 produced no text (model only made tool calls), build a minimal
  // summary from the system check section so users always see something useful.
  // Normalize Windows line endings (\r\n → \n) to prevent \r from rendering as
  // a visible symbol (↵) in the browser markdown renderer.
  const normalizeNewlines = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const persistedAnalysis = normalizeNewlines(analysisText.trim() ? analysisText : systemCheckSection);

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
