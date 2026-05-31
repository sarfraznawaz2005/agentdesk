import { useState, useEffect } from "react";
import { FileText, Trash2 } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

export function AiDebugSettings() {
  const [enabled, setEnabled] = useState(false);
  const [logPath, setLogPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [aiSettings, appInfo] = await Promise.all([
          rpc.getSettings("ai"),
          rpc.getAppInfo(),
        ]);

        if (cancelled) return;

        const data = aiSettings as Record<string, unknown> ?? {};
        setEnabled(data.debug_prompts === true || data.debug_prompts === "true");

        const sep = appInfo.platform === "win32" ? "\\" : "/";
        setLogPath(`${appInfo.dataDir}${sep}logs${sep}prompts.log`);
      } catch {
        if (!cancelled) toast("error", "Failed to load debug settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(checked: boolean) {
    setSaving(true);
    try {
      await rpc.saveSetting("debug_prompts", checked, "ai");
      setEnabled(checked);
      toast("success", checked ? "Prompt logging enabled." : "Prompt logging disabled.");
    } catch {
      toast("error", "Failed to save setting.");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    try {
      const result = await rpc.clearPromptLog();
      if (result.success) {
        toast("success", "Prompt log cleared.");
      } else {
        toast("error", "Failed to clear prompt log.");
      }
    } catch {
      toast("error", "Failed to clear prompt log.");
    }
  }

  async function handleOpen() {
    try {
      const result = await rpc.openPromptLog();
      if (!result.success) {
        toast("error", "Failed to open prompt log.");
      }
    } catch {
      toast("error", "Failed to open prompt log.");
    }
  }

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Debug</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Diagnostic tools for inspecting AI interactions.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Debug Prompts</CardTitle>
          <CardDescription>
            Log all prompts sent to AI providers to a file for inspection. Token usage and prompt details are shown in the Analytics page under the Prompts tab. Log rotates automatically at 5 MB.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="debug-prompts">Enable prompt logging</Label>
              <p className="text-xs text-muted-foreground">
                Off by default. May produce large log files during active use.
              </p>
            </div>
            <Switch
              id="debug-prompts"
              checked={enabled}
              onCheckedChange={handleToggle}
              disabled={saving}
            />
          </div>

          {logPath && (
            <div className="rounded-md border border-border bg-muted/50 px-3 py-2">
              <p className="text-xs text-muted-foreground mb-1">Log file location:</p>
              <p className="text-xs font-mono text-foreground break-all select-all">
                {logPath}
              </p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={handleOpen}>
              <FileText className="h-3.5 w-3.5 mr-1.5" />
              View Log
            </Button>
            <Button variant="outline" size="sm" onClick={handleClear}>
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Clear Log
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
