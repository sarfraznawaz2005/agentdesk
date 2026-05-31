import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  Database,
  Brain,
  FolderOpen,
  Clock,
  Plug,
  Cpu,
  Trash2,
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HealthStatus {
  database: {
    status: "healthy" | "degraded" | "error";
    message?: string;
    hasBackups: boolean;
  };
  aiProvider: {
    status: "healthy" | "degraded" | "error";
    message?: string;
    providerCount: number;
    hasDefault: boolean;
  };
  workspace: {
    status: "healthy" | "degraded" | "error";
    message?: string;
    missingPaths: string[];
  };
  scheduler: {
    status: "healthy" | "stopped" | "error";
    message?: string;
    activeJobs: number;
  };
  integrations: {
    status: "healthy" | "degraded" | "disconnected";
    channels: Array<{ channelId: string; platform: string; status: string }>;
  };
  engines: {
    status: "healthy" | "warning";
    activeCount: number;
    idleCount: number;
    maxSize: number;
  };
  backend: {
    status: "healthy";
    uptime: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StatusLevel = "healthy" | "warning" | "error";

function resolveLevel(status: string): StatusLevel {
  if (status === "healthy" || status === "connected") return "healthy";
  if (
    status === "degraded" ||
    status === "warning" ||
    status === "stopped" ||
    status === "disconnected"
  )
    return "warning";
  return "error";
}

function StatusIcon({ level }: { level: StatusLevel }) {
  if (level === "healthy")
    return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
  if (level === "warning")
    return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
  return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
}

function StatusBadge({ status }: { status: string }) {
  const level = resolveLevel(status);
  return (
    <Badge
      variant="outline"
      className={cn(
        "capitalize text-xs font-medium",
        level === "healthy" &&
          "border-green-500/30 bg-green-500/15 text-green-600 dark:text-green-400",
        level === "warning" &&
          "border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400",
        level === "error" &&
          "border-red-500/30 bg-red-500/15 text-red-600 dark:text-red-400",
      )}
    >
      <StatusIcon level={level} />
      <span className="ml-1">{status}</span>
    </Badge>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

// ---------------------------------------------------------------------------
// Subsystem card shell
// ---------------------------------------------------------------------------

interface SubsystemCardProps {
  icon: React.ReactNode;
  name: string;
  status: string;
  description: React.ReactNode;
  action?: React.ReactNode;
}

function SubsystemCard({
  icon,
  name,
  status,
  description,
  action,
}: SubsystemCardProps) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex items-start gap-4">
      {/* Icon */}
      <div className="mt-0.5 text-muted-foreground shrink-0">{icon}</div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">{name}</span>
          <StatusBadge status={status} />
        </div>
        <div className="text-xs text-muted-foreground leading-relaxed">
          {description}
        </div>
      </div>

      {/* Action */}
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual subsystem cards
// ---------------------------------------------------------------------------

function DatabaseCard({
  data,
  onAction,
}: {
  data: HealthStatus["database"];
  onAction: () => void;
}) {
  const [checking, setChecking] = useState(false);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    try {
      await rpc.checkDatabase();
      onAction();
    } finally {
      setChecking(false);
    }
  }, [onAction]);

  const description = (
    <span>
      {data.message ?? "Database is operating normally."}
      {data.hasBackups && (
        <span className="ml-1 text-green-600 dark:text-green-400">
          Backups available.
        </span>
      )}
    </span>
  );

  const action =
    data.status !== "healthy" ? (
      <Button variant="outline" size="sm" onClick={handleCheck} disabled={checking}>
        {checking ? "Checking…" : "Check Database"}
      </Button>
    ) : undefined;

  return (
    <SubsystemCard
      icon={<Database className="h-5 w-5" />}
      name="Database"
      status={data.status}
      description={description}
      action={action}
    />
  );
}

function AiProviderCard({ data }: { data: HealthStatus["aiProvider"] }) {
  const effectiveStatus = data.hasDefault ? data.status : "degraded";
  const effectiveMessage = !data.hasDefault
    ? "No default provider configured."
    : data.message ??
      `${data.providerCount} provider${data.providerCount === 1 ? "" : "s"} configured.`;

  const description = (
    <span>
      {effectiveMessage}
      {data.hasDefault && data.providerCount > 0 && (
        <span className="ml-1">
          {data.providerCount} provider{data.providerCount === 1 ? "" : "s"} available.
        </span>
      )}
    </span>
  );

  return (
    <SubsystemCard
      icon={<Brain className="h-5 w-5" />}
      name="AI Provider"
      status={effectiveStatus}
      description={description}
    />
  );
}

function WorkspaceCard({ data }: { data: HealthStatus["workspace"] }) {
  const description =
    data.missingPaths.length === 0 ? (
      <span>All project paths accessible.</span>
    ) : (
      <span>
        <span className="text-amber-600 dark:text-amber-400 font-medium">
          {data.missingPaths.length} path{data.missingPaths.length === 1 ? "" : "s"} missing:
        </span>{" "}
        <span>
          {data.missingPaths.map((p, i) => (
            <span key={p}>
              <code className="font-mono bg-muted px-0.5 rounded">{p}</code>
              {i < data.missingPaths.length - 1 && ", "}
            </span>
          ))}
        </span>
      </span>
    );

  return (
    <SubsystemCard
      icon={<FolderOpen className="h-5 w-5" />}
      name="Workspace Paths"
      status={data.status}
      description={description}
    />
  );
}

function SchedulerCard({
  data,
  onAction,
}: {
  data: HealthStatus["scheduler"];
  onAction: () => void;
}) {
  const [restarting, setRestarting] = useState(false);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await rpc.restartScheduler();
      onAction();
    } finally {
      setRestarting(false);
    }
  }, [onAction]);

  const description = (
    <span>
      {data.message ??
        (data.status === "stopped"
          ? "Scheduler is not running."
          : `${data.activeJobs} active job${data.activeJobs === 1 ? "" : "s"} scheduled.`)}
    </span>
  );

  return (
    <SubsystemCard
      icon={<Clock className="h-5 w-5" />}
      name="Cron Scheduler"
      status={data.status}
      description={description}
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={handleRestart}
          disabled={restarting}
        >
          {restarting ? "Restarting…" : "Restart Scheduler"}
        </Button>
      }
    />
  );
}

