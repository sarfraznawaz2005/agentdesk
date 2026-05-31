import Parser from "rss-parser";

// rss-parser handles RSS 2.0 and Atom, decodes CDATA, parses pubDate to ISO,
// and collects <category> tags into item.categories automatically.

// Retries a fetch with exponential backoff. Network glitches and transient
// 5xx responses are retried; 4xx client errors are thrown immediately.
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      // Don't retry client errors (4xx)
      if (err instanceof Error && /HTTP 4\d\d/.test(err.message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
  throw new Error("unreachable");
}

type FeedItem = {
  title?: string;
  link?: string;
  content?: string;
  contentSnippet?: string;
  pubDate?: string;
  isoDate?: string;
  guid?: string;
  // rss-parser may return plain strings or {_: text, $: attrs} objects for categories
  categories?: Array<string | { _?: string; $?: Record<string, string> }>;
};

const parser = new Parser<Record<string, never>, FeedItem>();

export interface RssItem {
  title: string;
  link: string;
  description: string;
  isoDate: string | null;
  guid: string;
  categories: string[];
}

// rss-parser represents <category domain="url">text</category> as {_: "text", $: {domain: "url"}}
// Normalize to plain string in all cases.
function categoryToString(cat: string | { _?: string; $?: Record<string, string> }): string {
  if (typeof cat === "string") return cat;
  return cat._ ?? "";
}

function matchesKeywords(item: RssItem, keywords: string[]): boolean {
  const haystack = `${item.title} ${item.description}`.toLowerCase();
  return keywords.some((kw) => haystack.includes(kw.toLowerCase()));
}

export async function fetchRssFeed(url: string, keywords: string[], maxFeeds = 20): Promise<RssItem[]> {
  const response = await withRetry(() =>
    fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentDesk/1.0)" },
      signal: AbortSignal.timeout(15000),
    }).then((res) => {
      if (!res.ok) throw new Error(`RSS fetch failed: HTTP ${res.status}`);
      return res;
    })
  );

  const xml = await response.text();
  let feed: Awaited<ReturnType<typeof parser.parseString>>;
  try {
    feed = await parser.parseString(xml);
  } catch (err) {
    throw new Error(
      `Failed to parse RSS from ${url} — response may not be valid RSS/Atom (${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }

  // RSS feeds are typically newest-first; take the first maxFeeds items before any filtering
  const rawItems = (feed.items ?? []).slice(0, maxFeeds);
  const items: RssItem[] = [];

  for (const item of rawItems) {
    const link = item.link ?? "";
    const guid = item.guid ?? link;
    // Skip items with no usable URL — they can't be opened or deduplicated reliably
    if (!link && !guid) continue;
    items.push({
      title: item.title ?? "",
      link,
      // contentSnippet is HTML-stripped plain text from <description>
      description: item.contentSnippet ?? item.content ?? "",
      isoDate: item.isoDate ?? null,
      guid: guid || link,
      categories: (item.categories ?? []).map(categoryToString).filter(Boolean),
    });
  }

  // Keywords are optional — when none are configured, return all items
  return keywords.length > 0 ? items.filter((item) => matchesKeywords(item, keywords)) : items;
}
