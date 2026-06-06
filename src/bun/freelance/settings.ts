import { eq } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../db/schema";

export interface RssSource {
  name: string;
  url: string;
  enabled: boolean;
}

export interface FreelanceSettings {
  rssSources: RssSource[];
  keywords: string[];
  pollingInterval: number;
  maxFeeds: number;
  maxListings: number;
  autoShortlistEnabled: boolean;
  autoShortlistCount: number;
  autoShortlistOnStartup: boolean;
  autoShortlistLastRun: string | null;
  autoShortlistLastCount: number;
  // null = use default global AI provider
  analysisProviderId: string | null;
  additionalNotes: string;
  // ISO 4217 currency code — used to show converted amounts on listings
  preferredCurrency: string;
}

const DEFAULT_RSS_SOURCES: RssSource[] = [
  { name: "Freelancer.com", url: "https://www.freelancer.com/rss.xml", enabled: true },
  { name: "PeoplePerHour", url: "https://www.peopleperhour.com/feed/jobs", enabled: true },
];

const DEFAULTS: FreelanceSettings = {
  rssSources: DEFAULT_RSS_SOURCES,
  keywords: [],
  pollingInterval: 60,
  maxFeeds: 20,
  maxListings: 100,
  autoShortlistEnabled: false,
  autoShortlistCount: 10,
  autoShortlistOnStartup: false,
  autoShortlistLastRun: null,
  autoShortlistLastCount: 0,
  analysisProviderId: null,
  additionalNotes: "",
  preferredCurrency: "USD",
};

const KEYS: Record<keyof FreelanceSettings, string> = {
  rssSources: "freelance_rss_sources",
  keywords: "freelance_keywords",
  pollingInterval: "freelance_polling_interval",
  maxFeeds: "freelance_max_feeds",
  maxListings: "freelance_max_listings",
  autoShortlistEnabled: "freelance_auto_shortlist_enabled",
  autoShortlistCount: "freelance_auto_shortlist_count",
  autoShortlistOnStartup: "freelance_auto_shortlist_on_startup",
  autoShortlistLastRun: "freelance_auto_shortlist_last_run",
  autoShortlistLastCount: "freelance_auto_shortlist_last_count",
  analysisProviderId: "freelance_analysis_provider_id",
  additionalNotes: "freelance_additional_notes",
  preferredCurrency: "freelance_preferred_currency",
};

export async function getFreelanceSettings(): Promise<FreelanceSettings> {
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.category, "freelance"));

  const map = new Map(rows.map((r) => [r.key, r.value]));

  function get<K extends keyof FreelanceSettings>(key: K): FreelanceSettings[K] {
    const raw = map.get(KEYS[key]);
    if (raw === undefined) return DEFAULTS[key];
    try { return JSON.parse(raw) as FreelanceSettings[K]; } catch { return DEFAULTS[key]; }
  }

  return {
    rssSources: get("rssSources"),
    keywords: get("keywords"),
    pollingInterval: get("pollingInterval"),
    maxFeeds: get("maxFeeds"),
    maxListings: get("maxListings"),
    autoShortlistEnabled: get("autoShortlistEnabled"),
    autoShortlistCount: get("autoShortlistCount"),
    autoShortlistOnStartup: get("autoShortlistOnStartup"),
    autoShortlistLastRun: get("autoShortlistLastRun"),
    autoShortlistLastCount: get("autoShortlistLastCount"),
    analysisProviderId: get("analysisProviderId"),
    additionalNotes: get("additionalNotes"),
    preferredCurrency: get("preferredCurrency"),
  };
}

export async function saveFreelanceSetting<K extends keyof FreelanceSettings>(
  key: K,
  value: FreelanceSettings[K],
): Promise<void> {
  const dbKey = KEYS[key];
  const now = new Date().toISOString();
  await db
    .insert(settings)
    .values({
      id: crypto.randomUUID(),
      key: dbKey,
      value: JSON.stringify(value),
      category: "freelance",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(value), updatedAt: now },
    });
}
