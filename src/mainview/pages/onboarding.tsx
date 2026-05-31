import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Zap,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Loader2,
  Bot,
  Sparkles,
  Globe,
  ChevronRight,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ModelInput } from "@/components/ui/model-input";
import { toast } from "@/components/ui/toast";
import { rpc } from "@/lib/rpc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProviderType = "anthropic" | "openai" | "google" | "deepseek" | "groq" | "xai" | "ollama" | "openrouter" | "zai" | "opencode" | "custom";
type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

interface FormData {
  userName: string;
  userEmail: string;
  workspacePath: string;
  provider: ProviderType | null;
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface ValidationState {
  status: "idle" | "loading" | "success" | "error";
  error?: string;
  savedId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 6;

const PROVIDERS: {
  id: ProviderType;
  label: string;
  description: string;
  Icon: React.ElementType;
}[] = [
  { id: "opencode", label: "Free", description: "No API key needed — free models via OpenCode", Icon: Zap },
  { id: "anthropic", label: "Anthropic", description: "Claude models — fast, capable, safety-focused", Icon: Sparkles },
  { id: "deepseek", label: "DeepSeek", description: "DeepSeek V3/R1 — strong coding, very affordable", Icon: Bot },
  { id: "google", label: "Google Gemini", description: "Gemini models — large context, multimodal", Icon: Sparkles },
  { id: "groq", label: "Groq", description: "Ultra-fast inference — Llama, Mixtral, Gemma", Icon: Sparkles },
  { id: "ollama", label: "Ollama", description: "Local models via Ollama (Llama, Mistral, etc.)", Icon: Globe },
  { id: "openai", label: "OpenAI", description: "GPT models — broad capability, wide ecosystem", Icon: Bot },
  { id: "openrouter", label: "OpenRouter", description: "Access 200+ models through one API", Icon: Globe },
  { id: "xai", label: "xAI Grok", description: "Grok models — competitive coding performance", Icon: Bot },
  { id: "zai", label: "Z.AI", description: "GLM models from Zhipu AI via Z.AI", Icon: Bot },
  { id: "custom", label: "Custom", description: "Any other OpenAI-compatible endpoint", Icon: Globe },
];


// Provider types that require a base URL and free-text model entry
const FREE_TEXT_PROVIDERS: ProviderType[] = ["ollama", "custom"];

// Provider types that do not require an API key from the user
const NO_KEY_PROVIDERS: ProviderType[] = ["opencode"];

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

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


const STEP_LABELS: Record<WizardStep, string> = {
  1: "Welcome",
  2: "About You",
  3: "Provider",
  4: "Configure",
  5: "Validate",
  6: "Done",
};

// ---------------------------------------------------------------------------
// Progress indicator
// ---------------------------------------------------------------------------

function StepIndicator({
  currentStep,
}: {
  currentStep: WizardStep;
}) {
  return (
    <nav aria-label="Onboarding progress" className="flex items-center gap-2">
      {(Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1) as WizardStep[]).map(
        (step) => {
          const isCompleted = step < currentStep;
          const isCurrent = step === currentStep;
          return (
            <div key={step} className="flex items-center gap-2">
              <div
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors",
                  isCompleted &&
                    "bg-primary text-primary-foreground",
                  isCurrent &&
                    "ring-2 ring-primary ring-offset-2 bg-primary text-primary-foreground",
                  !isCompleted &&
                    !isCurrent &&
                    "bg-muted text-muted-foreground",
                )}
              >
                {isCompleted ? (
                  <CheckCircle className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <span aria-hidden="true">{step}</span>
                )}
                <span className="sr-only">
                  {STEP_LABELS[step]}{" "}
                  {isCompleted
                    ? "(completed)"
                    : isCurrent
                      ? "(current)"
                      : ""}
                </span>
              </div>
              {step < TOTAL_STEPS && (
                <div
                  aria-hidden="true"
                  className={cn(
                    "h-px w-4 transition-colors",
                    step < currentStep ? "bg-primary" : "bg-muted",
                  )}
                />
              )}
            </div>
          );
        },
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Welcome
// ---------------------------------------------------------------------------

function StepWelcome({
  onNext,
  onImportSettings,
}: {
  onNext: () => void;
  onImportSettings: (bundleJson: string) => void;
}) {
  const [importing, setImporting] = useState(false);

  function handleImportClick() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      try {
        const text = await file.text();
        onImportSettings(text);
      } catch {
        toast("error", "Failed to read settings file.");
      } finally {
        setImporting(false);
      }
    };
    input.click();
  }

  return (
    <div className="flex flex-col items-center gap-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
        <Zap className="h-8 w-8" aria-hidden="true" />
      </div>
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Welcome to AgentDesk</h1>
        <p className="max-w-sm text-muted-foreground">
          Your AI-powered development workspace. Let's get you set up in just a
          few steps.
        </p>
      </div>
      <ul className="flex flex-col gap-3 text-left text-sm text-muted-foreground">
        {[
          "Connect an AI provider in seconds",
          "Manage projects, agents, and docs in one place",
          "Works with Anthropic, OpenAI, and custom endpoints",
        ].map((item) => (
          <li key={item} className="flex items-center gap-2">
            <CheckCircle
              className="h-4 w-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            {item}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-3 w-full max-w-xs">
        <Button size="lg" className="w-full" onClick={onNext}>
          Get Started
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="w-full"
          onClick={handleImportClick}
          disabled={importing}
        >
          {importing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Import Settings
        </Button>
        <p className="text-xs text-muted-foreground">
          Already have AgentDesk on another machine? Import your settings file to restore providers, channels, and preferences.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: About You
// ---------------------------------------------------------------------------

function StepAboutYou({
  userName,
  userEmail,
  workspacePath,
  onChangeName,
  onChangeEmail,
  onChangeWorkspace,
  onNext,
  onBack,
}: {
  userName: string;
  userEmail: string;
  workspacePath: string;
  onChangeName: (v: string) => void;
  onChangeEmail: (v: string) => void;
  onChangeWorkspace: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const emailInvalid = userEmail.trim().length > 0 && !isValidEmail(userEmail.trim());
  const canProceed = userName.trim().length > 0 && !emailInvalid;

  function handleBrowseWorkspace() {
    function onResult(e: Event) {
      const { path } = (e as CustomEvent<{ path: string | null }>).detail;
      window.removeEventListener("agentdesk:directory-selected", onResult);
      if (path) onChangeWorkspace(path);
    }
    window.addEventListener("agentdesk:directory-selected", onResult);
    rpc.selectDirectory().catch(() => {
      window.removeEventListener("agentdesk:directory-selected", onResult);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold">Tell us about yourself</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your name helps agents address you personally. Set a workspace folder
          where all project files will live.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="user-name">Name</Label>
          <Input
            id="user-name"
            placeholder="e.g. Jane Smith"
            value={userName}
            onChange={(e) => onChangeName(e.target.value)}
            autoComplete="name"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="user-email">Email (optional)</Label>
          <Input
            id="user-email"
            type="email"
            placeholder="e.g. jane@example.com"
            value={userEmail}
            onChange={(e) => onChangeEmail(e.target.value)}
            autoComplete="email"
            aria-invalid={emailInvalid}
            className={cn(emailInvalid && "border-destructive focus-visible:ring-destructive")}
          />
          {emailInvalid ? (
            <p className="text-xs text-destructive">Please enter a valid email address.</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Used for email communications from agents. You can add this later in Settings.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="workspace-path">Global Workspace Path</Label>
          <div className="flex gap-2">
            <Input
              id="workspace-path"
              placeholder="/home/user/projects"
              value={workspacePath}
              onChange={(e) => onChangeWorkspace(e.target.value)}
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={handleBrowseWorkspace}
            >
              Browse
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Root folder where all project workspaces are created. Each project gets a subfolder. You can change this later in Settings.
          </p>
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <Button variant="outline" onClick={onBack} className="flex-1">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </Button>
        <Button className="flex-1" disabled={!canProceed} onClick={onNext}>
          Next
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Select Provider
// ---------------------------------------------------------------------------

function StepSelectProvider({
  selected,
  onSelect,
  onNext,
  onBack,
}: {
  selected: ProviderType | null;
  onSelect: (p: ProviderType) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold">Choose your AI provider</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select the AI service you'd like to use with AgentDesk.
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label="AI provider"
        className="flex flex-col gap-3"
      >
        {PROVIDERS.map(({ id, label, description, Icon }) => {
          const isSelected = selected === id;
          return (
            <button
              key={id}
              role="radio"
              aria-checked={isSelected}
              onClick={() => onSelect(id)}
              className={cn(
                "flex items-center gap-4 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                isSelected
                  ? "border-primary bg-primary/5"
                  : "border-input hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <div
                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                  isSelected
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{label}</div>
                <div className="text-sm text-muted-foreground truncate">
                  {description}
                </div>
              </div>
              <div
                aria-hidden="true"
                className={cn(
                  "h-4 w-4 shrink-0 rounded-full border-2 transition-colors",
                  isSelected
                    ? "border-primary bg-primary"
                    : "border-muted-foreground",
                )}
              />
            </button>
          );
        })}
      </div>
      <div className="flex gap-3 pt-2">
        <Button variant="outline" onClick={onBack} className="flex-1">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </Button>
        <Button
          className="flex-1"
          disabled={selected === null}
          onClick={onNext}
        >
          Next
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Configure (API Key + Model combined)
// ---------------------------------------------------------------------------

function StepConfigure({
  provider,
  apiKey,
  baseUrl,
  model,
  onChangeApiKey,
  onChangeBaseUrl,
  onChangeModel,
  onNext,
  onBack,
}: {
  provider: ProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
  onChangeApiKey: (v: string) => void;
  onChangeBaseUrl: (v: string) => void;
  onChangeModel: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsFetched, setModelsFetched] = useState(false);
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);

  const isCustom = FREE_TEXT_PROVIDERS.includes(provider);
  const isNoKey = NO_KEY_PROVIDERS.includes(provider);
  const urlInvalid = isCustom && baseUrl.trim().length > 0 && !isValidUrl(baseUrl.trim());
  const hasCredentials = isNoKey
    ? (!isCustom || baseUrl.trim().length > 0) && !urlInvalid
    : apiKey.trim().length > 0 && (!isCustom || baseUrl.trim().length > 0) && !urlInvalid;

  const providerLabel =
    PROVIDERS.find((p) => p.id === provider)?.label ?? provider;

  // Fetch models when credentials are entered
  useEffect(() => {
    if (!hasCredentials || modelsFetched) return;

    const fetchModels = async () => {
      setLoadingModels(true);
      setModelLoadError(null);
      try {
        const result = await rpc.listProviderModels({
          providerType: provider === "opencode" ? "opencode" : (provider === "ollama" || provider === "custom" ? "openai" : provider),
          apiKey: isNoKey ? "public" : apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
        });
        if (result.success && result.models.length > 0) {
          setAvailableModels([...result.models].sort());
          // Auto-select first model if none selected
          if (!model.trim()) {
            onChangeModel(result.models[0]);
          }
        } else {
          setAvailableModels([]);
          if (!result.success) {
            setModelLoadError((result as { error?: string }).error ?? "Could not load models.");
          } else {
            setModelLoadError("No models returned. Check your connection and retry.");
          }
        }
      } catch (err) {
        setAvailableModels([]);
        setModelLoadError(err instanceof Error ? err.message : "Failed to load models.");
      }
      setLoadingModels(false);
      setModelsFetched(true);
    };

    // Debounce - wait a bit after user stops typing
    const timer = setTimeout(fetchModels, 500);
    return () => clearTimeout(timer);
  }, [hasCredentials, apiKey, baseUrl, provider, modelsFetched, model, onChangeModel, isNoKey]);

  // Reset models when provider changes
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setAvailableModels([]);
    setModelsFetched(false);
    setModelLoadError(null);
  }, [provider]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const canProceed = hasCredentials && model.trim().length > 0;
  const showModelSelector = hasCredentials;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold">Configure {providerLabel}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your credentials are stored locally and never sent to our servers.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {/* API Key */}
        {isNoKey ? (
          <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            No API key needed — free models load automatically below.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key">API Key</Label>
            <div className="relative">
              <Input
                id="api-key"
                type={showKey ? "text" : "password"}
                placeholder={
                  provider === "anthropic"
                    ? "sk-ant-…"
                    : provider === "openai"
                      ? "sk-…"
                      : "Your API key"
                }
                value={apiKey}
                onChange={(e) => {
                  onChangeApiKey(e.target.value);
                  setModelsFetched(false);
                }}
                className="pr-10"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                aria-label={showKey ? "Hide API key" : "Show API key"}
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showKey ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        )}

        {/* Base URL (for custom/ollama) */}
        {isCustom && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="base-url">Base URL</Label>
            <Input
              id="base-url"
              type="url"
              placeholder="https://your-endpoint.example.com/v1"
              value={baseUrl}
              onChange={(e) => {
                onChangeBaseUrl(e.target.value);
                setModelsFetched(false);
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={urlInvalid}
              className={cn(urlInvalid && "border-destructive focus-visible:ring-destructive")}
            />
            {urlInvalid ? (
              <p className="text-xs text-destructive">Please enter a valid URL starting with http:// or https://</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Base URL for the API endpoint, e.g. <code className="font-mono">https://api.example.com/v1</code>
              </p>
            )}
          </div>
        )}

        {/* Model Selector */}
        {showModelSelector && (
          <div className="flex flex-col gap-1.5">
            <Label>
              Model
              {loadingModels && <Loader2 className="ml-2 h-3 w-3 inline animate-spin" aria-hidden="true" />}
            </Label>
            <div className="flex gap-2">
              <ModelInput
                placeholder={loadingModels ? "Loading models..." : "Type or select a model..."}
                value={model}
                onChange={onChangeModel}
                suggestions={availableModels}
                className="flex-1"
              />
              {modelLoadError && !loadingModels && (
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  onClick={() => setModelsFetched(false)}
                  title="Retry loading models"
                >
                  Retry
                </Button>
              )}
            </div>
            {modelLoadError && !loadingModels ? (
              <p className="text-xs text-destructive">{modelLoadError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Default model for new conversations.
              </p>
            )}
          </div>
        )}
      </div>
      <div className="flex gap-3 pt-2">
        <Button variant="outline" onClick={onBack} className="flex-1">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </Button>
        <Button className="flex-1" disabled={!canProceed} onClick={onNext}>
          Next
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5: Validate
// ---------------------------------------------------------------------------

function StepValidate({
  provider,
  validation,
  onRetry,
}: {
  provider: ProviderType;
  apiKey: string;
  baseUrl: string;
  validation: ValidationState;
  onRetry: () => void;
  onNext: () => void;
}) {
  const providerLabel =
    PROVIDERS.find((p) => p.id === provider)?.label ?? provider;

  return (
    <div className="flex flex-col items-center gap-8 text-center">
      <div>
        <h2 className="text-xl font-semibold">Validating your credentials</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Testing connection to {providerLabel}…
        </p>
      </div>

      <div
        aria-live="polite"
        aria-atomic="true"
        className="flex flex-col items-center gap-4"
      >
        {validation.status === "loading" && (
          <>
            <Loader2
              className="h-12 w-12 animate-spin text-primary"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              Saving provider and running test request…
            </p>
          </>
        )}
        {validation.status === "success" && (
          <>
            <CheckCircle
              className="h-12 w-12 text-green-500"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium text-green-700">Connection successful!</p>
              <p className="text-sm text-muted-foreground">
                Advancing to the next step…
              </p>
            </div>
          </>
        )}
        {validation.status === "error" && (
          <>
            <XCircle
              className="h-12 w-12 text-destructive"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <p className="font-medium text-destructive">Validation failed</p>
              {validation.error && (
                <p className="text-sm text-muted-foreground">
                  {validation.error}
                </p>
              )}
            </div>
            <Button variant="outline" onClick={onRetry}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Try Again
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 6: Confirmation
// ---------------------------------------------------------------------------

function StepConfirmation({
  formData,
  onFinish,
}: {
  formData: FormData;
  onFinish: () => void;
}) {
  const providerLabel =
    PROVIDERS.find((p) => p.id === formData.provider)?.label ??
    formData.provider;

  // Normalize baseUrl for display
  const displayBaseUrl = formData.baseUrl ? normalizeBaseUrl(formData.baseUrl) : "";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-green-100 text-green-600">
          <CheckCircle className="h-7 w-7" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-xl font-semibold">You're all set!</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Here's a summary of what was configured.
          </p>
        </div>
      </div>

      <dl className="rounded-lg border divide-y text-sm">
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="font-medium text-muted-foreground">Name</dt>
          <dd className="font-medium">{formData.userName || "—"}</dd>
        </div>
        {formData.userEmail && (
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="font-medium text-muted-foreground">Email</dt>
            <dd className="truncate max-w-[200px]">{formData.userEmail}</dd>
          </div>
        )}
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="font-medium text-muted-foreground">Provider</dt>
          <dd className="font-medium">{providerLabel}</dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="font-medium text-muted-foreground">API Key</dt>
          <dd className="font-mono">
            {formData.provider === "opencode"
              ? "No key required"
              : `${"•".repeat(8)}${formData.apiKey.slice(-4)}`}
          </dd>
        </div>
        {displayBaseUrl && (
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="font-medium text-muted-foreground">Base URL</dt>
            <dd className="truncate max-w-[180px]">{displayBaseUrl}</dd>
          </div>
        )}
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="font-medium text-muted-foreground">Default Model</dt>
          <dd className="font-mono text-xs">{formData.model}</dd>
        </div>
      </dl>

      <Button size="lg" className="w-full" onClick={onFinish}>
        Go to Dashboard
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main wizard component
// ---------------------------------------------------------------------------

export function OnboardingPage() {
  const navigate = useNavigate();

  const [step, setStep] = useState<WizardStep>(1);
  const [formData, setFormData] = useState<FormData>({
    userName: "",
    userEmail: "",
    workspacePath: "",
    provider: null,
    apiKey: "",
    baseUrl: "",
    model: "",
  });
  const [validation, setValidation] = useState<ValidationState>({
    status: "idle",
  });
  // Stores the raw settings bundle JSON when imported on step 1
  const [pendingSettingsBundle, setPendingSettingsBundle] = useState<string | null>(null);

  // ---- helpers ----

  const goNext = () =>
    setStep((s) => Math.min(s + 1, TOTAL_STEPS) as WizardStep);
  const goBack = () =>
    setStep((s) => Math.max(s - 1, 1) as WizardStep);

  const updateForm = <K extends keyof FormData>(key: K, value: FormData[K]) =>
    setFormData((prev) => ({ ...prev, [key]: value }));

  // ---- Step 2→3 transition: persist user name/email ----

  useEffect(() => {
    if (step !== 3) return;
    // Fire-and-forget save of name/email settings
    if (formData.userName.trim()) {
      rpc.saveSetting("user_name", formData.userName.trim(), "user").catch(() => {});
    }
    if (formData.userEmail.trim()) {
      rpc.saveSetting("user_email", formData.userEmail.trim(), "user").catch(() => {});
    }
    if (formData.workspacePath.trim()) {
      rpc.saveSetting("global_workspace_path", formData.workspacePath.trim(), "general").catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ---- Step 5: auto-validate on mount ----

  useEffect(() => {
    if (step !== 5) return;

    let cancelled = false;

    async function validate() {
      setValidation({ status: "loading" });

      try {
        // Normalize baseUrl before saving
        const normalizedBaseUrl = formData.baseUrl ? normalizeBaseUrl(formData.baseUrl) : undefined;

        const saveResult = await rpc.saveProvider({
          name: PROVIDERS.find((p) => p.id === formData.provider)?.label ?? "Provider",
          providerType: formData.provider ?? "",
          apiKey: formData.provider === "opencode" ? "public" : formData.apiKey,
          baseUrl: normalizedBaseUrl,
          defaultModel: formData.model || undefined,
          isDefault: true,
        });

        if (cancelled) return;

        if (!saveResult.success) {
          // For opencode, a duplicate means it was pre-seeded — treat as success
          const isOpencodeAlreadyExists =
            formData.provider === "opencode" && (saveResult as { id?: string }).id;
          if (!isOpencodeAlreadyExists) {
            setValidation({
              status: "error",
              error:
                (saveResult as { error?: string }).error ??
                "Failed to save provider. Please check your details.",
            });
            return;
          }
          // Fall through using the existing provider id
        }

        const testResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
          function onResult(e: Event) {
            const detail = (
              e as CustomEvent<{ id: string; success: boolean; error?: string }>
            ).detail;
            if (detail.id !== saveResult.id) return;
            window.removeEventListener("agentdesk:provider-test-result", onResult);
            resolve({ success: detail.success, error: detail.error });
          }
          window.addEventListener("agentdesk:provider-test-result", onResult);
          rpc.testProvider(saveResult.id).catch(() => {
            window.removeEventListener("agentdesk:provider-test-result", onResult);
            resolve({ success: false, error: "Failed to initiate connection test." });
          });
        });

        if (cancelled) return;

        if (testResult.success) {
          setValidation({ status: "success", savedId: saveResult.id });
          toast("success", "Provider connected successfully.");
          setTimeout(() => {
            if (!cancelled) goNext();
          }, 1500);
        } else {
          setValidation({
            status: "error",
            savedId: saveResult.id, // Keep savedId so retry can delete it
            error: testResult.error ?? "Connection failed. Please check your credentials and try again.",
          });
        }
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "An unexpected error occurred.";
        setValidation({ status: "error", error: message });
      }
    }

    validate();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ---- import settings from step 1 ----

  function handleImportSettings(bundleJson: string) {
    let bundle: {
      type?: string;
      aiProviders?: Array<{
        name: string; providerType: string; apiKey: string;
        baseUrl: string | null; defaultModel: string | null; isDefault: boolean;
      }>;
      settings?: Array<{ key: string; value: string; category: string }>;
    };
    try {
      bundle = JSON.parse(bundleJson);
    } catch {
      toast("error", "Invalid settings file — not valid JSON.");
      return;
    }
    if (bundle.type !== "agentdesk-settings") {
      toast("error", "Not a valid AgentDesk settings export file.");
      return;
    }

    // Extract default provider (or first provider) to pre-fill the wizard
    const defaultProvider = bundle.aiProviders?.find((p) => p.isDefault) ?? bundle.aiProviders?.[0];

    // Settings values are stored as JSON-encoded strings in the DB (e.g. "\"Sarfraz\"").
    // Parse each value so we get the actual string, not the JSON-wrapped form.
    function parseSetting(raw: string | undefined): string {
      if (raw === undefined) return "";
      try { return JSON.parse(raw); } catch { return raw; }
    }

    const settingsMap = Object.fromEntries(
      (bundle.settings ?? []).map((s) => [s.key, s.value])
    );

    setFormData((prev) => ({
      ...prev,
      userName: parseSetting(settingsMap["user_name"]) || prev.userName,
      userEmail: parseSetting(settingsMap["user_email"]) || prev.userEmail,
      workspacePath: parseSetting(settingsMap["global_workspace_path"]) || prev.workspacePath,
      provider: (defaultProvider?.providerType as ProviderType | undefined) ?? prev.provider,
      apiKey: defaultProvider?.apiKey ?? prev.apiKey,
      baseUrl: defaultProvider?.baseUrl ?? prev.baseUrl,
      model: defaultProvider?.defaultModel ?? prev.model,
    }));

    setPendingSettingsBundle(bundleJson);

    if (defaultProvider) {
      // Jump straight to step 5 (Validate) to test the provider
      setStep(5);
    } else {
      // No provider in bundle — skip to About You with pre-filled user info
      setStep(2);
    }
  }

  // ---- navigation handlers ----

  function handleProviderSelect(p: ProviderType) {
    updateForm("provider", p);
    // Reset model when provider changes
    updateForm("model", "");
  }

  async function handleRetry() {
    // Delete the previously saved provider if validation failed
    if (validation.savedId) {
      try {
        await rpc.deleteProvider(validation.savedId);
      } catch {
        // Ignore errors - provider might not exist
      }
    }
    setValidation({ status: "idle" });

    if (pendingSettingsBundle) {
      // Came from an import flow — clear the bundle so the user goes through
      // manual setup. Send them to step 3 (provider selection) so they can
      // pick a different provider or re-enter credentials from scratch.
      setPendingSettingsBundle(null);
      setStep(3);
    } else {
      setStep(4); // Normal flow — go back to Configure step
    }
  }

  async function handleFinish() {
    // If we came from an import settings flow, restore the full bundle now.
    // This replaces providers (including the one just validated), channels, prefs, and settings.
    if (pendingSettingsBundle) {
      try {
        await rpc.importSettings(pendingSettingsBundle);
      } catch {
        // Non-fatal — best-effort restore
      }
    } else if (validation.savedId && formData.model) {
      // Persist the selected model to the provider saved during validation
      try {
        const normalizedBaseUrl = formData.baseUrl ? normalizeBaseUrl(formData.baseUrl) : undefined;

        await rpc.saveProvider({
          id: validation.savedId,
          name: PROVIDERS.find((p) => p.id === formData.provider)?.label ?? "Provider",
          providerType: formData.provider ?? "",
          apiKey: "",           // blank = keep existing key
          baseUrl: normalizedBaseUrl,
          defaultModel: formData.model,
          isDefault: true,
        });
      } catch {
        // Non-fatal — navigate anyway
      }
    }
    // Create the first_launch file so isFirstLaunch returns false from now on
    rpc.markOnboardingComplete().catch(() => {});
    // Ensure workspace projects are registered before the dashboard loads
    try {
      await rpc.syncWorkspaceFolders();
    } catch {
      // Non-fatal — projects will sync on next restart
    }
    navigate({ to: "/" });
  }

  // ---- render ----

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="flex flex-col items-center gap-4 pb-2">
          <StepIndicator currentStep={step} />
          <p className="text-xs text-muted-foreground">
            Step {step} of {TOTAL_STEPS} — {STEP_LABELS[step]}
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {step === 1 && <StepWelcome onNext={goNext} onImportSettings={handleImportSettings} />}

          {step === 2 && (
            <StepAboutYou
              userName={formData.userName}
              userEmail={formData.userEmail}
              workspacePath={formData.workspacePath}
              onChangeName={(v) => updateForm("userName", v)}
              onChangeEmail={(v) => updateForm("userEmail", v)}
              onChangeWorkspace={(v) => updateForm("workspacePath", v)}
              onNext={goNext}
              onBack={goBack}
            />
          )}

          {step === 3 && (
            <StepSelectProvider
              selected={formData.provider}
              onSelect={handleProviderSelect}
              onNext={goNext}
              onBack={goBack}
            />
          )}

          {step === 4 && formData.provider && (
            <StepConfigure
              provider={formData.provider}
              apiKey={formData.apiKey}
              baseUrl={formData.baseUrl}
              model={formData.model}
              onChangeApiKey={(v) => updateForm("apiKey", v)}
              onChangeBaseUrl={(v) => updateForm("baseUrl", v)}
              onChangeModel={(v) => updateForm("model", v)}
              onNext={goNext}
              onBack={goBack}
            />
          )}

          {step === 5 && formData.provider && (
            <StepValidate
              provider={formData.provider}
              apiKey={formData.apiKey}
              baseUrl={formData.baseUrl}
              validation={validation}
              onRetry={handleRetry}
              onNext={goNext}
            />
          )}

          {step === 6 && <StepConfirmation formData={formData} onFinish={handleFinish} />}
        </CardContent>
      </Card>
    </div>
  );
}
