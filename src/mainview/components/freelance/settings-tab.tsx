import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronDown, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";

import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { KeywordInput } from "./keyword-input";
import { AutoEarnSettings } from "./auto-earn-settings";
import type { FreelanceAutoEarnSettingsDto } from "../../../shared/rpc/freelance";

const AUTO_EARN_DEFAULTS: FreelanceAutoEarnSettingsDto = {
  enabled: false,
  autonomyMode: "assisted",
  pollMin: 180,
  pollMax: 480,
  activeHours: { start: 9, end: 22 },
  maxSendsPerHour: 1,
  minGapSeconds: 90,
  fullautoAck: false,
  notifyDesktop: true,
  notifyChannels: false,
};
import { CURRENCIES } from "../../../shared/freelance-currencies";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RssSource {
  name: string;
  url: string;
  enabled: boolean;
}

interface ProviderItem {
  id: string;
  name: string;
  isDefault: boolean;
}

interface SettingsState {
  rssSources: RssSource[];
  keywords: string[];
  pollingInterval: number;
  maxFeeds: number;
  maxListings: number;
  autoShortlistEnabled: boolean;
  autoShortlistCount: number;
  autoShortlistOnStartup: boolean;
  // null = use the global default AI provider
  analysisProviderId: string | null;
  additionalNotes: string;
  preferredCurrency: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUGGESTED_KEYWORDS = [
  ".Net", "Agent", "Android", "Angular", "API", "Article", "Automation",
  "Blog", "C#", "Chatbot", "CMS", "Code", "Commerce", "Content", "CSS",
  "Data", "Debug", "Design", "Dev", "Dotnet", "English", "Entry", "Excel",
  "Figma", "Flutter", "Go", "HTML", "JavaScript", "Kotlin", "Laravel", "LLM",
  "Mobile", "PHP", "Podcast", "Proofreading", "Python", "RAG", "React",
  "Responsive", "Resume", "Script", "Scrap", "Shopify", "SQL", "Subtitle",
  "Swift", "Testing", "Transcript", "Translation", "Translator", "TypeScript",
  "Video", "Voiceover", "Vue", "Web", "Word", "Writing",
];

const SETTINGS_DEFAULTS: SettingsState = {
  rssSources: [{ name: "Freelancer.com", url: "https://www.freelancer.com/rss.xml", enabled: true }],
  keywords: [],
  pollingInterval: 60,
  maxFeeds: 20,
  maxListings: 100,
  autoShortlistEnabled: false,
  autoShortlistCount: 10,
  autoShortlistOnStartup: false,
  analysisProviderId: null,
  additionalNotes: "",
  preferredCurrency: "USD",
};

// ---------------------------------------------------------------------------
// CurrencyCombobox — searchable currency picker
// ---------------------------------------------------------------------------

function CurrencyCombobox({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = CURRENCIES.find((c) => c.code === value);
  const filtered = query.trim()
    ? CURRENCIES.filter(
        (c) =>
          c.code.toLowerCase().includes(query.toLowerCase()) ||
          c.name.toLowerCase().includes(query.toLowerCase()),
      )
    : CURRENCIES;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <div ref={containerRef} className="relative w-full max-w-xs">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setTimeout(() => inputRef.current?.focus(), 10);
        }}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm",
          "hover:bg-accent/30 transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span className="truncate">
          {selected ? `${selected.code} — ${selected.name}` : "Select currency…"}
        </span>
        <ChevronDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md text-popover-foreground">
          {/* Search */}
          <div className="p-2 border-b border-border">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search currency…"
              className="w-full rounded-sm border border-input bg-transparent px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          {/* List */}
          <ul className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">No results</li>
            )}
            {filtered.map((c) => (
              <li key={c.code}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(c.code);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-sm",
                    "hover:bg-accent hover:text-accent-foreground transition-colors",
                    c.code === value && "bg-accent/50 font-medium",
                  )}
                >
                  <span className="font-mono text-xs text-muted-foreground mr-2">{c.code}</span>
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsTab
// ---------------------------------------------------------------------------

export function SettingsTab() {
  const [settings, setSettings] = useState<SettingsState>(SETTINGS_DEFAULTS);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);
  const [autoShortlistLastRun, setAutoShortlistLastRun] = useState<string | null>(null);
  const [autoShortlistLastCount, setAutoShortlistLastCount] = useState(0);
  const [autoEarn, setAutoEarn] = useState<FreelanceAutoEarnSettingsDto>(AUTO_EARN_DEFAULTS);
  // Auto-Earn is gated by the `autoearn` flag file next to the exe — the whole
  // section only appears when that file is present.
  const [autoEarnAvailable, setAutoEarnAvailable] = useState(false);

  // ---- Load on mount -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [result, providerList, autoEarnResult, autoEarnAvail] = await Promise.all([
          rpc.freelanceGetSettings(),
          rpc.getProviders(),
          rpc.freelanceGetAutoEarnSettings(),
          rpc.freelanceAutoEarnAvailable(),
        ]);
        if (cancelled) return;
        setAutoEarn(autoEarnResult);
        setAutoEarnAvailable(autoEarnAvail.available);
        setSettings({
          rssSources: result.rssSources,
          keywords: result.keywords,
          pollingInterval: result.pollingInterval,
          maxFeeds: result.maxFeeds,
          maxListings: result.maxListings,
          autoShortlistEnabled: result.autoShortlistEnabled,
          autoShortlistCount: result.autoShortlistCount,
          autoShortlistOnStartup: result.autoShortlistOnStartup,
          analysisProviderId: result.analysisProviderId,
          additionalNotes: result.additionalNotes,
          preferredCurrency: result.preferredCurrency ?? "USD",
        });
        setAutoShortlistLastRun(result.autoShortlistLastRun);
        setAutoShortlistLastCount(result.autoShortlistLastCount);
        setProviders(providerList.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })));
      } catch {
        if (!cancelled) toast("error", "Failed to load freelance settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  // ---- RSS source helpers --------------------------------------------------

  const updateSource = useCallback((index: number, patch: Partial<RssSource>) => {
    setSettings((prev) => ({
      ...prev,
      rssSources: prev.rssSources.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  }, []);

  const removeSource = useCallback((index: number) => {
    setSettings((prev) => ({
      ...prev,
      rssSources: prev.rssSources.filter((_, i) => i !== index),
    }));
  }, []);

  const addSource = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      rssSources: [...prev.rssSources, { name: "", url: "", enabled: true }],
    }));
  }, []);

  // ---- Number input helpers ------------------------------------------------

  const handleMaxFeedsChange = useCallback((raw: string) => {
    const parsed = parseInt(raw, 10);
    const clamped = isNaN(parsed) ? 5 : Math.min(100, Math.max(5, parsed));
    setSettings((prev) => ({ ...prev, maxFeeds: clamped }));
  }, []);

  const handleMaxListingsChange = useCallback((raw: string) => {
    const parsed = parseInt(raw, 10);
    const clamped = isNaN(parsed) ? 10 : Math.min(1000, Math.max(10, parsed));
    setSettings((prev) => ({ ...prev, maxListings: clamped }));
  }, []);

  const handleAutoShortlistCountChange = useCallback((raw: string) => {
    const parsed = parseInt(raw, 10);
    const clamped = isNaN(parsed) ? 10 : Math.min(25, Math.max(1, parsed));
    setSettings((prev) => ({ ...prev, autoShortlistCount: clamped }));
  }, []);

  // ---- Save ----------------------------------------------------------------

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await rpc.freelanceSaveSettings({
        rssSources: settings.rssSources,
        keywords: settings.keywords,
        pollingInterval: settings.pollingInterval,
        maxFeeds: settings.maxFeeds,
        maxListings: settings.maxListings,
        autoShortlistEnabled: settings.autoShortlistEnabled,
        autoShortlistCount: settings.autoShortlistCount,
        autoShortlistOnStartup: settings.autoShortlistOnStartup,
        analysisProviderId: settings.analysisProviderId,
        additionalNotes: settings.additionalNotes,
        preferredCurrency: settings.preferredCurrency,
      });
      await rpc.freelanceSaveAutoEarnSettings(autoEarn);
      // Let the Freelance page re-evaluate whether to show the Inbox tab.
      window.dispatchEvent(
        new CustomEvent("agentdesk:settings-changed", {
          detail: { key: "freelance_autoearn_enabled", value: autoEarn.enabled },
        }),
      );
      toast("success", "Freelance settings saved.");
    } catch {
      toast("error", "Failed to save freelance settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [settings, autoEarn]);

  // ---- Helpers -------------------------------------------------------------

  function formatLastRun(iso: string | null): string {
    if (!iso) return "Never";
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days = Math.floor(diff / 86_400_000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
    if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    if (days === 1) return "Yesterday";
    return `${days} days ago`;
  }

  // ---- Loading skeleton ----------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-40 bg-muted animate-pulse rounded-lg" />
        <div className="h-40 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  // ---- Derived ---------------------------------------------------------------

  const pollingDisabled = settings.pollingInterval === 0;

  // ---- Render --------------------------------------------------------------

  return (
    <div className="space-y-6">

      {/* ---- RSS Sources section ------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>RSS Sources</CardTitle>
          <CardDescription>
            Add RSS feeds from freelance platforms to monitor for new projects.
            Toggle a source off to pause it without removing it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {settings.rssSources.length === 0 && (
            <p className="text-sm text-muted-foreground">No sources configured. Add one below.</p>
          )}
          {settings.rssSources.map((source, index) => (
            <div key={index} className="flex items-center gap-2">
              <Switch
                checked={source.enabled}
                onCheckedChange={(enabled) => updateSource(index, { enabled })}
                aria-label={`${source.enabled ? "Disable" : "Enable"} ${source.name || "source"}`}
              />
              <Input
                value={source.name}
                onChange={(e) => updateSource(index, { name: e.target.value })}
                placeholder="Source name"
                className="w-40 shrink-0"
                aria-label="Source name"
              />
              <Input
                value={source.url}
                onChange={(e) => updateSource(index, { url: e.target.value })}
                placeholder="https://example.com/rss.xml"
                className="flex-1"
                aria-label="RSS feed URL"
              />
              {confirmDeleteIndex === index ? (
                <>
                  <span className="text-xs text-muted-foreground shrink-0">Remove?</span>
                  <button
                    type="button"
                    onClick={() => { removeSource(index); setConfirmDeleteIndex(null); }}
                    aria-label="Confirm remove source"
                    className="px-2 py-1 text-xs rounded-md border border-red-600 bg-red-600 text-white hover:bg-red-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteIndex(null)}
                    aria-label="Cancel remove"
                    className="px-2 py-1 text-xs rounded-md border border-border hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteIndex(index)}
                  aria-label="Remove source"
                  className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addSource}
            className="gap-1.5"
          >
            <Plus className="size-4" />
            Add Source
          </Button>
        </CardContent>
      </Card>

      {/* ---- Keywords section ---------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Keywords</CardTitle>
          <CardDescription>
            Filter fetched listings to only those whose title, description, or tags contain at least one keyword.
            Leave empty to save all listings. Press Enter or comma to add a keyword.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              setSettings((prev) => {
                const existing = new Set(prev.keywords.map((k) => k.toLowerCase()));
                const toAdd = SUGGESTED_KEYWORDS.filter((k) => !existing.has(k.toLowerCase()));
                return { ...prev, keywords: [...prev.keywords, ...toAdd] };
              });
            }}
          >
            <Sparkles className="size-4" />
            Add suggested keywords
          </Button>
          <Label htmlFor="freelance-keywords" className="sr-only">Keywords</Label>
          <KeywordInput
            value={settings.keywords}
            onChange={(keywords) => setSettings((prev) => ({ ...prev, keywords }))}
            placeholder="Add keyword..."
          />
        </CardContent>
      </Card>

      {/* ---- Max Feeds section --------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Max feeds per source</CardTitle>
          <CardDescription>
            Maximum number of latest items to fetch from each RSS source per poll (5–100). Default is 20.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Input
              id="max-feeds"
              type="number"
              min={5}
              max={100}
              value={settings.maxFeeds}
              onChange={(e) => handleMaxFeedsChange(e.target.value)}
              className="w-28"
              aria-describedby="max-feeds-unit"
            />
            <span id="max-feeds-unit" className="text-sm text-muted-foreground">items</span>
          </div>
        </CardContent>
      </Card>

      {/* ---- Max Listings section ------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle>Max stored listings</CardTitle>
          <CardDescription>
            Maximum number of listings to keep in total (10–1000). Default is 100.
            After each fetch the oldest non-approved listings are deleted to stay within this limit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Input
              id="max-listings"
              type="number"
              min={10}
              max={1000}
              value={settings.maxListings}
              onChange={(e) => handleMaxListingsChange(e.target.value)}
              className="w-28"
              aria-describedby="max-listings-unit"
            />
            <span id="max-listings-unit" className="text-sm text-muted-foreground">listings</span>
          </div>
        </CardContent>
      </Card>

      {/* ---- Auto Shortlist section -------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Auto Shortlist</CardTitle>
          <CardDescription>
            After each scheduled fetch (and optionally on startup), automatically analyze the latest listings
            and shortlist any that are workable. You will receive a desktop notification when listings are shortlisted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label
                htmlFor="auto-shortlist-enabled"
                className={pollingDisabled ? "text-muted-foreground" : ""}
              >
                Enable auto shortlist
              </Label>
              {pollingDisabled && (
                <p className="text-xs text-muted-foreground">
                  Requires polling to be enabled
                </p>
              )}
            </div>
            <Switch
              id="auto-shortlist-enabled"
              checked={settings.autoShortlistEnabled && !pollingDisabled}
              disabled={pollingDisabled}
              onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, autoShortlistEnabled: checked }))}
            />
          </div>

          {/* Settings shown only when enabled and polling is active */}
          {settings.autoShortlistEnabled && !pollingDisabled && (
            <>
              {/* Max entries */}
              <div className="space-y-1.5">
                <Label htmlFor="auto-shortlist-count">Max entries to analyze per run</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="auto-shortlist-count"
                    type="number"
                    min={1}
                    max={25}
                    value={settings.autoShortlistCount}
                    onChange={(e) => handleAutoShortlistCountChange(e.target.value)}
                    className="w-28"
                  />
                  <span className="text-sm text-muted-foreground">listings (1–25)</span>
                </div>
              </div>

              {/* Run on startup checkbox */}
              <div className="flex items-center gap-2">
                <input
                  id="auto-shortlist-startup"
                  type="checkbox"
                  checked={settings.autoShortlistOnStartup}
                  onChange={(e) => setSettings((prev) => ({ ...prev, autoShortlistOnStartup: e.target.checked }))}
                  className="h-4 w-4 rounded border-border accent-primary"
                />
                <Label htmlFor="auto-shortlist-startup" className="cursor-pointer font-normal">
                  Also run on app startup (after initial fetch)
                </Label>
              </div>

              {/* Last run info */}
              <p className="text-xs text-muted-foreground">
                Last run: {formatLastRun(autoShortlistLastRun)}
                {autoShortlistLastRun && autoShortlistLastCount > 0 && (
                  <> · {autoShortlistLastCount} listing{autoShortlistLastCount !== 1 ? "s" : ""} shortlisted</>
                )}
                {autoShortlistLastRun && autoShortlistLastCount === 0 && (
                  <> · no workable listings found</>
                )}
              </p>
            </>
          )}

          {/* AI Provider dropdown — always visible, shown last */}
          <div className="space-y-1.5">
            <Label htmlFor="analysis-provider">AI Provider</Label>
            {providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No AI providers configured. Add one in Global Settings.</p>
            ) : (
              <Select
                value={settings.analysisProviderId ?? "__default__"}
                onValueChange={(value) =>
                  setSettings((prev) => ({
                    ...prev,
                    analysisProviderId: value === "__default__" ? null : value,
                  }))
                }
              >
                <SelectTrigger id="analysis-provider" className="w-full max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">
                    Global default ({providers.find((p) => p.isDefault)?.name ?? "none set"})
                  </SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}{p.isDefault ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">Used by Find Workable and Auto Shortlist. Chat always uses the global default.</p>
          </div>
        </CardContent>
      </Card>

      {/* ---- Preferred Currency section ------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle>Preferred Currency</CardTitle>
          <CardDescription>
            Listing bid amounts are shown in their original currency. When a different currency is set here,
            a converted amount is displayed alongside — e.g. <span className="font-mono text-xs">$10 (2,785 PKR)</span>.
            Exchange rates are fetched once per day and cached.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="preferred-currency" className="mb-1.5 block">Display currency</Label>
          <CurrencyCombobox
            value={settings.preferredCurrency}
            onChange={(code) => setSettings((prev) => ({ ...prev, preferredCurrency: code }))}
          />
        </CardContent>
      </Card>

      {/* ---- Polling Interval section -------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Polling interval</CardTitle>
          <CardDescription>
            How often to check RSS feeds for new projects. Set to Disabled to stop all background
            polling — you can still fetch manually using the Fetch Now button.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={String(settings.pollingInterval)}
            onValueChange={(v) => setSettings((prev) => ({ ...prev, pollingInterval: Number(v) }))}
          >
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Disabled (manual only)</SelectItem>
              <SelectItem value="15">Every 15 minutes</SelectItem>
              <SelectItem value="30">Every 30 minutes</SelectItem>
              <SelectItem value="60">Every Hour</SelectItem>
              <SelectItem value="120">Every Two hours</SelectItem>
              <SelectItem value="180">Every Three hours</SelectItem>
              <SelectItem value="240">Every Four hours</SelectItem>
              <SelectItem value="300">Every Five hours</SelectItem>
              <SelectItem value="360">Every Six hours</SelectItem>
              <SelectItem value="420">Every Seven hours</SelectItem>
              <SelectItem value="480">Every Eight hours</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* ---- Additional Notes section --------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Additional Notes</CardTitle>
          <CardDescription>
            These notes are sent to the AI on every request — Listing Chat, Auto Shortlist, and Find Workable. Use this feature to pass any extra context to AI.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="additional-notes" className="sr-only">Additional Notes</Label>
          <Textarea
            id="additional-notes"
            value={settings.additionalNotes}
            onChange={(e) => setSettings((prev) => ({ ...prev, additionalNotes: e.target.value }))}
            className="min-h-[120px] resize-y"
          />
        </CardContent>
      </Card>

      {/* ---- Auto-Earn section (gated by the `autoearn` flag file) ---------- */}
      {autoEarnAvailable && (
        <Card>
          <CardContent className="pt-6">
            <AutoEarnSettings value={autoEarn} onChange={setAutoEarn} />
          </CardContent>
        </Card>
      )}

      {/* ---- Footer actions (bottom of everything) ------------------------- */}
      {/* This single Save persists ALL freelance settings AND the Auto-Earn options above. */}
      <div className="flex items-center justify-end">
        <Button
          type="button"
          onClick={handleSave}
          disabled={saving}
          aria-label={saving ? "Saving settings" : "Save freelance settings"}
        >
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

    </div>
  );
}