function IntegrationsCard({ data }: { data: HealthStatus["integrations"] }) {
  const description =
    data.channels.length === 0 ? (
      <span>No integrations configured.</span>
    ) : (
      <ul className="mt-1 space-y-0.5">
        {data.channels.map((ch) => {
          const level = resolveLevel(ch.status);
          return (
            <li key={ch.channelId} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full shrink-0",
                  level === "healthy" && "bg-green-500",
                  level === "warning" && "bg-amber-500",
                  level === "error" && "bg-red-500",
                )}
              />
              <span className="capitalize font-medium">{ch.platform}</span>
              <span className="text-muted-foreground/60">·</span>
              <span className="text-muted-foreground">{ch.status}</span>
            </li>
          );
        })}
      </ul>
    );

  return (
    <SubsystemCard
      icon={<Plug className="h-5 w-5" />}
      name="Integrations"
      status={data.status}
      description={description}
    />
  );
}

function EnginesCard({
  data,
  onAction,
}: {
  data: HealthStatus["engines"];
  onAction: () => void;
}) {
  const [cleaning, setCleaning] = useState(false);

  const handleCleanup = useCallback(async () => {
    setCleaning(true);
    try {
      await rpc.cleanupEngines();
      onAction();
    } finally {
      setCleaning(false);
    }
  }, [onAction]);

  const description = (
    <span>
      {data.activeCount} active, {data.idleCount} idle, {data.maxSize} max capacity.
    </span>
  );

  const action =
    data.idleCount > 0 ? (
      <Button
        variant="outline"
        size="sm"
        onClick={handleCleanup}
        disabled={cleaning}
        className="gap-1.5"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {cleaning ? "Cleaning…" : "Clean Up"}
      </Button>
    ) : undefined;

  return (
    <SubsystemCard
      icon={<Cpu className="h-5 w-5" />}
      name="Agent Engines"
      status={data.status}
      description={description}
      action={action}
    />
  );
}

function BackendCard({ data }: { data: HealthStatus["backend"] }) {
  return (
    <SubsystemCard
      icon={<Activity className="h-5 w-5" />}
      name="Backend Process"
      status={data.status}
      description={<span>Process running. Uptime: {formatUptime(Math.floor(data.uptime / 1000))}.</span>}
    />
  );
}

// ---------------------------------------------------------------------------
// HealthSettings — main export
// ---------------------------------------------------------------------------

export function HealthSettings() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchHealth = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const result = await rpc.getHealthStatus();
      setHealth(result as HealthStatus);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth(false);
  }, [fetchHealth]);

  const handleRefresh = useCallback(() => {
    fetchHealth(true);
  }, [fetchHealth]);

  // Called by subsystem cards after performing an action
  const handleActionRefetch = useCallback(() => {
    fetchHealth(true);
  }, [fetchHealth]);

  return (
    <div className="space-y-6 py-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground">System Health</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Live status of all core subsystems. Use the action buttons to resolve
            issues or reclaim resources.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={loading || refreshing}
          className="gap-1.5 shrink-0"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
          />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex h-40 items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading health status…</p>
        </div>
      )}

      {/* Subsystem cards */}
      {!loading && health && (
        <div className="flex flex-col gap-3">
          <DatabaseCard data={health.database} onAction={handleActionRefetch} />
          <AiProviderCard data={health.aiProvider} />
          <WorkspaceCard data={health.workspace} />
          <SchedulerCard data={health.scheduler} onAction={handleActionRefetch} />
          <IntegrationsCard data={health.integrations} />
          <EnginesCard data={health.engines} onAction={handleActionRefetch} />
          <BackendCard data={health.backend} />
        </div>
      )}

      {/* Fetch failed / no data */}
      {!loading && !health && (
        <div className="flex h-40 flex-col items-center justify-center gap-3">
          <p className="text-sm text-muted-foreground">
            Could not load health status.
          </p>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
