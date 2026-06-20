import { useState, useEffect } from "react";
import { ShieldAlert, Check, X, Terminal, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { persistShellApprovalDecision } from "@/stores/chat-event-handlers";
import type { ShellApprovalRequest } from "@/stores/chat-types";
import { Tip } from "@/components/ui/tooltip";

function formatAgentName(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ShellApprovalCard({ request, onDismiss }: { request: ShellApprovalRequest; onDismiss?: (id: string) => void }) {
  const [responded, setResponded] = useState(!!request.decision);
  const [decision, setDecision] = useState<string | null>(request.decision ?? null);

  const handleDecision = async (d: "allow" | "deny" | "always") => {
    setResponded(true);
    setDecision(d);
    persistShellApprovalDecision(request.requestId, d);
    try {
      await rpc.respondShellApproval(request.requestId, d);
    } catch {
      // Best effort — the request may have already timed out
    }
  };

  // Auto-dismiss after decision
  useEffect(() => {
    if (!responded) return;
    const timer = setTimeout(() => onDismiss?.(request.requestId), 2000);
    return () => clearTimeout(timer);
  }, [responded, request.requestId, onDismiss]);

  // Expired (5-min timeout or orphaned by a desktop restart): the awaiting agent
  // run is gone, so resolving is impossible — show a clean, non-interactive note
  // inviting the user to ask the agent to try again (TASK-478 durability).
  if (request.expired && !responded) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border border-border rounded-lg text-xs animate-in fade-in duration-150">
        <Clock className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
        <span className="text-muted-foreground font-medium shrink-0">Approval expired</span>
        <code className="text-muted-foreground truncate min-w-0 flex-1">{request.command}</code>
        <span className="text-[10px] text-muted-foreground/60 shrink-0">ask the agent to retry</span>
      </div>
    );
  }

  if (responded) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border border-border rounded-lg text-xs animate-in fade-in duration-150">
        <Terminal className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
        {decision === "deny" ? (
          <>
            <X className="w-3.5 h-3.5 text-red-500 shrink-0" />
            <span className="text-red-600 font-medium">Denied</span>
          </>
        ) : (
          <>
            <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
            <span className="text-green-600 font-medium">
              {decision === "always" ? "Allowed (session)" : "Allowed"}
            </span>
          </>
        )}
        <code className="text-muted-foreground truncate min-w-0 flex-1">{request.command}</code>
      </div>
    );
  }

  return (
    <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700/50 rounded-lg p-3 shadow-sm animate-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="w-4 h-4 text-amber-500" />
          <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">Shell Approval Required</span>
        </div>
        <span className="text-[10px] text-muted-foreground/60">{formatAgentName(request.agentName)}</span>
      </div>
      <div className="bg-background border border-border rounded px-2.5 py-1.5 mb-3">
        <code className="text-xs text-foreground/80 break-all">{request.command}</code>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => handleDecision("deny")}
          className={cn(
            "flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-colors",
            "text-white bg-red-500 hover:bg-red-600",
          )}
        >
          <X className="w-3 h-3" />
          Deny
        </button>
        <button
          onClick={() => handleDecision("allow")}
          className={cn(
            "flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-colors",
            "text-white bg-emerald-500 hover:bg-emerald-600",
          )}
        >
          <Check className="w-3 h-3" />
          Allow
        </button>
        <Tip content="Allow all shell commands for this session" side="top">
          <button
            onClick={() => handleDecision("always")}
            className={cn(
              "flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-colors",
              "text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/30 hover:bg-emerald-200 dark:hover:bg-emerald-900/50",
            )}
          >
            <Check className="w-3 h-3" />
            Always
          </button>
        </Tip>
      </div>
    </div>
  );
}
