import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import {
  Database,
  Brain,
  FolderOpen,
  Clock,
  Plug,
  Cpu,
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types — mirrors the backend HealthStatus shape
// ---------------------------------------------------------------------------

interface HealthStatus {
  database: { status: "healthy" | "degraded" | "error"; message?: string; hasBackups: boolean };
  aiProvider: { status: "healthy" | "degraded" | "error"; message?: string; providerCount: number; hasDefault: boolean };
  workspace: { status: "healthy" | "degraded" | "error"; message?: string; missingPaths: string[] };
  scheduler: { status: "healthy" | "stopped" | "error"; message?: string; activeJobs: number };
  integrations: { status: "healthy" | "degraded" | "disconnected"; channels: Array<{ channelId: string; platform: string; status: string }> };
  engines: { status: "healthy" | "warning"; activeCount: number; idleCount: number; maxSize: number };
  backend: { status: "healthy"; uptime: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Level = "healthy" | "warning" | "error";

function toLevel(status: string): Level {
  if (status === "healthy") return "healthy";
  if (status === "degraded" || status === "warning" || status === "stopped" || status === "disconnected") return "warning";
  return "error";
}

function LevelIcon({ level }: { level: Level }) {
  if (level === "healthy") return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
  if (level === "warning") return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
  return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
}

/** Returns true if every subsystem is "healthy". */
function isAllHealthy(h: HealthStatus): boolean {
  return (
    h.database.status === "healthy" &&
    h.aiProvider.status === "healthy" &&
    h.workspace.status === "healthy" &&
    h.scheduler.status === "healthy" &&
    (h.integrations.status === "healthy" || h.integrations.channels.length === 0) &&
    h.engines.status === "healthy" &&
    h.backend.status === "healthy"
  );
}

// ---------------------------------------------------------------------------
// Row component — one per subsystem
// ---------------------------------------------------------------------------

interface RowProps {
  icon: React.ReactNode;
  label: string;
  level: Level;
  detail: string;
  action?: { label: string; onClick: () => void; loading?: boolean };
  hint?: string;
}

function Row({ icon, label, level, detail, action, hint }: RowProps) {
  if (level === "healthy") return null; // don't render healthy rows — only problems

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
      <div className="mt-0.5 text-muted-foreground shrink-0">{icon}</div>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <LevelIcon level={level} />
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] capitalize",
              level === "warning" && "border-amber-500/30 bg-amber-500/15 text-amber-500",
              level === "error" && "border-red-500/30 bg-red-500/15 text-red-500",
            )}
          >
            {level === "warning" ? "needs attention" : "error"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
        {hint && <p className="text-xs text-muted-foreground/70 italic">{hint}</p>}
      </div>
      {action && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 self-center text-xs"
          onClick={action.onClick}
          disabled={action.loading}
        >
          {action.loading && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
          {action.label}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function StartupHealthDialog() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [restartingScheduler, setRestartingScheduler] = useState(false);

  // Run health check once on mount, but delayed so background services
  // (channels, scheduler, plugins) have time to finish initialising after dom-ready.
  useEffect(() => {
    if (checked) return;
    const timer = setTimeout(() => {
      rpc.getHealthStatus()
        .then((result) => {
          const h = result as HealthStatus;
          setHealth(h);
          if (!isAllHealthy(h)) {
            setOpen(true);
          }
        })
        .catch(() => {
          // If the RPC itself fails, show a generic error
          setHealth(null);
          setOpen(true);
        })
        .finally(() => setChecked(true));
    }, 10000);
    return () => clearTimeout(timer);
  }, [checked]);

  const refresh = useCallback(() => {
    rpc.getHealthStatus()
      .then((result) => {
        const h = result as HealthStatus;
        setHealth(h);
        if (isAllHealthy(h)) {
          setOpen(false);
        }
      })
      .catch(() => {});
  }, []);

  const handleRestartScheduler = useCallback(async () => {
    setRestartingScheduler(true);
    try {
      await rpc.restartScheduler();
      refresh();
    } finally {
      setRestartingScheduler(false);
    }
  }, [refresh]);

  // Nothing to show — either still loading or all healthy
  if (!checked || (!open && checked)) return null;

  // Count issues
  const issueCount = health
    ? [
        health.database.status !== "healthy",
        health.aiProvider.status !== "healthy",
        health.workspace.status !== "healthy",
        health.scheduler.status !== "healthy",
        health.integrations.status !== "healthy" && health.integrations.channels.length > 0,
        health.engines.status !== "healthy",
        health.backend.status !== "healthy",
      ].filter(Boolean).length
    : 1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg w-full bg-background border-border text-foreground gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            System Health Check
            <Badge variant="outline" className="ml-auto text-xs border-amber-500/30 bg-amber-500/15 text-amber-500">
              {issueCount} issue{issueCount === 1 ? "" : "s"}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 py-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {!health ? (
            <p className="text-sm text-muted-foreground">
              Could not reach the backend. The app may not function correctly.
            </p>
          ) : (
            <>
              {/* Database */}
              <Row
                icon={<Database className="h-4 w-4" />}
                label="Database"
                level={toLevel(health.database.status)}
                detail={health.database.message ?? "Database check failed."}
                hint={health.database.hasBackups ? "Backups are available — go to Settings > Data to restore." : "No backups found. Consider creating one once resolved."}
              />

              {/* AI Provider */}
              <Row
                icon={<Brain className="h-4 w-4" />}
                label="AI Provider"
                level={toLevel(health.aiProvider.status)}
                detail={health.aiProvider.message ?? "Provider configuration issue."}
                hint="Go to Settings > AI Providers to configure a default provider."
              />

              {/* Workspace Paths */}
              <Row
                icon={<FolderOpen className="h-4 w-4" />}
                label="Workspace Paths"
                level={toLevel(health.workspace.status)}
                detail={
                  health.workspace.missingPaths.length > 0
                    ? `Missing: ${health.workspace.missingPaths.join(", ")}`
                    : health.workspace.message ?? "Workspace issue."
                }
                hint="Check that the project directories exist on disk, or update the project path in settings."
              />

              {/* Scheduler */}
              <Row
                icon={<Clock className="h-4 w-4" />}
                label="Cron Scheduler"
                level={toLevel(health.scheduler.status)}
                detail={health.scheduler.message ?? "Scheduler is not running."}
                action={{
                  label: restartingScheduler ? "Restarting…" : "Start Scheduler",
                  onClick: handleRestartScheduler,
                  loading: restartingScheduler,
                }}
              />

              {/* Integrations */}
              {health.integrations.channels.length > 0 && (
                <Row
                  icon={<Plug className="h-4 w-4" />}
                  label="Integrations"
                  level={toLevel(health.integrations.status)}
                  detail={
                    health.integrations.channels
                      .filter((c) => c.status !== "connected" && c.status !== "connecting")
                      .map((c) => `${c.platform}: ${c.status}`)
                      .join(", ") || "Integration issue."
                  }
                  hint="Check integration settings for each platform (Discord, WhatsApp, Email)."
                />
              )}

              {/* Engines */}
              <Row
                icon={<Cpu className="h-4 w-4" />}
                label="Agent Engines"
                level={toLevel(health.engines.status)}
                detail={`${health.engines.activeCount + health.engines.idleCount}/${health.engines.maxSize} engine slots used.`}
                hint="Engine map is near capacity. Go to Settings > Health to clean up idle engines."
              />

              {/* Backend */}
              <Row
                icon={<Activity className="h-4 w-4" />}
                label="Backend Process"
                level={toLevel(health.backend.status)}
                detail="Backend process is not responding correctly."
              />
            </>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border">
          <Button variant="outline" size="sm" onClick={refresh}>
            Re-check
          </Button>
          <Button size="sm" onClick={() => setOpen(false)}>
            Dismiss
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
