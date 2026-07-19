import { useEffect, useRef, useState } from "react";
import {
  Plus,
  CheckCircle2,
  XCircle,
  Pencil,
  Trash2,
  Wifi,
  Loader2,
  Eye,
  EyeOff,
  Star,
  Copy,
  RefreshCw,
} from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ModelInput } from "@/components/ui/model-input";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Provider {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  defaultModel: string;
  isDefault: boolean;
  isValid: boolean | null;
}

interface FormData {
  name: string;
  providerType: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  isDefault: boolean;
}

const EMPTY_FORM: FormData = {
  name: "",
  providerType: "anthropic",
  apiKey: "",
  baseUrl: "",
  defaultModel: "",
  isDefault: false,
};

const BASE_PROVIDER_TYPE_OPTIONS = [
  { value: "opencode", label: "Free (OpenCode)" },
  { value: "anthropic", label: "Anthropic" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "google", label: "Google Gemini" },
  { value: "groq", label: "Groq" },
  { value: "ollama", label: "Ollama" },
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "xai", label: "xAI Grok" },
  { value: "zai", label: "Z.AI" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
] as const;

const CLAUDE_SUBSCRIPTION_OPTION = { value: "claude-subscription", label: "Claude Subscription" } as const;

// Provider types that need a base URL
const BASE_URL_PROVIDERS = ["ollama", "custom"];

// Matches the backend's OllamaAdapter default — pre-filled when the user picks
// Ollama so they don't have to know/type the local endpoint themselves.
const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";

// Provider types that do not require an API key from the user
const NO_KEY_PROVIDERS = ["opencode", "claude-subscription", "ollama"];

