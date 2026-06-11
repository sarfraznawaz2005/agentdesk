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
  const root = parseHtml(html);
  root.querySelectorAll("script, style, nav, header, footer, aside, noscript").forEach((el) => el.remove());
  // he.decode ensures HTML entities (&amp;, &nbsp;, etc.) are fully resolved.
  const text = he.decode(root.textContent.replace(/\s+/g, " ").trim());
  // Truncate before sending to extraction AI — keeps token cost low
  return text.length > 12_000 ? text.slice(0, 12_000) + "…" : text;
}

async function extractDescription(
  pageText: string,
  listing: typeof freelanceListings.$inferSelect,
  adapter: ReturnType<typeof createProviderAdapter>,
  modelId: string,
): Promise<string> {
  const { text } = await generateText({
    model: adapter.createModel(modelId),
    system:
      "You are a precise data extraction assistant. Extract ONLY the job or project description from the page content provided. " +
      "Return only the actual project requirements and description the client wrote — no platform UI text, no navigation, no pricing tables, no sidebar content, no HTML. " +
      "Plain text only. If you cannot find a clear description, return an empty string.",
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
): Promise<string> {
  let fullDescription: string | null = listing.fullDescription;

  const shouldFetch =
    fullDescription === null ||
    (fullDescription === "" && !descriptionFetchFailedThisSession.has(listing.id));

  if (!shouldFetch) return fullDescription ?? "";

  hooks?.onFetchStart?.();
  try {
    const pageText = await fetchPageText(listing.url);
    fullDescription = await extractDescription(pageText, listing, adapter, modelId);
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
