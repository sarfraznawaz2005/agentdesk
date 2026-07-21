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

type StreamingMode = "hybrid" | "none" | "full";

const OPTIONS: { value: StreamingMode; label: string; description: string }[] = [
  {
    value: "hybrid",
    label: "Hybrid Streaming (current)",
    description:
      "Today's default behavior. Project chat, and the Dashboard, Collections, " +
      "Freelance, and skills-search chat widgets stream live — except when using Claude " +
      "Subscription's Sonnet/Opus models, which always deliver a complete response. Sub-agent " +
      "cards (e.g. Code Explorer) and Playground update per step rather than live. General Chat " +
      "has no sub-agent system, so Hybrid behaves as Full Streaming there — always live, even on " +
      "Claude Subscription's Sonnet/Opus models.",
  },
  {
    value: "none",
    label: "No live typing effect",
    description:
      "Every chat surface delivers one complete response instead of streaming — matching how " +
      "Claude Subscription's Sonnet/Opus models already behave today, applied everywhere. Tool " +
      "call activity still shows live in this mode; only the model's own text and thinking are " +
      "delivered all at once.",
  },
  {
    value: "full",
    label: "Full Streaming",
    description:
      "Every chat surface streams live, token by token — including Claude Subscription's " +
      "Sonnet/Opus models, sub-agent cards in project chat, and Playground. Nothing is left out.",
  },
];

export function StreamingSettings() {
  const [mode, setMode] = useState<StreamingMode>("hybrid");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rpc.getSetting("streamingMode", "ai").then((value) => {
      if (cancelled) return;
      if (value === "none" || value === "full") setMode(value);
      else setMode("hybrid");
    }).catch(() => {
      if (!cancelled) toast("error", "Failed to load streaming settings.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  async function handleSelect(value: StreamingMode) {
    if (value === mode || saving) return;
    setSaving(true);
    const previous = mode;
    setMode(value);
    try {
      await rpc.saveSetting("streamingMode", value, "ai");
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
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Streaming</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Controls whether responses appear live as they're generated, or arrive complete —
          across project chat, sub-agents, Playground, and every chat widget.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Response delivery</CardTitle>
          <CardDescription>Applies globally, to every chat surface.</CardDescription>
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
