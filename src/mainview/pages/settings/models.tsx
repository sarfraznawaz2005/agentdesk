import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, Star, Wifi, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [testingKey, setTestingKey] = useState<string | null>(null);

  // ---- Load on mount -------------------------------------------------------

  const loadTypes = useCallback(async () => {
    try {
      const typesResult = await rpc.getModelTypes();
      setTypes(typesResult as ModelTypeMap);
    } catch {
      // Non-fatal — badges/filter just stay empty if classification fails
    }
  }, []);

  // Re-pull the provider/model list itself — used on mount and again whenever
  // a provider is added/edited/deleted while this page stays mounted (e.g.
  // from another window; sub-tab switches already remount this component and
  // get a fresh fetch for free, but a change from elsewhere while sitting on
  // this tab would otherwise never be reflected here).
  const loadModels = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    try {
      const [models, prefRows] = await Promise.all([
        rpc.getConnectedProviderModels(),
        rpc.getModelPreferences(),
      ]);
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
      if (showSpinner) toast("error", "Failed to load models.");
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels(true);
    // Fire-and-forget: badges/filter chips populate once classification
    // finishes, without blocking the rest of the page on it.
    loadTypes();
  }, [loadModels, loadTypes]);

  // Provider add/edit/delete invalidates the type cache server-side and can
  // change the connected models themselves — re-pull both so badges/filters
  // and the actual list reflect the change. No spinner here: this page is
  // already showing data, a full-page loading flash on a background refresh
  // would be jarring.
  useEffect(() => {
    const onProvidersChanged = () => {
      loadModels(false);
      loadTypes();
    };
    window.addEventListener("agentdesk:providers-changed", onProvidersChanged);
    return () => window.removeEventListener("agentdesk:providers-changed", onProvidersChanged);
  }, [loadModels, loadTypes]);

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

  // ---- Multi-select + bulk enable/disable -----------------------------------
  // Independent of the per-provider "enable all" switch above — this lets the
  // user hand-pick an arbitrary set of models (across providers) and flip them
  // together, e.g. after spotting a batch of dead ones in the list.

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSelectProvider = useCallback((providerId: string, modelIds: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of modelIds) {
        const key = prefKey(providerId, m);
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }, []);

  const bulkSetEnabled = useCallback(async (enabled: boolean) => {
    const byProvider = new Map<string, string[]>();
    for (const key of selected) {
      const sep = key.indexOf("|");
      const providerId = key.slice(0, sep);
      const model = key.slice(sep + 1);
      const arr = byProvider.get(providerId) ?? [];
      arr.push(model);
      byProvider.set(providerId, arr);
    }
    setPrefs((prev) => {
      const next = { ...prev };
      for (const key of selected) {
        next[key] = { isEnabled: enabled, isFavorite: prev[key]?.isFavorite ?? false };
      }
      return next;
    });
    const results = await Promise.all(
      [...byProvider.entries()].map(([providerId, modelIds]) =>
        rpc.setModelsEnabled(providerId, modelIds, enabled).catch(() => null),
      ),
    );
    if (results.some((r) => !r?.success)) toast("error", "Failed to update some models.");
    setSelected(new Set());
  }, [selected]);

  // ---- Per-model connection test ---------------------------------------------

  const handleTestModel = useCallback(async (providerId: string, model: string) => {
    const key = prefKey(providerId, model);
    setTestingKey(key);
    try {
      const result = await rpc.testProviderModel({ providerId, modelId: model });
      if (result.success) {
        toast("success", `"${model}" is working.`);
      } else {
        toast("error", result.error ? `Test failed: ${result.error}` : `"${model}" failed to respond.`);
      }
    } catch {
      toast("error", "Connection test failed.");
    } finally {
      setTestingKey(null);
    }
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
        models: p.models
          .filter((m) => {
            if (activeTypeFilters.size > 0 && !activeTypeFilters.has(getModelType(p.providerId, m))) return false;
            if (!q) return true;
            return m.toLowerCase().includes(q) || p.providerName.toLowerCase().includes(q);
          })
          // Alphabetical within a provider's own model list.
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
      }))
      .filter((p) => p.models.length > 0)
      // Alphabetical by provider name — the raw order otherwise just follows
      // DB insertion order, which is meaningless to a user.
      .sort((a, b) => a.providerName.localeCompare(b.providerName, undefined, { sensitivity: "base" }));
  }, [providers, search, activeTypeFilters, getModelType]);

  // Every model key currently visible under the active search/type filters,
  // spanning all providers — backs the "select all visible" shortcut so bulk
  // enable/disable isn't limited to one provider at a time.
  const filteredKeys = useMemo(
    () => filtered.flatMap((p) => p.models.map((m) => prefKey(p.providerId, m))),
    [filtered],
  );
  const allFilteredSelected = filteredKeys.length > 0 && filteredKeys.every((k) => selected.has(k));

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

      {/* Bulk select bar — a "select all visible" shortcut spanning every
          provider currently shown, plus bulk Enable/Disable once something's
          selected. Always present (not just once something's selected) so
          the cross-provider select-all is reachable in one click. */}
      {filteredKeys.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-muted/40">
          <input
            type="checkbox"
            aria-label={allFilteredSelected ? "Deselect all visible models" : "Select all visible models"}
            checked={allFilteredSelected}
            ref={(el) => {
              if (el) el.indeterminate = !allFilteredSelected && selected.size > 0;
            }}
            onChange={(e) => setSelected(e.target.checked ? new Set(filteredKeys) : new Set())}
            className="h-4 w-4 rounded border-input text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <span className="text-sm text-muted-foreground">
            {selected.size > 0 ? `${selected.size} model${selected.size === 1 ? "" : "s"} selected` : "Select all visible"}
          </span>
          {selected.size > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => bulkSetEnabled(true)}>
                Enable
              </Button>
              <Button size="sm" variant="outline" onClick={() => bulkSetEnabled(false)}>
                Disable
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}
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
        const providerModelKeys = provider.models.map((m) => prefKey(provider.providerId, m));
        const allSelected = providerModelKeys.length > 0 && providerModelKeys.every((k) => selected.has(k));
        const someSelected = providerModelKeys.some((k) => selected.has(k));
        return (
        <div key={provider.providerId}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {provider.models.length > 0 && (
                <input
                  type="checkbox"
                  aria-label={`Select all ${provider.providerName} models`}
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allSelected && someSelected;
                  }}
                  onChange={(e) => toggleSelectProvider(provider.providerId, provider.models, e.target.checked)}
                  className="h-4 w-4 rounded border-input text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              )}
              <h4 className="text-sm font-semibold text-foreground">
                {provider.providerName}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  ({counts.enabled} enabled out of {counts.total})
                </span>
              </h4>
            </div>
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
                  const key = prefKey(provider.providerId, model);
                  const isSelected = selected.has(key);
                  const isTesting = testingKey === key;
                  return (
                    <div key={model}>
                      {i > 0 && <Separator />}
                      <div className="flex items-center gap-3 py-2.5">
                        <input
                          type="checkbox"
                          aria-label={`Select ${model}`}
                          checked={isSelected}
                          onChange={() => toggleSelect(key)}
                          className="shrink-0 h-4 w-4 rounded border-input text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
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
                        <button
                          type="button"
                          aria-label={`Test connection for ${model}`}
                          title="Test connection"
                          disabled={isTesting}
                          onClick={() => handleTestModel(provider.providerId, model)}
                          className="shrink-0 p-1 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isTesting ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Wifi className="w-3.5 h-3.5" aria-hidden="true" />
                          )}
                        </button>
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
