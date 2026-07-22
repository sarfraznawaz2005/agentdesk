import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ChevronDown, Search, Brain, Cpu, Check, ShieldCheck, Hammer, Eye, Star, Clock, BadgeCheck, X } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Tip, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { ContextIndicator } from "./context-indicator";
import type { Message } from "@/stores/chat-store";

interface ProviderModels {
  providerId: string;
  providerName: string;
  providerType: string;
  models: string[];
}

/** Per-model state, keyed by `${providerId}|${modelId}`. */
type ModelPrefMap = Record<string, { isEnabled: boolean; isFavorite: boolean; lastUsedAt: string | null }>;

/** A flattened, renderable model entry inside a section. */
interface ModelEntry {
  providerId: string;
  providerName: string;
  providerType: string;
  model: string;
}

/** A titled group of model entries rendered in the picker. */
interface ModelSection {
  key: string;
  label: string;
  icon: "default" | "latest" | "favorites" | null;
  entries: ModelEntry[];
}

const prefKey = (providerId: string, model: string) => `${providerId}|${model}`;

// Persist the connected-provider-models list across full page reloads (a
// plain in-memory ref/state cache resets to empty on reload, forcing the
// first popover open after every reload to pay for a fresh fetch again).
// localStorage survives reloads and gives the popover an instant paint on
// mount — but it's only ever a seed for that first paint, never trusted on
// its own past that (see the `hasFetched` ref below for why).
const MODEL_CACHE_KEY = "agentdesk:cached-connected-provider-models";

