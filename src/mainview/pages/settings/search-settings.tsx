import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff, Search } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type KeyStatus = "not-configured" | "saved";

function StatusDot({ status }: { status: KeyStatus }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          status === "saved" ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600",
        )}
        aria-hidden="true"
      />
      <span className={cn("text-sm", status === "saved" ? "text-green-700" : "text-muted-foreground")}>
        {status === "saved" ? "API key saved" : "Not configured"}
      </span>
    </div>
  );
}

interface ProviderCardProps {
  settingKey: string;
  title: string;
  description: React.ReactNode;
  placeholder: string;
  hint: React.ReactNode;
  status: KeyStatus;
  apiKey: string;
  showKey: boolean;
  isSaving: boolean;
  onChange: (value: string) => void;
  onToggleShow: () => void;
  onSave: () => void;
  onClear: () => void;
}

function ProviderCard({
  settingKey,
  title,
  description,
  placeholder,
  hint,
  status,
  apiKey,
  showKey,
  isSaving,
  onChange,
  onToggleShow,
  onSave,
  onClear,
}: ProviderCardProps) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Search className="h-5 w-5 text-foreground" aria-hidden="true" />
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          <StatusDot status={status} />
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={settingKey}>{title} API Key</Label>
          <div className="relative">
            <Input
              id={settingKey}
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              className="pr-10 font-mono text-sm"
            />
            <button
              type="button"
              onClick={onToggleShow}
              aria-label={showKey ? "Hide API key" : "Show API key"}
              className={cn(
                "absolute inset-y-0 right-0 flex items-center px-3",
                "text-muted-foreground transition-colors hover:text-foreground",
                "rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              )}
            >
              {showKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="button" onClick={onSave} disabled={!apiKey.trim() || isSaving}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
          {status === "saved" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClear}
              disabled={isSaving}
              className="text-destructive hover:text-destructive"
            >
              Remove key
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function useProviderKey(settingKey: string) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<KeyStatus>("not-configured");
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback((settings: Record<string, unknown>) => {
    const saved = settings[settingKey];
    if (typeof saved === "string" && saved.length > 0) {
      setApiKey(saved);
      setStatus("saved");
    }
  }, [settingKey]);

  const handleChange = useCallback((value: string) => {
    setApiKey(value);
    setStatus("not-configured");
  }, []);

  const handleSave = useCallback(async (label: string) => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      toast("warning", `Enter a ${label} API key before saving.`);
      return;
    }
    setIsSaving(true);
    try {
      await rpc.saveSetting(settingKey, trimmed, "integrations");
      setStatus("saved");
      toast("success", `${label} API key saved.`);
    } catch {
      toast("error", `Failed to save ${label} API key. Please try again.`);
    } finally {
      setIsSaving(false);
    }
  }, [apiKey, settingKey]);

  const handleClear = useCallback(async (label: string) => {
    setIsSaving(true);
    try {
      await rpc.saveSetting(settingKey, "", "integrations");
      setApiKey("");
      setStatus("not-configured");
      toast("success", `${label} API key removed.`);
    } catch {
      toast("error", "Failed to remove API key.");
    } finally {
      setIsSaving(false);
    }
  }, [settingKey]);

  return { apiKey, showKey, setShowKey, status, isSaving, load, handleChange, handleSave, handleClear };
}

export function SearchSettings() {
  const exa = useProviderKey("exa_api_key");
  const tavily = useProviderKey("tavily_api_key");

  useEffect(() => {
    let cancelled = false;
    rpc
      .getSettings("integrations")
      .then((s) => {
        if (cancelled) return;
        exa.load(s);
        tavily.load(s);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // Only run once on mount — the two load() callbacks are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Search</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Upgrade the <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">web_search</code> agent
          tool with a search provider API key for higher-quality, structured results. Keys are stored
          locally and never sent to any third-party service other than the provider they belong to.
        </p>
      </div>

      <Separator />

      <ProviderCard
        settingKey="exa-key"
        title="Exa"
        description={
          <>
            Get a free key at <span className="font-mono text-xs">exa.ai</span> — includes 20,000
            requests/month on the free tier. Neural search built for AI agents with token-efficient
            results. Tried first when configured.
          </>
        }
        placeholder="exa-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        hint="Exa keys are issued from the Exa dashboard."
        status={exa.status}
        apiKey={exa.apiKey}
        showKey={exa.showKey}
        isSaving={exa.isSaving}
        onChange={exa.handleChange}
        onToggleShow={() => exa.setShowKey((p) => !p)}
        onSave={() => exa.handleSave("Exa")}
        onClear={() => exa.handleClear("Exa")}
      />

      <ProviderCard
        settingKey="tavily-key"
        title="Tavily"
        description={
          <>
            Get a free key at <span className="font-mono text-xs">tavily.com</span> — includes 1,000
            searches/month on the free tier. Agents use <strong>advanced</strong> search depth for higher
            quality results plus a synthesised answer. Used as the middle fallback, when Exa is not
            configured or is unavailable.
          </>
        }
        placeholder="tvly-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        hint={<>Tavily keys start with <code className="font-mono bg-muted px-1 rounded">tvly-</code>.</>}
        status={tavily.status}
        apiKey={tavily.apiKey}
        showKey={tavily.showKey}
        isSaving={tavily.isSaving}
        onChange={tavily.handleChange}
        onToggleShow={() => tavily.setShowKey((p) => !p)}
        onSave={() => tavily.handleSave("Tavily")}
        onClear={() => tavily.handleClear("Tavily")}
      />

      <Card className="bg-muted/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">How agents use this</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-1">
          <p>
            <code className="font-mono bg-muted px-1 rounded">web_search</code> always tries providers in a
            fixed order — <strong>Exa → Tavily → DuckDuckGo</strong> — and automatically moves to the next
            one if a provider is not configured, hits its rate limit, or errors. DuckDuckGo needs no key and
            is always the final fallback, so agents can always search the web.
          </p>
          <p>
            You can configure just one key, both, or neither — the tool adapts automatically and no agent
            configuration changes are needed.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