function isValidUrl(v: string): boolean {
  try {
    const url = new URL(v);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normalize a base URL by removing trailing slashes and endpoint suffixes.
 * This ensures consistent handling regardless of user input.
 */
function normalizeBaseUrl(url: string): string {
  return url
    .replace(/\/chat\/completions\/?$/, "")
    .replace(/\/completions\/?$/, "")
    .replace(/\/$/, "");
}


// ---------------------------------------------------------------------------
// Provider type badge colour
// ---------------------------------------------------------------------------

function providerTypeBadgeClass(): string {
  return "border-transparent bg-secondary text-secondary-foreground";
}

function providerTypeLabel(providerType: string): string {
  if (providerType === "claude-subscription") return CLAUDE_SUBSCRIPTION_OPTION.label;
  const match = BASE_PROVIDER_TYPE_OPTIONS.find(
    (o) => o.value === providerType.toLowerCase()
  );
  return match ? match.label : providerType;
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function ProviderCardSkeleton() {
  return (
    <Card className="animate-pulse">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-5 w-32 rounded bg-muted" />
            <div className="h-5 w-16 rounded bg-muted" />
          </div>
          <div className="h-5 w-16 rounded bg-muted shrink-0" />
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-4 w-48 rounded bg-muted mb-4" />
        <Separator className="mb-4" />
        <div className="flex items-center gap-2">
          <div className="h-8 w-28 rounded bg-muted" />
          <div className="h-8 w-14 rounded bg-muted" />
          <div className="h-8 w-16 rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyProviders({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <Wifi className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      </div>
      <h3 className="text-lg font-semibold mb-1">No AI providers configured</h3>
      <p className="text-sm text-muted-foreground max-w-xs mb-6">
        Add your first AI provider to start using AgentDesk. You can connect
        Anthropic, OpenAI, or a custom endpoint.
      </p>
      <Button onClick={onAdd}>
        <Plus aria-hidden="true" />
        Add Provider
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider card
// ---------------------------------------------------------------------------

interface ProviderCardProps {
  provider: Provider;
  testingId: string | null;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onTest: (provider: Provider) => void;
}

function ProviderCard({
  provider,
  testingId,
  onEdit,
  onDelete,
  onTest,
}: ProviderCardProps) {
  const isTesting = testingId === provider.id;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <h3 className="font-semibold truncate">
              {provider.name}
            </h3>
            <Badge
              className={cn(
                "shrink-0 text-xs font-medium pointer-events-none",
                providerTypeBadgeClass()
              )}
            >
              {providerTypeLabel(provider.providerType)}
            </Badge>
            {provider.isDefault && (
              <Tip content="Default provider" side="top">
                <span
                  className="inline-flex items-center gap-1 text-xs text-amber-600 font-medium shrink-0"
                >
                  <Star
                    className="h-3 w-3 fill-amber-500 text-amber-500"
                    aria-hidden="true"
                  />
                  Default
                </span>
              </Tip>
            )}
          </div>

          {/* Validation status */}
          <div className="shrink-0" aria-live="polite">
            {provider.isValid === true && (
              <span className="inline-flex items-center gap-1 text-xs text-green-600 font-medium">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Valid
              </span>
            )}
            {provider.isValid === false && (
              <span className="inline-flex items-center gap-1 text-xs text-destructive font-medium">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                Invalid
              </span>
            )}
            {provider.isValid === null && (
              <span className="text-xs text-muted-foreground font-medium">
                Untested
              </span>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {/* Details */}
        <dl className="text-sm text-muted-foreground space-y-1 mb-4">
          {provider.defaultModel && (
            <div className="flex gap-2">
              <dt className="font-medium text-foreground/60">Model:</dt>
              <dd className="truncate">{provider.defaultModel}</dd>
            </div>
          )}
          {provider.baseUrl && (
            <div className="flex gap-2">
              <dt className="font-medium text-foreground/60">Base URL:</dt>
              <dd className="truncate">{provider.baseUrl}</dd>
            </div>
          )}
        </dl>

        <Separator className="mb-4" />

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onTest(provider)}
            disabled={isTesting}
            aria-label={`Test connection for ${provider.name}`}
          >
            {isTesting ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                Testing...
              </>
            ) : (
              <>
                <Wifi aria-hidden="true" />
                Test Connection
              </>
            )}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEdit(provider)}
            aria-label={`Edit ${provider.name}`}
          >
            <Pencil aria-hidden="true" />
            Edit
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(provider)}
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            aria-label={`Delete ${provider.name}`}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Find Working Models dialog — tests every discovered model against the
// provider's live credentials (sequentially, so it doesn't hammer rate
// limits) and lets the user pick one of the ones that actually respond.
// ---------------------------------------------------------------------------

interface ModelTestResult {
  model: string;
  status: "pending" | "testing" | "success" | "failed";
  error?: string;
}

interface FindWorkingModelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: string[];
  providerType: string;
  apiKey: string;
  baseUrl: string;
  // Only set when editing an already-saved provider — Disable Non-Working
  // writes to the model_preferences table, which is keyed by a real
  // provider id, so there's nothing to disable for a provider that hasn't
  // been saved yet.
  providerId?: string;
  onSelect: (model: string) => void;
}

function FindWorkingModelsDialog({
  open,
  onOpenChange,
  models,
  providerType,
  apiKey,
  baseUrl,
  providerId,
  onSelect,
}: FindWorkingModelsDialogProps) {
  const [results, setResults] = useState<ModelTestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Current enabled/disabled state (Models settings) for this provider's
  // models, keyed by model id — lets the dialog notice when a model that was
  // previously disabled (e.g. via a past Disable Non-Working click) now
  // tests successfully, so it can offer to flip it back on.
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>({});
  const cancelledRef = useRef(false);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Reset (but don't start) whenever the dialog opens — the user kicks off
  // testing explicitly via the Start button.
  useEffect(() => {
    if (!open) return;
    cancelledRef.current = true;
    setRunning(false);
    setResults(models.map((model) => ({ model, status: "pending" })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset once per dialog open, not on every prop identity change
  }, [open]);

  // Pull current Models-settings enablement for this provider so the
  // "Re-enable" affordance can tell a previously-disabled model apart from
  // one that's already enabled.
  useEffect(() => {
    if (!open || !providerId) { setEnabledMap({}); return; }
    rpc.getModelPreferences()
      .then((rows) => {
        const map: Record<string, boolean> = {};
        for (const r of rows) {
          if (r.providerId === providerId) map[r.modelId] = r.isEnabled;
        }
        setEnabledMap(map);
      })
      .catch(() => setEnabledMap({}));
  }, [open, providerId]);

  // Follow the model currently being checked, not just the bottom of the list —
  // keeps the active row in view as testing progresses through the list.
  useEffect(() => {
    const active = results.find((r) => r.status === "testing");
    if (active) itemRefs.current[active.model]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [results]);

  async function handleStart() {
    cancelledRef.current = false;
    setRunning(true);
    // Resume: skip models already resolved from a previous Start/Stop cycle.
    const toTest = results.filter((r) => r.status !== "success" && r.status !== "failed").map((r) => r.model);
    const effectiveApiKey = NO_KEY_PROVIDERS.includes(providerType) ? "public" : apiKey.trim();
    for (let i = 0; i < toTest.length; i++) {
      if (cancelledRef.current) break;
      const model = toTest[i];
      setResults((prev) => prev.map((r) => (r.model === model ? { ...r, status: "testing" } : r)));
      try {
        const result = await rpc.testProviderWithCredentials({
          providerType,
          apiKey: effectiveApiKey,
          baseUrl: baseUrl.trim() || undefined,
          defaultModel: model,
        });
        if (cancelledRef.current) break;
        setResults((prev) =>
          prev.map((r) => (r.model === model ? { ...r, status: result.success ? "success" : "failed", error: result.error } : r))
        );
      } catch (err) {
        if (cancelledRef.current) break;
        setResults((prev) =>
          prev.map((r) => (r.model === model ? { ...r, status: "failed", error: err instanceof Error ? err.message : String(err) } : r))
        );
      }
      // Small pacing gap between requests — many providers (esp. free tiers)
      // cap requests-per-minute, and back-to-back calls risk mistaking a
      // rate-limit rejection for the model itself not working.
      if (i < toTest.length - 1 && !cancelledRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    setRunning(false);
  }

  const testedCount = results.filter((r) => r.status === "success" || r.status === "failed").length;
  const workingCount = results.filter((r) => r.status === "success").length;
  const allTested = models.length > 0 && testedCount === models.length;
  // Once a run has stopped (finished or user-cancelled), the raw per-model
  // progress is no longer useful — narrow the list down to just the models
  // that actually worked, since those are the only ones selectable anyway.
  const finished = !running && testedCount > 0;
  const visibleResults = finished ? results.filter((r) => r.status === "success") : results;

  function handleStop() {
    cancelledRef.current = true;
    setRunning(false);
  }

  async function handleCopyWorking() {
    const working = results.filter((r) => r.status === "success").map((r) => r.model);
    try {
      await navigator.clipboard.writeText(working.join("\n"));
      toast("success", working.length > 0 ? `Copied ${working.length} working model${working.length === 1 ? "" : "s"}.` : "No working models to copy yet.");
    } catch {
      toast("error", "Failed to copy to clipboard.");
    }
  }

  // Models this run found failing that are currently enabled in Models
  // settings, and models it found working that are currently disabled there
  // (most likely from a past sync, before the provider's models changed) —
  // together these are exactly what a sync needs to change.
  const modelsToDisable = providerId
    ? results.filter((r) => r.status === "failed" && enabledMap[r.model] !== false).map((r) => r.model)
    : [];
  const modelsToEnable = providerId
    ? results.filter((r) => r.status === "success" && enabledMap[r.model] === false).map((r) => r.model)
    : [];

  // Reconciles Models settings with this run's results in one step: disables
  // whatever just failed, re-enables whatever just started working again, so
  // the chat model picker only ever offers models known to actually respond.
  async function handleSyncModels() {
    if (!providerId) return;
    if (modelsToDisable.length === 0 && modelsToEnable.length === 0) {
      toast("success", "Models settings already match these results.");
      return;
    }
    setSyncing(true);
    const [disableRes, enableRes] = await Promise.all([
      modelsToDisable.length > 0
        ? rpc.setModelsEnabled(providerId, modelsToDisable, false).catch(() => null)
        : Promise.resolve({ success: true }),
      modelsToEnable.length > 0
        ? rpc.setModelsEnabled(providerId, modelsToEnable, true).catch(() => null)
        : Promise.resolve({ success: true }),
    ]);
    setSyncing(false);
    if (disableRes?.success && enableRes?.success) {
      setEnabledMap((prev) => {
        const next = { ...prev };
        for (const m of modelsToDisable) next[m] = false;
        for (const m of modelsToEnable) next[m] = true;
        return next;
      });
      const parts: string[] = [];
      if (modelsToDisable.length > 0) parts.push(`disabled ${modelsToDisable.length} non-working`);
      if (modelsToEnable.length > 0) parts.push(`re-enabled ${modelsToEnable.length} working`);
      const total = modelsToDisable.length + modelsToEnable.length;
      toast("success", `${parts.join(", ")} model${total === 1 ? "" : "s"} in Models settings.`);
    } else {
      toast("error", "Failed to update some models.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) cancelledRef.current = true;
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-lg flex flex-col max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>Find Working Models</DialogTitle>
          <DialogDescription>
            {running
              ? `Testing models... (${testedCount}/${models.length})`
              : testedCount === 0
              ? `${models.length} model${models.length === 1 ? "" : "s"} found. Click Start to test them against your credentials.`
              : workingCount === 0
              ? `No working models found${allTested ? "" : " (stopped early)"}.`
              : `${workingCount} of ${testedCount} tested model${testedCount === 1 ? "" : "s"} responded successfully${
                  allTested ? "" : " (stopped early)"
                }. Select one to use as the default model.`}
          </DialogDescription>
        </DialogHeader>

        {finished && workingCount === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No working models found.
          </div>
        ) : (
        <div className="max-h-[32rem] overflow-y-auto grid gap-0.5 -mx-1 px-1">
          {visibleResults.map((r) => (
            <button
              key={r.model}
              ref={(el) => { itemRefs.current[r.model] = el; }}
              type="button"
              disabled={r.status !== "success"}
              onClick={() => {
                onSelect(r.model);
                onOpenChange(false);
              }}
              title={r.error}
              className={cn(
                "flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors",
                r.status === "success" ? "hover:bg-muted cursor-pointer" : "cursor-default"
              )}
            >
              <span className={cn("truncate font-mono text-xs", r.status === "failed" && "text-muted-foreground line-through")}>
                {r.model}
              </span>
              {r.status === "pending" && <span className="text-xs text-muted-foreground shrink-0">Pending</span>}
              {r.status === "testing" && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" aria-hidden="true" />}
              {r.status === "success" && <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" aria-hidden="true" />}
              {r.status === "failed" && <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" aria-hidden="true" />}
            </button>
          ))}
        </div>
        )}

        {testedCount > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleCopyWorking}>
              <Copy aria-hidden="true" />
              Copy Working
            </Button>
            {providerId ? (
              <Tip
                content="Disables models that just failed and re-enables ones that just started working again, in Models settings."
                side="top"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSyncModels}
                  disabled={syncing || (modelsToDisable.length === 0 && modelsToEnable.length === 0)}
                >
                  {syncing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                  Sync Working Models
                </Button>
              </Tip>
            ) : (
              <Tip content="Save the provider first to manage its models" side="top">
                <Button variant="ghost" size="sm" disabled>
                  <RefreshCw aria-hidden="true" />
                  Sync Working Models
                </Button>
              </Tip>
            )}
          </div>
        )}

        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={handleStop}>
              Stop
            </Button>
          ) : allTested ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleStart} disabled={models.length === 0}>
                {testedCount > 0 ? "Resume" : "Start"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add / Edit dialog
// ---------------------------------------------------------------------------

interface ProviderDialogProps {
  open: boolean;
  editingProvider: Provider | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

function ProviderDialog({
  open,
  editingProvider,
  onOpenChange,
  onSaved,
}: ProviderDialogProps) {
  const isEditing = editingProvider !== null;

  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingKey, setLoadingKey] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [toolChoiceWarning, setToolChoiceWarning] = useState<string | null>(null);
  const [claudeSubscriptionEnabled, setClaudeSubscriptionEnabled] = useState(false);
  const [findWorkingOpen, setFindWorkingOpen] = useState(false);
  // Read inside the model-auto-fetch effect below without making it a dependency —
  // that effect should only re-run on providerType/apiKey/baseUrl changes, not on
  // every keystroke in the Default Model field.
  const defaultModelRef = useRef(form.defaultModel);
  useEffect(() => { defaultModelRef.current = form.defaultModel; }, [form.defaultModel]);

  const providerTypeOptions = claudeSubscriptionEnabled
    ? [...BASE_PROVIDER_TYPE_OPTIONS, CLAUDE_SUBSCRIPTION_OPTION]
    : BASE_PROVIDER_TYPE_OPTIONS;

  useEffect(() => {
    rpc.getClaudeSubscriptionEnabled()
      .then(({ enabled }) => setClaudeSubscriptionEnabled(enabled))
      .catch(() => {});
  }, []);

  // Reset form whenever the dialog opens or switches between add and edit
  useEffect(() => {
    if (open) {
      if (isEditing) {
        setForm({
          name: editingProvider.name,
          providerType: editingProvider.providerType,
          apiKey: "",
          baseUrl: editingProvider.baseUrl ?? "",
          defaultModel: editingProvider.defaultModel ?? "",
          isDefault: editingProvider.isDefault,
        });
        setShowApiKey(false);
        setToolChoiceWarning(null);
        // Load the stored key so it's visible (masked) in the field
        setLoadingKey(true);
        rpc.getProviderApiKey(editingProvider.id)
          .then(({ apiKey }) => setForm((prev) => ({ ...prev, apiKey })))
          .catch(() => {/* non-fatal — field stays blank */})
          .finally(() => setLoadingKey(false));
      } else {
        setForm(EMPTY_FORM);
        setShowApiKey(false);
        setToolChoiceWarning(null);
      }
    }
  }, [open, isEditing, editingProvider]);

  // Auto-fetch models when provider type or API key changes
  useEffect(() => {
    if (!form.providerType) { setAvailableModels([]); return; }

    // For editing existing providers, use the stored API key via ID-based RPC
    if (isEditing && editingProvider?.id && !form.apiKey.trim()) {
      setLoadingModels(true);
      const timer = setTimeout(async () => {
        try {
          const result = await rpc.listProviderModelsById(editingProvider.id);
          if (result.success && result.models.length > 0) {
            setAvailableModels([...result.models].sort());
          } else {
            setAvailableModels([]);
          }
        } catch { setAvailableModels([]); }
        setLoadingModels(false);
      }, 300);
      return () => clearTimeout(timer);
    }

    // For new providers or when API key is entered
    if (!form.apiKey.trim() && !NO_KEY_PROVIDERS.includes(form.providerType)) { setAvailableModels([]); return; }
    setLoadingModels(true);
    const timer = setTimeout(async () => {
      try {
        const result = await rpc.listProviderModels({
          providerType: form.providerType,
          apiKey: NO_KEY_PROVIDERS.includes(form.providerType) ? "public" : form.apiKey.trim(),
          baseUrl: form.baseUrl.trim() || undefined,
          // Keeps the already-saved default visible in the suggestion list even
          // when the live/fallback fetch doesn't happen to return it (e.g. an
          // Ollama provider while Ollama isn't running).
          defaultModel: isEditing ? defaultModelRef.current.trim() || undefined : undefined,
        });
        if (result.success && result.models.length > 0) {
          setAvailableModels([...result.models].sort());
        } else {
          setAvailableModels([]);
        }
      } catch { setAvailableModels([]); }
      setLoadingModels(false);
    }, 500);
    return () => clearTimeout(timer);
  }, [form.providerType, form.apiKey, form.baseUrl, isEditing, editingProvider?.id]);

  // Check tool_choice support for OpenRouter models
  useEffect(() => {
    if (form.providerType !== "openrouter" || !form.defaultModel.trim()) {
      setToolChoiceWarning(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const result = await rpc.checkModelToolSupport({
          providerType: form.providerType,
          apiKey: form.apiKey.trim() || undefined,
          providerId: isEditing ? editingProvider?.id : undefined,
          modelId: form.defaultModel.trim(),
        });
        setToolChoiceWarning(result.supportsToolChoice ? null : (result.warning ?? null));
      } catch {
        setToolChoiceWarning(null);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [form.providerType, form.defaultModel, form.apiKey, isEditing, editingProvider?.id]);

  function updateField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast("error", "Provider name is required.");
      return;
    }
    if (!form.apiKey.trim() && !isEditing && !NO_KEY_PROVIDERS.includes(form.providerType)) {
      toast("error", "API key is required.");
      return;
    }
    if (!form.defaultModel.trim()) {
      toast("error", "Default model is required.");
      return;
    }
    if (BASE_URL_PROVIDERS.includes(form.providerType) && !form.baseUrl.trim()) {
      toast("error", "Base URL is required for this provider type.");
      return;
    }
    if (form.baseUrl.trim() && !isValidUrl(form.baseUrl.trim())) {
      toast("error", "Base URL must be a valid URL starting with http:// or https://");
      return;
    }

    setSaving(true);
    try {
      // Normalize baseUrl before saving
      const normalizedBaseUrl = form.baseUrl.trim() ? normalizeBaseUrl(form.baseUrl.trim()) : undefined;

      const result = await rpc.saveProvider({
        ...(isEditing ? { id: editingProvider.id } : {}),
        name: form.name.trim(),
        providerType: form.providerType,
        apiKey: NO_KEY_PROVIDERS.includes(form.providerType) && !form.apiKey.trim() ? "public" : form.apiKey,
        baseUrl: normalizedBaseUrl,
        defaultModel: form.defaultModel.trim() || undefined,
        isDefault: form.isDefault,
      });

      if (result.success) {
        toast("success", isEditing ? "Provider updated." : "Provider added.");
        onOpenChange(false);
        onSaved();
      } else {
        toast("error", result.error ?? "Failed to save provider. Please try again.");
      }
    } catch {
      toast("error", "An unexpected error occurred while saving.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestInDialog() {
    setTesting(true);
    try {
      // Always test with what's currently in the form fields.
      // form.apiKey is pre-loaded with the stored key on open, so even for
      // editing without a change the real key is used for the inference call.
      const result = await rpc.testProviderWithCredentials({
        providerType: form.providerType,
        apiKey: NO_KEY_PROVIDERS.includes(form.providerType) ? "public" : form.apiKey.trim(),
        baseUrl: form.baseUrl.trim() || undefined,
        defaultModel: form.defaultModel.trim() || undefined,
      });
      if (result.success) {
        toast("success", "Connection is working.");
      } else {
        toast("error", result.error ? `Connection failed: ${result.error}` : "Connection failed.");
      }
    } catch {
      toast("error", "Connection test failed.");
    } finally {
      setTesting(false);
    }
  }

  function handleCancel() {
    if (!saving) {
      onOpenChange(false);
    }
  }

  const isCustom = BASE_URL_PROVIDERS.includes(form.providerType);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!saving) onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Provider" : "Add Provider"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? `Update configuration for ${editingProvider.name}.`
              : "Configure a new AI provider to use with AgentDesk."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          {/* Name */}
          <div className="grid gap-1.5">
            <Label htmlFor="provider-name">Name</Label>
            <Input
              id="provider-name"
              placeholder="e.g. My Anthropic Account"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              disabled={saving}
              autoComplete="off"
            />
          </div>

          {/* Provider Type */}
          <div className="grid gap-1.5">
            <Label htmlFor="provider-type">Provider Type</Label>
            <select
              id="provider-type"
              value={form.providerType}
              onChange={(e) => {
                const nextType = e.target.value;
                updateField("providerType", nextType);
                // Pre-fill the local Ollama endpoint so the user isn't left
                // guessing the URL — only when they haven't typed one already.
                if (nextType === "ollama" && !form.baseUrl.trim()) {
                  updateField("baseUrl", OLLAMA_DEFAULT_BASE_URL);
                }
              }}
              disabled={saving}
              className={cn(
                "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1",
                "text-sm shadow-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50"
              )}
            >
              {providerTypeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* API Key */}
          {NO_KEY_PROVIDERS.includes(form.providerType) ? (
            <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              {form.providerType === "claude-subscription"
                ? "No API key needed — uses Claude Code's stored OAuth credentials automatically."
                : form.providerType === "ollama"
                  ? "No API key needed — Ollama runs locally."
                  : "No API key needed — free models are available out of the box. Optionally add your own OpenCode key to unlock paid models."}
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="provider-api-key">
                API Key
                {loadingKey && (
                  <span className="ml-1 text-xs text-muted-foreground font-normal">loading...</span>
                )}
              </Label>
              <div className="relative">
                <Input
                  id="provider-api-key"
                  type={showApiKey ? "text" : "password"}
                  placeholder={isEditing && !loadingKey ? "Enter new key to replace" : "sk-..."}
                  value={form.apiKey}
                  onChange={(e) => updateField("apiKey", e.target.value)}
                  disabled={saving || loadingKey}
                  autoComplete="off"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  disabled={loadingKey}
                  className={cn(
                    "absolute inset-y-0 right-0 flex items-center px-3",
                    "text-muted-foreground hover:text-foreground transition-colors",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-r-md"
                  )}
                  aria-label={showApiKey ? "Hide API key" : "Show API key"}
                >
                  {showApiKey ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Base URL — shown only for custom provider type */}
          {isCustom && (
            <div className="grid gap-1.5">
              <Label htmlFor="provider-base-url">Base URL</Label>
              <Input
                id="provider-base-url"
                type="url"
                placeholder="https://your-endpoint.example.com/v1/chat/completions"
                value={form.baseUrl}
                onChange={(e) => updateField("baseUrl", e.target.value)}
                disabled={saving}
                autoComplete="off"
                aria-invalid={form.baseUrl.trim().length > 0 && !isValidUrl(form.baseUrl.trim())}
                className={cn(
                  form.baseUrl.trim().length > 0 && !isValidUrl(form.baseUrl.trim()) &&
                  "border-destructive focus-visible:ring-destructive"
                )}
              />
              {form.baseUrl.trim().length > 0 && !isValidUrl(form.baseUrl.trim()) && (
                <p className="text-xs text-destructive">Must be a valid URL starting with http:// or https://</p>
              )}
            </div>
          )}

          {/* Default Model */}
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="provider-default-model">
                Default Model
                {loadingModels && <span className="ml-2 text-xs text-muted-foreground font-normal">loading...</span>}
              </Label>
              <button
                type="button"
                onClick={() => setFindWorkingOpen(true)}
                disabled={
                  saving ||
                  loadingModels ||
                  availableModels.length === 0 ||
                  (!NO_KEY_PROVIDERS.includes(form.providerType) && !form.apiKey.trim())
                }
                className="text-xs font-medium text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:no-underline"
              >
                Find Working
              </button>
            </div>
            <ModelInput
              id="provider-default-model"
              placeholder={loadingModels ? "Loading models..." : "Type or select a model..."}
              value={form.defaultModel}
              onChange={(v) => updateField("defaultModel", v)}
              suggestions={availableModels}
              disabled={saving}
            />
            {toolChoiceWarning && (
              <p className="text-xs text-destructive">{toolChoiceWarning}</p>
            )}
          </div>

          {/* Set as Default */}
          <div className="flex items-center gap-2">
            <input
              id="provider-is-default"
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => updateField("isDefault", e.target.checked)}
              disabled={saving}
              className={cn(
                "h-4 w-4 rounded border-input text-primary cursor-pointer",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50"
              )}
            />
            <Label
              htmlFor="provider-is-default"
              className="cursor-pointer select-none"
            >
              Set as default provider
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={saving || testing}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={handleTestInDialog}
            disabled={saving || testing || (!form.apiKey.trim() && !isEditing && !NO_KEY_PROVIDERS.includes(form.providerType))}
            className="border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100 hover:text-amber-900 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60"
          >
            {testing ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                Testing...
              </>
            ) : (
              "Test Connection"
            )}
          </Button>
          <Button onClick={handleSave} disabled={saving || testing}>
            {saving ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                Saving...
              </>
            ) : isEditing ? (
              "Save Changes"
            ) : (
              "Add Provider"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>

      <FindWorkingModelsDialog
        open={findWorkingOpen}
        onOpenChange={setFindWorkingOpen}
        models={availableModels}
        providerType={form.providerType}
        apiKey={form.apiKey}
        baseUrl={form.baseUrl}
        providerId={editingProvider?.id}
        onSelect={(model) => updateField("defaultModel", model)}
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main exported component
// ---------------------------------------------------------------------------

export function ProvidersSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Which provider is currently being tested
  const [testingId, setTestingId] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  async function loadProviders() {
    try {
      const result = await rpc.getProviders();
      setProviders(result as Provider[]);
    } catch {
      toast("error", "Failed to load providers.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProviders();
  }, []);

  // Keep the list/count truthful when providers change elsewhere
  // (another window, the onboarding flow, the freelance wizard, …).
  useEffect(() => {
    function onProvidersChanged() {
      loadProviders();
    }
    window.addEventListener("agentdesk:providers-changed", onProvidersChanged);
    return () =>
      window.removeEventListener("agentdesk:providers-changed", onProvidersChanged);
  }, []);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  function handleAdd() {
    setEditingProvider(null);
    setDialogOpen(true);
  }

  function handleEdit(provider: Provider) {
    setEditingProvider(provider);
    setDialogOpen(true);
  }

  function handleDeleteRequest(provider: Provider) {
    setDeleteTarget(provider);
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await rpc.deleteProvider(deleteTarget.id);
      if (result.success) {
        toast("success", `"${deleteTarget.name}" deleted.`);
        setDeleteTarget(null);
        await loadProviders();
      } else {
        toast("error", "Failed to delete provider.");
      }
    } catch {
      toast("error", "An unexpected error occurred while deleting.");
    } finally {
      setDeleting(false);
    }
  }

  async function handleTest(provider: Provider) {
    setTestingId(provider.id);
    try {
      await new Promise<void>((resolve) => {
        function onResult(e: Event) {
          const { id, success, error } = (
            e as CustomEvent<{ id: string; success: boolean; error?: string }>
          ).detail;
          if (id !== provider.id) return;
          window.removeEventListener("agentdesk:provider-test-result", onResult);
          if (success) {
            toast("success", `Connection to "${provider.name}" is working.`);
          } else {
            toast(
              "error",
              error
                ? `Connection failed: ${error}`
                : `Could not connect to "${provider.name}".`
            );
          }
          resolve();
        }
        window.addEventListener("agentdesk:provider-test-result", onResult);
        rpc.testProvider(provider.id).catch(() => {
          window.removeEventListener("agentdesk:provider-test-result", onResult);
          toast("error", "Failed to start connection test.");
          resolve();
        });
      });
      // Refresh to reflect the updated isValid on the provider
      await loadProviders();
    } finally {
      setTestingId(null);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">AI Providers</h2>
            {!loading && providers.length > 0 && (
              <Badge variant="secondary" className="pointer-events-none">
                {providers.length}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage the AI providers AgentDesk uses to run agents.
          </p>
        </div>

        {!loading && providers.length > 0 && (
          <Button onClick={handleAdd} size="sm">
            <Plus aria-hidden="true" />
            Add Provider
          </Button>
        )}
      </div>

      <Separator className="mb-6" />

      {/* Main content */}
      {loading ? (
        <div
          className="grid gap-4"
          aria-busy="true"
          aria-label="Loading providers"
        >
          <ProviderCardSkeleton />
          <ProviderCardSkeleton />
        </div>
      ) : providers.length === 0 ? (
        <EmptyProviders onAdd={handleAdd} />
      ) : (
        <div className="grid gap-4" role="list" aria-label="AI providers">
          {providers.map((provider) => (
            <div key={provider.id} role="listitem">
              <ProviderCard
                provider={provider}
                testingId={testingId}
                onEdit={handleEdit}
                onDelete={handleDeleteRequest}
                onTest={handleTest}
              />
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit dialog */}
      <ProviderDialog
        open={dialogOpen}
        editingProvider={editingProvider}
        onOpenChange={setDialogOpen}
        onSaved={loadProviders}
      />

      {/* Delete confirmation */}
      <ConfirmationDialog
        open={deleteTarget !== null && !deleting}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
        title="Delete Provider"
        description={
          deleteTarget
            ? `Are you sure you want to delete "${deleteTarget.name}"? This action cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