function loadCachedProviders(): ProviderModels[] | null {
  try {
    const raw = localStorage.getItem(MODEL_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveCachedProviders(data: ProviderModels[]): void {
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Storage full/unavailable — non-critical, just skip persisting.
  }
}

/** Build the keyed preference map from the raw RPC rows. */
function buildPrefMap(
  rows: Array<{ providerId: string; modelId: string; isEnabled: boolean; isFavorite: boolean; lastUsedAt: string | null }>,
): ModelPrefMap {
  const map: ModelPrefMap = {};
  for (const r of rows) {
    map[prefKey(r.providerId, r.modelId)] = {
      isEnabled: r.isEnabled,
      isFavorite: r.isFavorite,
      lastUsedAt: r.lastUsedAt,
    };
  }
  return map;
}

const THINKING_LEVELS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

interface ModelSelectorProps {
  projectId: string;
  messages: Message[];
  /** General Chat has no Build/Plan Mode concept (no kanban, no sub-agents) —
   *  it renders its own Deep Research toggle in this spot instead. */
  hideBuildPlanToggle?: boolean;
  /** General Chat's Assistant agent has no run_shell tool at all — nothing for this to control. */
  hideShellApproval?: boolean;
  /** Drop the row's own right/bottom padding (pr-4/pb-1.5), keeping only pl-4
   *  — for callers (General Chat) that render this alongside a sibling control
   *  (DeepResearchToggle) in their own flex row. The left padding stays so this
   *  row's first button still lines up with the input box above it; the right
   *  padding would otherwise widen the gap to the sibling beyond the internal
   *  gap-2 between this component's own buttons, and pb-1.5 would make this
   *  box taller than the sibling, throwing off `items-center` alignment. */
  compact?: boolean;
  /**
   * When set, the thinking-level picker persists to this GLOBAL setting key
   * (category "ai") instead of the per-project `chatThinkingLevel` — so the
   * choice sticks across all conversations + restarts. General Chat uses this
   * (its projectId is a per-conversation id, which would otherwise reset the
   * level on every new conversation). Model/provider selection is unaffected.
   */
  globalThinkingKey?: string;
}

export function ModelSelector({ projectId, messages, hideBuildPlanToggle = false, hideShellApproval = false, compact = false, globalThinkingKey }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderModels[]>(() => loadCachedProviders() ?? []);
  const [prefs, setPrefs] = useState<ModelPrefMap>({});
  // providerId → that provider's default model, used to fall back when the
  // currently selected model gets disabled.
  const [defaultsByProvider, setDefaultsByProvider] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedThinking, setSelectedThinking] = useState<string>("");
  const [shellApproval, setShellApproval] = useState<boolean>(true);
  const [planMode, setPlanMode] = useState<boolean>(false);
  const [defaultModelName, setDefaultModelName] = useState<string>("");
  // The default AI provider's own model — always shown in its own "Default"
  // section at the very top of the picker, regardless of Latest/Favorites.
  const [defaultEntry, setDefaultEntry] = useState<ModelEntry | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Always starts false, even though `providers` may already be seeded from
  // the localStorage cache above — the cache is only a fast paint for the
  // popover's first open, never a substitute for a real fetch this mount. A
  // provider can be added/edited/deleted while this component isn't mounted
  // at all (e.g. from the Settings page, a different route) — the
  // "agentdesk:providers-changed" listener below has nothing to catch in
  // that case, so a stale cache would otherwise never get invalidated. One
  // background fetch per mount (see fetchModels) guarantees it always
  // reconciles with the backend at least once, cache or not.
  const hasFetched = useRef(false);
  // ModelSelector lives inside ChatLayout, which stays mounted across a
  // project switch (ProjectPage always force-selects the Chat tab on a
  // project change) — unlike other project tabs, there's no unmount to reset
  // a stale in-flight fetch. Track the latest projectId so an async callback
  // can tell, after its await, whether it's still relevant. Assigned in an
  // effect (not during render) per react-hooks/refs.
  const projectIdRef = useRef(projectId);
  useEffect(() => { projectIdRef.current = projectId; });

  // Load saved selection from project settings + provider defaults + prefs.
  useEffect(() => {
    Promise.all([
      rpc.getProjectSettings(projectId),
      rpc.getProviders(),
      rpc.getModelPreferences(),
    ]).then(([settings, providersList, prefRows]) => {
      // A rapid project switch (A -> B) before this resolves must not let A's
      // stale settings (model/thinking-level/shell-approval/plan-mode)
      // overwrite what's showing — and would be used — for B.
      if (projectIdRef.current !== projectId) return;
      const s = settings as Record<string, string>;
      const pid = s.chatProviderId ?? "";
      const mid = s.chatModelId ?? "";
      const tl = s.chatThinkingLevel ?? "";
      const sam = s.shellApprovalMode ?? "ask";
      setShellApproval(sam === "ask");
      setPlanMode(s.planMode === "true");
      // Resolve the default provider's model name
      const defaultProv = providersList.find((p) => p.isDefault) ?? providersList[0];
      const defaultModel = defaultProv?.defaultModel ?? defaultProv?.providerType ?? "";
      setDefaultEntry(
        defaultProv && defaultModel
          ? { providerId: defaultProv.id, providerName: defaultProv.name, providerType: defaultProv.providerType, model: defaultModel }
          : null,
      );

      // Map each provider to its default model for disabled-selection fallback.
      const defaults: Record<string, string> = {};
      for (const p of providersList) if (p.defaultModel) defaults[p.id] = p.defaultModel;
      setDefaultsByProvider(defaults);
      const map = buildPrefMap(prefRows);
      setPrefs(map);

      // Resolve the effective selection. If user hasn't chosen, use the default
      // provider/model; if the chosen model is now disabled, fall back to the
      // provider default and persist the correction.
      const selProvider = pid || defaultProv?.id || "";
      let selModel = mid || defaultModel;
      const selPref = map[prefKey(selProvider, selModel)];
      if (selPref && !selPref.isEnabled && defaults[selProvider] && defaults[selProvider] !== selModel) {
        selModel = defaults[selProvider];
        rpc.saveProjectSetting(projectId, "chatModelId", selModel).catch(() => {});
      }
      setSelectedProviderId(selProvider);
      setSelectedModelId(selModel);
      // General Chat sources its thinking level from a global key (loaded in the
      // effect below), not per-project — don't let per-project settings set it.
      if (!globalThinkingKey) setSelectedThinking(tl);
      setDefaultModelName(defaultModel);
    }).catch(() => {});
  }, [projectId, globalThinkingKey]);

  // General Chat: load the thinking level from its global key so it persists
  // across every General-Chat conversation and app restart.
  useEffect(() => {
    if (!globalThinkingKey) return;
    rpc.getSetting(globalThinkingKey, "ai")
      .then((v) => setSelectedThinking(typeof v === "string" ? v : ""))
      .catch(() => {});
  }, [globalThinkingKey]);

  // Load per-model preferences (enabled/favourite/last-used). Cheap, so refresh
  // every time the popover opens and whenever they change in another view.
  // If the currently selected model has since been disabled, fall back to the
  // provider's default — done here (a callback, not a reactive effect) so the
  // correction rides along with the data load.
  const fetchPrefs = useCallback(async () => {
    try {
      const map = buildPrefMap(await rpc.getModelPreferences());
      setPrefs(map);
      if (selectedProviderId && selectedModelId) {
        const pref = map[prefKey(selectedProviderId, selectedModelId)];
        const fallback = defaultsByProvider[selectedProviderId];
        if (pref && !pref.isEnabled && fallback && fallback !== selectedModelId) {
          setSelectedModelId(fallback);
          rpc.saveProjectSetting(projectId, "chatModelId", fallback).catch(() => {});
        }
      }
    } catch {
      // Failed to fetch prefs — fall back to defaults (all enabled, none favourite)
    }
  }, [projectId, selectedProviderId, selectedModelId, defaultsByProvider]);

  // Cross-view live sync: refresh prefs when they change anywhere (e.g. the
  // Settings → Models page toggles enabled/favourite), including across windows.
  useEffect(() => {
    const onChanged = () => { fetchPrefs(); };
    window.addEventListener("agentdesk:model-preferences-changed", onChanged);
    return () => window.removeEventListener("agentdesk:model-preferences-changed", onChanged);
  }, [fetchPrefs]);

  // Fetch models (once per mount) and preferences (every open) when the
  // popover opens. Cached data (if any) is shown immediately — the spinner
  // only appears when there's nothing to show meanwhile — while this always
  // revalidates against the backend once, so a provider added/changed while
  // unmounted still shows up the first time the popover opens after remount.
  const fetchModels = useCallback(async () => {
    fetchPrefs();
    if (hasFetched.current) return;
    if (providers.length === 0) setLoading(true);
    try {
      const result = await rpc.getConnectedProviderModels();
      setProviders(result);
      saveCachedProviders(result);
      hasFetched.current = true;
    } catch {
      // Failed to fetch — keep showing whatever we had (cache or empty)
    }
    setLoading(false);
  }, [fetchPrefs, providers.length]);

  // Invalidate the cached model list when a provider is added, edited, or
  // deleted anywhere (Settings → Providers, onboarding, another window) — the
  // fetch above only ever runs once per mount otherwise, so a newly added
  // provider's models would never appear here until a full app restart.
  useEffect(() => {
    const onProvidersChanged = () => {
      hasFetched.current = false;
      fetchModels();
    };
    window.addEventListener("agentdesk:providers-changed", onProvidersChanged);
    return () => window.removeEventListener("agentdesk:providers-changed", onProvidersChanged);
  }, [fetchModels]);

  // Toggle a model's favourite state, optimistically updating local prefs.
  const toggleFavorite = useCallback(async (providerId: string, model: string) => {
    const key = prefKey(providerId, model);
    const next = !(prefs[key]?.isFavorite ?? false);
    setPrefs((prev) => ({
      ...prev,
      [key]: {
        isEnabled: prev[key]?.isEnabled ?? true,
        isFavorite: next,
        lastUsedAt: prev[key]?.lastUsedAt ?? null,
      },
    }));
    await rpc.setModelFavorite(providerId, model, next).catch(() => {});
  }, [prefs]);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      fetchModels();
      setTimeout(() => searchRef.current?.focus(), 100);
    } else {
      setSearch("");
    }
  }, [fetchModels]);

  const selectModel = useCallback(async (providerId: string, modelId: string) => {
    setSelectedProviderId(providerId);
    setSelectedModelId(modelId);
    setOpen(false);
    // Persist
    await Promise.all([
      rpc.saveProjectSetting(projectId, "chatProviderId", providerId),
      rpc.saveProjectSetting(projectId, "chatModelId", modelId),
    ]).catch(() => {});
  }, [projectId]);

  const selectThinking = useCallback(async (level: string) => {
    setSelectedThinking(level);
    setThinkingOpen(false);
    if (globalThinkingKey) {
      await rpc.saveSetting(globalThinkingKey, level, "ai").catch(() => {});
    } else {
      await rpc.saveProjectSetting(projectId, "chatThinkingLevel", level).catch(() => {});
    }
  }, [projectId, globalThinkingKey]);

  const toggleShellApproval = useCallback(async () => {
    const next = !shellApproval;
    setShellApproval(next);
    await rpc.saveProjectSetting(projectId, "shellApprovalMode", next ? "ask" : "auto").catch(() => {});
  }, [projectId, shellApproval]);

  const togglePlanMode = useCallback(async () => {
    const next = !planMode;
    setPlanMode(next);
    await rpc.saveProjectSetting(projectId, "planMode", String(next)).catch(() => {});
  }, [projectId, planMode]);

  // Display label for selected model
  const displayLabel = useMemo(() => {
    if (!selectedModelId) return defaultModelName || "Loading...";
    // Find provider name for context
    const prov = providers.find((p) => p.providerId === selectedProviderId);
    if (prov) {
      // Shorten model name: remove provider prefix if present
      return selectedModelId.replace(`${prov.providerType}/`, "");
    }
    return selectedModelId;
  }, [selectedModelId, selectedProviderId, providers, defaultModelName]);

  const thinkingLabel = useMemo(() => {
    if (!selectedThinking) return "Default";
    return THINKING_LEVELS.find((t) => t.value === selectedThinking)?.label ?? "Default";
  }, [selectedThinking]);

  // Build the rendered sections: Default (top) → Latest → Favorites →
  // provider groups. Disabled models are hidden everywhere except Default —
  // it's the app's own fallback choice, so it always stays visible even if
  // the user has otherwise disabled that model. Search filters all sections.
  const sections = useMemo<ModelSection[]>(() => {
    const q = search.toLowerCase().trim();
    const matches = (providerName: string, model: string, providerType: string) =>
      !q ||
      model.toLowerCase().includes(q) ||
      providerName.toLowerCase().includes(q) ||
      providerType.toLowerCase().includes(q);

    const providerSections: ModelSection[] = [];
    const allEnabled: ModelEntry[] = [];
    for (const p of providers) {
      const entries: ModelEntry[] = [];
      for (const model of p.models) {
        const pref = prefs[prefKey(p.providerId, model)];
        if (pref && !pref.isEnabled) continue; // disabled — hidden from chat
        if (!matches(p.providerName, model, p.providerType)) continue;
        const entry: ModelEntry = {
          providerId: p.providerId,
          providerName: p.providerName,
          providerType: p.providerType,
          model,
        };
        entries.push(entry);
        allEnabled.push(entry);
      }
      // Alphabetical within a provider's own model list.
      entries.sort((a, b) => a.model.localeCompare(b.model, undefined, { sensitivity: "base" }));
      if (entries.length > 0) {
        providerSections.push({ key: `prov-${p.providerId}`, label: p.providerName, icon: null, entries });
      }
    }
    // Alphabetical by provider name — the raw `providers` order otherwise
    // just follows DB insertion order, which is meaningless to a user.
    providerSections.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

    const top: ModelSection[] = [];

    // Default — the default AI provider's own model. Always first, regardless
    // of usage history or favourites, so there's always one guaranteed,
    // one-click way back to the app's actual default.
    if (defaultEntry && matches(defaultEntry.providerName, defaultEntry.model, defaultEntry.providerType)) {
      top.push({ key: "default", label: "Default", icon: "default", entries: [defaultEntry] });
    }

    // Latest — enabled models with a last-used timestamp, most recent first, cap 10.
    const latest = allEnabled
      .filter((e) => prefs[prefKey(e.providerId, e.model)]?.lastUsedAt)
      .sort((a, b) => {
        const ta = prefs[prefKey(a.providerId, a.model)]?.lastUsedAt ?? "";
        const tb = prefs[prefKey(b.providerId, b.model)]?.lastUsedAt ?? "";
        return tb.localeCompare(ta);
      })
      .slice(0, 10);
    if (latest.length > 0) top.push({ key: "latest", label: "Latest", icon: "latest", entries: latest });

    // Favorites — enabled, favourited models.
    const favorites = allEnabled.filter((e) => prefs[prefKey(e.providerId, e.model)]?.isFavorite);
    if (favorites.length > 0) top.push({ key: "favorites", label: "Favorites", icon: "favorites", entries: favorites });

    return [...top, ...providerSections];
  }, [providers, prefs, search, defaultEntry]);

  return (
    <div className={cn("flex flex-wrap items-center gap-2 gap-y-2", compact ? "pl-4" : "px-4 pb-1.5")}>
      {/* Build / Plan mode toggle */}
      {!hideBuildPlanToggle && (
        <Tip content={planMode ? "Plan Mode: read-only planning. Agents propose, useful for complex tasks." : "Build Mode: agents can write files and execute."} side="top">
          <button
            type="button"
            onClick={togglePlanMode}
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors",
              "border border-transparent",
              planMode
                ? "text-violet-700 bg-violet-50 border-violet-200 hover:bg-violet-100"
                : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
          >
            {planMode
              ? <Eye className="w-3.5 h-3.5 text-violet-500" />
              : <Hammer className="w-3.5 h-3.5 text-muted-foreground/60" />}
            <span>{planMode ? "Plan" : "Build"}</span>
          </button>
        </Tip>
      )}

      {/* Model selector */}
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Tooltip delayDuration={300}>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs",
                  "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
                  "border border-transparent hover:border-border",
                  open && "bg-muted border-border text-foreground",
                )}
              >
                <Cpu className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                <span className="max-w-[40vw] sm:max-w-[200px] truncate">{displayLabel}</span>
                <ChevronDown className="w-3 h-3 text-muted-foreground/60" />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top">Choose Model</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={4}
          className="w-[320px] p-0 max-h-[400px] flex flex-col"
        >
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
            <Search className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
                className="shrink-0 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Model list */}
          <div className="overflow-y-auto flex-1 py-1">
            {loading && (
              <div className="px-3 py-4 text-xs text-muted-foreground/60 text-center">
                Loading models...
              </div>
            )}
            {!loading && sections.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground/60 text-center">
                {providers.length === 0 ? "No providers configured" : "No models found"}
              </div>
            )}
            {!loading && sections.map((section, idx) => (
              <div key={section.key}>
                {/* Section separator + header */}
                {idx > 0 && <hr className="border-t border-border my-1" />}
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-indigo-600 uppercase tracking-wider">
                  {section.icon === "default" && <BadgeCheck className="w-3 h-3" />}
                  {section.icon === "latest" && <Clock className="w-3 h-3" />}
                  {section.icon === "favorites" && <Star className="w-3 h-3 fill-current" />}
                  <span>{section.label}</span>
                </div>
                {section.entries.map((entry) => {
                  const isSelected = selectedProviderId === entry.providerId && selectedModelId === entry.model;
                  const isFavorite = prefs[prefKey(entry.providerId, entry.model)]?.isFavorite ?? false;
                  return (
                    <div
                      key={`${section.key}-${entry.providerId}-${entry.model}`}
                      className={cn(
                        "group/row w-full flex items-center gap-1 px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors cursor-pointer",
                        isSelected && "bg-indigo-50 text-indigo-700 font-medium",
                      )}
                      onClick={() => selectModel(entry.providerId, entry.model)}
                    >
                      <span className="flex-1 truncate text-left">{entry.model}</span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-indigo-600 shrink-0" />}
                      <button
                        type="button"
                        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(entry.providerId, entry.model);
                        }}
                        className={cn(
                          "shrink-0 p-0.5 rounded hover:bg-muted transition-opacity",
                          isFavorite
                            ? "text-amber-500 opacity-100"
                            : "text-muted-foreground/50 opacity-0 group-hover/row:opacity-100",
                        )}
                      >
                        <Star className={cn("w-3.5 h-3.5", isFavorite && "fill-current")} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Thinking level selector */}
      <Popover open={thinkingOpen} onOpenChange={setThinkingOpen}>
        <Tooltip delayDuration={300}>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs",
                  "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
                  "border border-transparent hover:border-border",
                  thinkingOpen && "bg-muted border-border text-foreground",
                )}
              >
                <Brain className="w-3.5 h-3.5 text-muted-foreground/60" />
                <span>{thinkingLabel}</span>
                <ChevronDown className="w-3 h-3 text-muted-foreground/60" />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top">Choose Thinking Level</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={4}
          className="w-[140px] p-1"
        >
          {THINKING_LEVELS.map((level) => (
            <button
              key={level.value}
              type="button"
              onClick={() => selectThinking(level.value)}
              className={cn(
                "w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-muted/50 transition-colors",
                selectedThinking === level.value && "bg-indigo-50 text-indigo-700 font-medium",
              )}
            >
              {level.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Shell approval toggle */}
      {!hideShellApproval && (
        <Tip content={shellApproval ? "Shell commands require approval" : "Shell commands auto-approved"} side="top">
          <button
            type="button"
            onClick={toggleShellApproval}
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors",
              "border border-transparent",
              shellApproval
                ? "text-emerald-700 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950/30"
                : "text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950/30",
            )}
          >
            <ShieldCheck className={cn("w-3.5 h-3.5", shellApproval ? "text-emerald-600" : "text-red-600")} />
            <span>{shellApproval ? "Shell: Ask" : "Shell: Auto"}</span>
          </button>
        </Tip>
      )}

      {/* Context usage — pushed to far right */}
      {messages?.length > 0 && (
        <div className="ml-auto">
          <ContextIndicator messages={messages} projectId={projectId} variant="inline" />
        </div>
      )}
    </div>
  );
}
