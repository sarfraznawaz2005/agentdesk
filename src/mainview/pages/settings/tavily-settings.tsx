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

export function TavilySettings() {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<KeyStatus>("not-configured");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rpc
      .getSettings("integrations")
      .then((s) => {
        if (cancelled) return;
        const saved = s["tavily_api_key"];
        if (typeof saved === "string" && saved.length > 0) {
          setApiKey(saved);
          setStatus("saved");
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setApiKey(e.target.value);
    setStatus("not-configured");
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      toast("warning", "Enter a Tavily API key before saving.");
      return;
    }
    setIsSaving(true);
    try {
      await rpc.saveSetting("tavily_api_key", trimmed, "integrations");
      setStatus("saved");
      toast("success", "Tavily API key saved.");
    } catch {
      toast("error", "Failed to save Tavily API key. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [apiKey]);

  const handleClear = useCallback(async () => {
    setIsSaving(true);
    try {
      await rpc.saveSetting("tavily_api_key", "", "integrations");
      setApiKey("");
      setStatus("not-configured");
      toast("success", "Tavily API key removed.");
    } catch {
      toast("error", "Failed to remove API key.");
    } finally {
      setIsSaving(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Tavily Search</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Enable the <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">enhanced_web_search</code> agent
          tool powered by Tavily's advanced search API. The key is stored locally and never
          sent to any third-party service other than Tavily.
        </p>
      </div>

      <Separator />

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Search className="h-5 w-5 text-foreground" aria-hidden="true" />
              <CardTitle className="text-base">API Key</CardTitle>
            </div>
            <StatusDot status={status} />
          </div>
          <CardDescription>
            Get a free key at{" "}
            <span className="font-mono text-xs">tavily.com</span>
            {" "}— includes 1,000 searches/month on the free tier.
            Agents use <strong>advanced</strong> search depth for higher quality results.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tavily-key">Tavily API Key</Label>
            <div className="relative">
              <Input
                id="tavily-key"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={handleChange}
                placeholder="tvly-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                autoComplete="off"
                spellCheck={false}
                className="pr-10 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShowKey((p) => !p)}
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
            <p className="text-xs text-muted-foreground">
              Tavily keys start with <code className="font-mono bg-muted px-1 rounded">tvly-</code>.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={handleSave}
              disabled={!apiKey.trim() || isSaving}
            >
              {isSaving ? "Saving…" : "Save"}
            </Button>
            {status === "saved" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClear}
                disabled={isSaving}
                className="text-destructive hover:text-destructive"
              >
                Remove key
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-muted/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">How agents use this</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-1">
          <p>
            When configured, agents can call <code className="font-mono bg-muted px-1 rounded">enhanced_web_search</code> to
            get deep research results with a synthesised answer and relevance-scored sources.
          </p>
          <p>
            If the key is not set, the tool returns a clear error message directing the agent to
            use <code className="font-mono bg-muted px-1 rounded">web_search</code> (DuckDuckGo, no key required) instead.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
