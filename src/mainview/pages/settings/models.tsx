import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, Star, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";

interface ProviderModels {
  providerId: string;
  providerName: string;
  providerType: string;
  models: string[];
}

/** Per-model state keyed by `${providerId}|${modelId}`. */
type ModelPrefMap = Record<string, { isEnabled: boolean; isFavorite: boolean }>;

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
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // ---- Load on mount -------------------------------------------------------

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
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // ---- Search filter -------------------------------------------------------

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return providers;
    return providers
      .map((p) => ({
        ...p,
        models: p.models.filter(
          (m) => m.toLowerCase().includes(q) || p.providerName.toLowerCase().includes(q),
        ),
      }))
      .filter((p) => p.models.length > 0);
  }, [providers, search]);

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
        <h3 className="text-lg font-semibold text-foreground">Models</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Enable or disable individual models and mark favourites. Disabled
          models are hidden from the chat model picker; favourites appear in its
          Favorites section. Changes are saved automatically and apply across all
          projects.
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

      {providers.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No providers configured. Add one under the Providers tab first.
        </p>
      )}

      {providers.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">No models match “{search}”.</p>
      )}

      {filtered.map((provider) => {
        const allEnabled = provider.models.every(
          (m) => prefs[prefKey(provider.providerId, m)]?.isEnabled ?? true,
        );
        return (
        <div key={provider.providerId}>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-foreground">
              {provider.providerName}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {provider.models.length} {provider.models.length === 1 ? "model" : "models"}
              </span>
            </h4>
            {provider.models.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {allEnabled ? "All enabled" : "Enable all"}
                </span>
                <Switch
                  checked={allEnabled}
                  aria-label={allEnabled ? "Disable all models" : "Enable all models"}
                  onCheckedChange={(v) => setProviderEnabled(provider.providerId, provider.models, v)}
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
