import { useState, useEffect } from "react";
import { Check } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

// General Chat's OWN streaming preference — deliberately separate from the
// global Settings → AI → Streaming option. "hybrid" is omitted: General Chat has
// no sub-agent cards, so it never meant anything distinct here (it always
// resolved to "full"). Persisted under its own key ("generalChatStreamingMode",
// category "ai"), read by general-chat/orchestrator.ts via getGeneralChatStreamingMode.
// Surfaced in a dialog opened by the gear icon in the General Chat header.
type GeneralChatStreamingMode = "none" | "full";

const OPTIONS: { value: GeneralChatStreamingMode; label: string; description: string }[] = [
  {
    value: "full",
    label: "Full Streaming (default)",
    description:
      "The Assistant streams its reply live, token by token, as it's generated. Tool-call " +
      "activity always shows live regardless of this setting.",
  },
  {
    value: "none",
    label: "No live typing effect",
    description:
      "The Assistant delivers one complete reply instead of streaming — the model's text and " +
      "thinking arrive all at once. Tool-call activity still shows live in this mode.",
  },
];

export function GeneralChatStreamingSettings() {
  const [mode, setMode] = useState<GeneralChatStreamingMode>("full");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rpc.getSetting("generalChatStreamingMode", "ai").then((value) => {
      if (cancelled) return;
      setMode(value === "none" ? "none" : "full");
    }).catch(() => {
      if (!cancelled) toast("error", "Failed to load streaming settings.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  async function handleSelect(value: GeneralChatStreamingMode) {
    if (value === mode || saving) return;
    setSaving(true);
    const previous = mode;
    setMode(value);
    try {
      await rpc.saveSetting("generalChatStreamingMode", value, "ai");
    } catch {
      setMode(previous);
      toast("error", "Failed to save streaming setting.");
    } finally {
      setSaving(false);
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
    <div>
      <Card>
        <CardHeader>
          <CardTitle>Streaming</CardTitle>
          <CardDescription>
            Controls whether the Assistant's replies appear live as they're generated, or arrive
            complete. Applies to every General Chat conversation — separate from the global
            streaming setting.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {OPTIONS.map((opt) => {
              const selected = mode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleSelect(opt.value)}
                  disabled={saving}
                  className={cn(
                    "w-full text-left rounded-lg border p-3 transition-colors disabled:opacity-60",
                    selected
                      ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30"
                      : "border-border hover:bg-muted/50",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        selected ? "border-indigo-500 bg-indigo-500" : "border-muted-foreground/40",
                      )}
                    >
                      {selected && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                    </div>
                    <span className="text-sm font-medium">{opt.label}</span>
                  </div>
                  <p className="mt-1.5 pl-6 text-xs text-muted-foreground leading-relaxed">
                    {opt.description}
                  </p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
