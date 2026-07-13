// ---------------------------------------------------------------------------
// Freelance — full listing description fetch + cache
//
// Single source of truth for freelance_listings.fullDescription. Fetches the
// listing page, AI-extracts the client's actual description, and caches it on
// the listing row. Used by the freelance chat AND the bid pipeline so either
// entry point populates the cache for both.
//
// Cache semantics:
//   null  = never attempted → fetch + extract
//   ""    = attempted but failed (or page had no clear description) →
//           retry once per app session, else fall back to RSS description
//   "..." = successfully extracted → use directly, never refetch
// ---------------------------------------------------------------------------

import he from "he";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { parse as parseHtml } from "node-html-parser";
import { db } from "../db";
import { freelanceListings } from "../db/schema";
import type { createProviderAdapter } from "../providers";
import { internalCallModelId } from "../providers/claude-subscription";

// Listings whose description fetch failed (or extracted nothing) this app
// session. A cached "" is retried once per session instead of never, so
// transient failures heal on restart without hammering the page per message.
const descriptionFetchFailedThisSession = new Set<string>();

async function fetchPageText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  // Insert newlines for block-level elements BEFORE parsing so paragraph/list
  // structure is preserved in the plain-text output. Without this, all newlines
  // are collapsed into spaces and the AI returns a single unformatted blob.
  // Paragraph/heading endings → double newline (blank line between sections).
  // List items / table rows / divs → single newline (tight list layout).
  const htmlWithBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|blockquote)>/gi, "\n\n")
    .replace(/<\/(div|li|tr)>/gi, "\n");
  const root = parseHtml(htmlWithBreaks);
  root.querySelectorAll("script, style, nav, header, footer, aside, noscript").forEach((el) => el.remove());
  // Collapse horizontal whitespace per line, preserve newlines, then dedupe blank lines.
  const raw = he.decode(root.textContent);
  const text = raw
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Truncate before sending to extraction AI — keeps token cost low
  return text.length > 12_000 ? text.slice(0, 12_000) + "…" : text;
}

export async function extractDescription(
  pageText: string,
  listing: typeof freelanceListings.$inferSelect,
  adapter: ReturnType<typeof createProviderAdapter>,
  modelId: string,
  abortSignal?: AbortSignal,
  providerType?: string,
): Promise<string> {
  const { text } = await generateText({
    model: adapter.createModel(providerType ? internalCallModelId(providerType, modelId) : modelId),
    abortSignal,
    system:
      "You are a precise data extraction assistant. Extract ONLY the job or project description from the page content provided. " +
      "Return only the actual project requirements and description the client wrote. " +
      "EXCLUDE everything else: the project title, budget, price, hourly rate, project status, posted date, deadline, bid counts, platform navigation, sidebar content, skill tags, and any Freelancer.com UI text. " +
      "Format the output as clean Markdown: use bullet lists (`-`) for list items, `**bold**` for section headings or labels, preserve paragraph breaks as blank lines between sections. " +
      "Copy the client's exact words verbatim — do not paraphrase, summarize, reword, or alter any sentence. Only apply Markdown formatting structure to the existing text. " +
      "IMPORTANT: Your entire output must be written in English. If the source description is not in English, you MUST translate every sentence to English — do not leave any part in the original language. After translating, prepend a single italics line: `_Translated from [language name]._` followed by a blank line, then the full English translation. " +
      "If you cannot find a clear project description, return an empty string.",
    messages: [
      {
        role: "user",
        content:
          `Extract the project description from this page for the listing titled "${listing.title}":\n\n${pageText}`,
      },
    ],
  });
  return text.trim();
}

/**
 * Return the cached full description for a listing, fetching + extracting +
 * caching it first if needed. Returns "" when no description could be
 * extracted — callers fall back to the RSS `listing.description`.
 */
export async function ensureFullDescription(
  listing: typeof freelanceListings.$inferSelect,
  adapter: ReturnType<typeof createProviderAdapter>,
  modelId: string,
  hooks?: { onFetchStart?: () => void; onFetchDone?: () => void },
  providerType?: string,
): Promise<string> {
  let fullDescription: string | null = listing.fullDescription;

  const shouldFetch =
    fullDescription === null ||
    (fullDescription === "" && !descriptionFetchFailedThisSession.has(listing.id));

  if (!shouldFetch) return fullDescription ?? "";

  hooks?.onFetchStart?.();
  try {
    const pageText = await fetchPageText(listing.url);
    fullDescription = await extractDescription(pageText, listing, adapter, modelId, undefined, providerType);
    // Extraction can legitimately return "" (no clear description on the
    // page) — treat it like a failure so we don't refetch every message.
    if (fullDescription === "") descriptionFetchFailedThisSession.add(listing.id);
  } catch (err) {
    console.error("[freelance] Failed to fetch/extract listing description:", err);
    fullDescription = "";
    descriptionFetchFailedThisSession.add(listing.id);
  }
  await db
    .update(freelanceListings)
    .set({ fullDescription })
    .where(eq(freelanceListings.id, listing.id));
  hooks?.onFetchDone?.();

  return fullDescription;
}
