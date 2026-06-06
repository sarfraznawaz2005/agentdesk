// Currency exchange rate service.
// Fetches USD-based rates once per day (max 1 API call/day per the requirement).
// Primary API: fawazahmed0/exchange-api (CDN-backed, unlimited free, 200+ currencies).
// Fallback 1: fawazahmed0 Cloudflare mirror.
// Fallback 2: Frankfurter (covers ~35 major currencies only).
// Rates are persisted in the settings table so they survive app restarts.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../db/schema";

const CACHE_KEY_RATES = "freelance_currency_rates";
const CACHE_KEY_FETCHED_AT = "freelance_currency_rates_fetched_at";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function isSameCalendarDay(isoTimestamp: string): boolean {
  return isoTimestamp.slice(0, 10) === todayUtc();
}

// In-memory cache so we don't hit the DB on every listing render.
let memCache: { rates: Record<string, number>; fetchedAt: string } | null = null;
// In-flight dedup — multiple simultaneous callers share a single network request.
let inflightFetch: Promise<{ rates: Record<string, number>; fetchedAt: string } | null> | null = null;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function loadFromDb(): Promise<{ rates: Record<string, number>; fetchedAt: string } | null> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.category, "freelance"));

  const map = new Map(rows.map((r) => [r.key, r.value]));
  const ratesRaw = map.get(CACHE_KEY_RATES);
  const fetchedAt = map.get(CACHE_KEY_FETCHED_AT);

  if (!ratesRaw || !fetchedAt) return null;
  try {
    const rates = JSON.parse(ratesRaw) as Record<string, number>;
    return { rates, fetchedAt };
  } catch {
    return null;
  }
}

async function saveToDb(rates: Record<string, number>, fetchedAt: string): Promise<void> {
  const now = new Date().toISOString();
  const upsert = async (key: string, value: string) => {
    await db
      .insert(settings)
      .values({ id: crypto.randomUUID(), key, value, category: "freelance", updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  };
  await upsert(CACHE_KEY_RATES, JSON.stringify(rates));
  // Store fetchedAt as a plain ISO string (NOT JSON.stringify) so loadFromDb can read it back directly.
  await upsert(CACHE_KEY_FETCHED_AT, fetchedAt);
}

// ---------------------------------------------------------------------------
// API fetch — returns rates object { usd: 1, pkr: 278.5, eur: 0.92, ... }
// All keys are lowercase currency codes.
// ---------------------------------------------------------------------------

async function fetchFromFawazahmed0Primary(): Promise<Record<string, number>> {
  const url = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json";
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`fawazahmed0 primary: HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  const rates = data["usd"] as Record<string, number>;
  if (!rates || typeof rates !== "object") throw new Error("fawazahmed0 primary: unexpected shape");
  return rates;
}

async function fetchFromFawazahmed0Cloudflare(): Promise<Record<string, number>> {
  const url = "https://latest.currency-api.pages.dev/v1/currencies/usd.json";
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`fawazahmed0 cloudflare: HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  const rates = data["usd"] as Record<string, number>;
  if (!rates || typeof rates !== "object") throw new Error("fawazahmed0 cloudflare: unexpected shape");
  return rates;
}

async function fetchFromFrankfurter(): Promise<Record<string, number>> {
  const url = "https://api.frankfurter.dev/v1/latest?from=USD";
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Frankfurter: HTTP ${res.status}`);
  const data = (await res.json()) as { rates?: Record<string, number> };
  if (!data.rates) throw new Error("Frankfurter: no rates field");
  // Normalize to lowercase keys and add USD=1
  const rates: Record<string, number> = { usd: 1 };
  for (const [k, v] of Object.entries(data.rates)) {
    rates[k.toLowerCase()] = v;
  }
  return rates;
}

async function fetchRatesFromNetwork(): Promise<Record<string, number>> {
  try {
    const rates = await fetchFromFawazahmed0Primary();
    console.log("[currency-exchange] Fetched from fawazahmed0 CDN");
    return rates;
  } catch (e1) {
    console.warn("[currency-exchange] Primary failed, trying Cloudflare:", e1);
  }
  try {
    const rates = await fetchFromFawazahmed0Cloudflare();
    console.log("[currency-exchange] Fetched from fawazahmed0 Cloudflare");
    return rates;
  } catch (e2) {
    console.warn("[currency-exchange] Cloudflare failed, trying Frankfurter:", e2);
  }
  const rates = await fetchFromFrankfurter();
  console.log("[currency-exchange] Fetched from Frankfurter (limited currencies)");
  return rates;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns cached rates (in-memory → DB → network). Rates are USD-based. */
export async function getCurrencyRates(): Promise<{ rates: Record<string, number>; fetchedAt: string } | null> {
  // 1. In-memory cache — valid if fetched today (same calendar day, UTC)
  if (memCache && isSameCalendarDay(memCache.fetchedAt)) return memCache;

  // 2. DB cache — valid if fetched today
  const dbCache = await loadFromDb();
  if (dbCache && isSameCalendarDay(dbCache.fetchedAt)) {
    memCache = dbCache;
    return dbCache;
  }

  // 3. Fetch from network — deduplicate concurrent callers via in-flight promise
  if (inflightFetch) return inflightFetch;

  inflightFetch = (async () => {
    try {
      const rates = await fetchRatesFromNetwork();
      const fetchedAt = new Date().toISOString();
      memCache = { rates, fetchedAt };
      // Persist asynchronously — don't block the response
      saveToDb(rates, fetchedAt).catch((err) =>
        console.error("[currency-exchange] Failed to persist rates to DB:", err),
      );
      return memCache;
    } catch (err) {
      console.error("[currency-exchange] All sources failed:", err);
      // Return stale cache if available rather than nothing
      if (dbCache) {
        console.warn("[currency-exchange] Returning stale cached rates");
        memCache = dbCache;
        return dbCache;
      }
      if (memCache) return memCache;
      return null;
    } finally {
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}

/**
 * Convert an amount from one currency to another using USD-based rates.
 * Returns null if rates are missing or currency codes are unknown.
 *
 * Logic: fromAmount → USD → toCurrency
 *   usdAmount = fromAmount / rates[from]   (rates["usd"] = 1)
 *   result    = usdAmount * rates[to]
 */
export function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  rates: Record<string, number>,
): number | null {
  const from = fromCurrency.toLowerCase();
  const to = toCurrency.toLowerCase();
  if (from === to) return amount;

  const fromRate = from === "usd" ? 1 : rates[from];
  const toRate = to === "usd" ? 1 : rates[to];

  if (fromRate == null || toRate == null || fromRate === 0) return null;

  return (amount / fromRate) * toRate;
}

/** Invalidate the in-memory cache (useful for testing or forced refresh). */
export function invalidateMemCache(): void {
  memCache = null;
}
