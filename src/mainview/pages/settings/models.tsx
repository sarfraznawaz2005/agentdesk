import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, Star, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { ModelTypeBadge } from "@/components/ui/model-type-badge";
import { MODEL_TYPE_BADGE_STYLES, MODEL_TYPE_FILTER_LABELS, type ModelType } from "@/lib/model-types";

interface ProviderModels {
  providerId: string;
  providerName: string;
  providerType: string;
  models: string[];
}

/** Per-model state keyed by `${providerId}|${modelId}`. */
type ModelPrefMap = Record<string, { isEnabled: boolean; isFavorite: boolean }>;
/** Model type keyed by providerId, then modelId. */
type ModelTypeMap = Record<string, Record<string, ModelType>>;

const prefKey = (providerId: string, model: string) => `${providerId}|${model}`;

/**
 * Settings → AI → Models.
 *
 * Lets the user enable/disable individual models (all enabled by default) and
 * mark favourites. Both are global, app-wide preferences stored in the
 * `model_preferences` table. Disabled models are hidden from the chat model
 * picker; favourites surface in the picker's "Favorites" section. State is
 * persisted optimistically on each toggle — there is no explicit Save.
 */
export function ModelsSettings() {
  const [providers, setProviders] = useState<ProviderModels[]>([]);
  const [prefs, setPrefs] = useState<ModelPrefMap>({});
  const [types, setTypes] = useState<ModelTypeMap>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeTypeFilters, setActiveTypeFilters] = useState<Set<ModelType>>(new Set());

  // ---- Load on mount -------------------------------------------------------

  const loadTypes = useCallback(async () => {
    try {
      const typesResult = await rpc.getModelTypes();
      setTypes(typesResult as ModelTypeMap);
    } catch {
      // Non-fatal — badges/filter just stay empty if classification fails
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [models, prefRows] = await Promise.all([
          rpc.getConnectedProviderModels(),
          rpc.getModelPreferences(),
        ]);
        if (cancelled) return;
        setProviders(models);
        const map: ModelPrefMap = {};
        for (const r of prefRows) {
          map[prefKey(r.providerId, r.modelId)] = {
            isEnabled: r.isEnabled,
            isFavorite: r.isFavorite,
          };
        }
        setPrefs(map);
      } catch {
        if (!cancelled) toast("error", "Failed to load models.");
      } finally {
        if (!cancelled) setLoading(false);
      }
      // Fire-and-forget: badges/filter chips populate once classification
      // finishes, without blocking the rest of the page on it.
      if (!cancelled) loadTypes();
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [loadTypes]);

  // Provider add/edit/delete invalidates the type cache server-side —
  // re-pull so badges/filters reflect the change.
  useEffect(() => {
    window.addEventListener("agentdesk:providers-changed", loadTypes);
    return () => window.removeEventListener("agentdesk:providers-changed", loadTypes);
  }, [loadTypes]);

  // Cross-view live sync: re-pull preferences when they change elsewhere (e.g.
  // a favourite toggled from the chat model picker), including across windows.
  useEffect(() => {
    async function refreshPrefs() {
      try {
        const prefRows = await rpc.getModelPreferences();
        const map: ModelPrefMap = {};
        for (const r of prefRows) {
          map[prefKey(r.providerId, r.modelId)] = { isEnabled: r.isEnabled, isFavorite: r.isFavorite };
        }
        setPrefs(map);
      } catch {
        // Ignore — keep current state on a failed refresh
      }
    }
    window.addEventListener("agentdesk:model-preferences-changed", refreshPrefs);
    return () => window.removeEventListener("agentdesk:model-preferences-changed", refreshPrefs);
  }, []);

  // ---- Toggle handlers (optimistic + persist) ------------------------------

  const setEnabled = useCallback(async (providerId: string, model: string, enabled: boolean) => {
    const key = prefKey(providerId, model);
    setPrefs((prev) => ({
      ...prev,
      [key]: { isEnabled: enabled, isFavorite: prev[key]?.isFavorite ?? false },
    }));
    const res = await rpc.setModelEnabled(providerId, model, enabled).catch(() => null);
    if (!res?.success) toast("error", "Failed to update model.");
  }, []);

  const setFavorite = useCallback(async (providerId: string, model: string, favorite: boolean) => {
    const key = prefKey(providerId, model);
    setPrefs((prev) => ({
      ...prev,
      [key]: { isEnabled: prev[key]?.isEnabled ?? true, isFavorite: favorite },
    }));
    const res = await rpc.setModelFavorite(providerId, model, favorite).catch(() => null);
    if (!res?.success) toast("error", "Failed to update favorite.");
  }, []);

  // Master toggle — enable/disable every listed model of a provider at once.
  const setProviderEnabled = useCallback(async (providerId: string, modelIds: string[], enabled: boolean) => {
    if (modelIds.length === 0) return;
    setPrefs((prev) => {
      const next = { ...prev };
      for (const m of modelIds) {
        const key = prefKey(providerId, m);
        next[key] = { isEnabled: enabled, isFavorite: prev[key]?.isFavorite ?? false };
      }
      return next;
    });
    const res = await rpc.setModelsEnabled(providerId, modelIds, enabled).catch(() => null);
    if (!res?.success) toast("error", "Failed to update models.");
  }, []);

  // ---- Type + search filter --------------------------------------------------

  const getModelType = useCallback(
    (providerId: string, model: string): ModelType => types[providerId]?.[model] ?? "language",
    [types],
  );

  // Type filter chips — only types actually present among the current models,
  // with counts from the full (unfiltered-by-search) provider lists so chip
  // counts stay stable while searching.
  const typeFilterOptions = useMemo(() => {
    const counts = new Map<ModelType, number>();
    for (const p of providers) {
      for (const m of p.models) {
        const t = getModelType(p.providerId, m);
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([type, count]) => ({ type, count, label: MODEL_TYPE_FILTER_LABELS[type] }))
      .sort((a, b) => b.count - a.count);
  }, [providers, getModelType]);

  const toggleTypeFilter = useCallback((type: ModelType) => {
    setActiveTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return providers
      .map((p) => ({
        ...p,
        models: p.models.filter((m) => {
          if (activeTypeFilters.size > 0 && !activeTypeFilters.has(getModelType(p.providerId, m))) return false;
          if (!q) return true;
          return m.toLowerCase().includes(q) || p.providerName.toLowerCase().includes(q);
        }),
      }))
      .filter((p) => p.models.length > 0);
  }, [providers, search, activeTypeFilters, getModelType]);

  // Enabled/total counts from the FULL (unfiltered) provider lists, so the
  // headline + per-provider tallies stay stable while searching. A model counts
  // as enabled unless it has an explicit is_enabled=0 row.
  const { globalEnabled, globalTotal, providerCounts } = useMemo(() => {
    let ge = 0;
    let gt = 0;
    const pc: Record<string, { enabled: number; total: number; models: string[] }> = {};
    for (const p of providers) {
      const enabled = p.models.filter((m) => prefs[prefKey(p.providerId, m)]?.isEnabled !== false).length;
      pc[p.providerId] = { enabled, total: p.models.length, models: p.models };
      ge += enabled;
      gt += p.models.length;
    }
    return { globalEnabled: ge, globalTotal: gt, providerCounts: pc };
  }, [providers, prefs]);

  // ---- Render --------------------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-56 bg-muted animate-pulse rounded" />
        <div className="h-48 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-foreground">
          Models
          {globalTotal > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({globalEnabled} enabled out of {globalTotal})
            </span>
          )}
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Enable or disable individual models and mark favourites. Disabled
          models are hidden from the chat model picker; favourites appear in its
          Favorites section. Changes are saved automatically and apply across all
          projects. Non-chat models (embedding, image, etc.) are badged by type
          and disabled by default — use the filters below to find them.
        </p>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 px-3 py-2 border border-border rounded-md">
        <Search className="w-4 h-4 text-muted-foreground/60 shrink-0" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search models..."
          className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground/60"
        />
        {search && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setSearch("")}
            className="shrink-0 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Type filter chips — only types actually present in the current list */}
      {typeFilterOptions.length > 1 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {typeFilterOptions.map(({ type, count, label }) => {
              const active = activeTypeFilters.has(type);
              const style = MODEL_TYPE_BADGE_STYLES[type];
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleTypeFilter(type)}
                  aria-pressed={active}
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-full border transition-colors",
                    active
                      ? cn(style?.className ?? "bg-foreground/10 text-foreground", "border-transparent")
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {label} ({count})
                </button>
              );
            })}
            {activeTypeFilters.size > 0 && (
              <button
                type="button"
                onClick={() => setActiveTypeFilters(new Set())}
                className="text-xs px-2.5 py-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground/70">
            Types are guessed on a best-effort basis from public model catalogs and may be wrong or missing for obscure or renamed models.
          </p>
        </div>
      )}

      {providers.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No providers configured. Add one under the Providers tab first.
        </p>
      )}

      {providers.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {search ? `No models match "${search}".` : "No models match the selected type filter."}
        </p>
      )}

      {filtered.map((provider) => {
        const counts = providerCounts[provider.providerId] ?? {
          enabled: 0,
          total: provider.models.length,
          models: provider.models,
        };
        const allEnabled = counts.total > 0 && counts.enabled === counts.total;
        return (
        <div key={provider.providerId}>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-foreground">
              {provider.providerName}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({counts.enabled} enabled out of {counts.total})
              </span>
            </h4>
            {counts.total > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {allEnabled ? "All enabled" : "Enable all"}
                </span>
                <Switch
                  checked={allEnabled}
                  aria-label={allEnabled ? "Disable all models" : "Enable all models"}
                  onCheckedChange={(v) => setProviderEnabled(provider.providerId, counts.models, v)}
                />
              </div>
            )}
          </div>
          <Card>
            <CardContent className="pt-4 space-y-0">
              {provider.models.length === 0 ? (
                <p className="text-xs text-muted-foreground/60 italic py-1">No models found</p>
              ) : (
                provider.models.map((model, i) => {
                  const pref = prefs[prefKey(provider.providerId, model)];
                  const enabled = pref?.isEnabled ?? true;
                  const favorite = pref?.isFavorite ?? false;
                  return (
                    <div key={model}>
                      {i > 0 && <Separator />}
                      <div className="flex items-center gap-3 py-2.5">
                        <button
                          type="button"
                          aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
                          onClick={() => setFavorite(provider.providerId, model, !favorite)}
                          className={cn(
                            "shrink-0 p-0.5 rounded hover:bg-muted transition-colors",
                            favorite ? "text-amber-500" : "text-muted-foreground/40 hover:text-muted-foreground",
                          )}
                        >
                          <Star className={cn("w-4 h-4", favorite && "fill-current")} />
                        </button>
                        <span
                          className={cn(
                            "flex-1 text-sm truncate",
                            enabled ? "font-medium text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {model}
                        </span>
                        <ModelTypeBadge type={types[provider.providerId]?.[model]} />
                        <Switch
                          checked={enabled}
                          onCheckedChange={(v) => setEnabled(provider.providerId, model, v)}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
        );
      })}
    </div>
  );
}
