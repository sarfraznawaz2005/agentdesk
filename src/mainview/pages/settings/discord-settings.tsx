import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff, Bot, Trash2, Plus, Check, AlertCircle } from "lucide-react";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiscordConfig {
  id: string;
  projectId: string | null;
  platform: string;
  config: string;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

interface ParsedConfig {
  token: string;
  serverId: string;
  channelId: string;
}

interface Project {
  id: string;
  name: string;
}

interface Server {
  id: string;
  name: string;
}

type BotStatus = "connected" | "disconnected" | "reconnecting" | "error";

// ---------------------------------------------------------------------------
// Status indicator
// ---------------------------------------------------------------------------

function BotStatusIndicator({ status }: { status: BotStatus }) {
  const statusMap: Record<BotStatus, { color: string; label: string }> = {
    connected: { color: "bg-green-500", label: "Connected" },
    disconnected: { color: "bg-gray-300 dark:bg-gray-600", label: "Disconnected" },
    reconnecting: { color: "bg-yellow-400", label: "Reconnecting..." },
    error: { color: "bg-red-500", label: "Error" },
  };

  const { color, label } = statusMap[status];

  return (
    <div className="flex items-center gap-2">
      <span className={cn("inline-block h-2 w-2 rounded-full", color)} aria-hidden="true" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config form — used for both create and edit
// ---------------------------------------------------------------------------

interface ConfigFormProps {
  initial?: { id: string; parsed: ParsedConfig; projectId: string | null; enabled: boolean };
  projects: Project[];
  onSaved: () => void;
  onCancel: () => void;
}

function ConfigForm({ initial, projects, onSaved, onCancel }: ConfigFormProps) {
  const [token, setToken] = useState(initial?.parsed.token ?? "");
  const [showToken, setShowToken] = useState(false);
  const [serverId, setServerId] = useState(initial?.parsed.serverId ?? "");
  const [channelId, setChannelId] = useState(initial?.parsed.channelId ?? "");
  const [projectId, setProjectId] = useState(initial?.projectId ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);

  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    botName?: string;
    servers?: Server[];
    error?: string;
  } | null>(null);

  const handleTest = useCallback(async () => {
    if (!token.trim()) {
      toast("warning", "Enter a bot token before testing.");
      return;
    }
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await rpc.testDiscordConnection(token.trim());
      if (result.success) {
        setTestResult({ botName: result.botName, servers: result.servers ?? [] });
        toast("success", `Connected as ${result.botName ?? "bot"}.`);
      } else {
        setTestResult({ error: result.error ?? "Connection failed" });
        toast("error", result.error ?? "Connection test failed.");
      }
    } catch {
      setTestResult({ error: "Unexpected error during test" });
      toast("error", "Unexpected error during connection test.");
    } finally {
      setIsTesting(false);
    }
  }, [token]);

  const handleSave = useCallback(async () => {
    if (!token.trim()) {
      toast("warning", "Bot token is required.");
      return;
    }
    if (!serverId.trim()) {
      toast("warning", "Server ID is required.");
      return;
    }
    if (!channelId.trim()) {
      toast("warning", "Channel ID is required.");
      return;
    }

    setIsSaving(true);
    try {
      await rpc.saveDiscordConfig({
        id: initial?.id,
        projectId: projectId || undefined,
        token: token.trim(),
        serverId: serverId.trim(),
        channelId: channelId.trim(),
        enabled,
      });
      toast("success", initial?.id ? "Discord config updated." : "Discord config saved.");
      onSaved();
    } catch {
      toast("error", "Failed to save Discord config. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [token, serverId, channelId, projectId, enabled, initial, onSaved]);

  return (
    <div className="space-y-4">
      {/* Bot Token */}
      <div className="space-y-2">
        <Label htmlFor="discord-token">Bot Token</Label>
        <div className="relative">
          <Input
            id="discord-token"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => { setToken(e.target.value); setTestResult(null); }}
            placeholder="Bot token from Discord Developer Portal"
            autoComplete="off"
            spellCheck={false}
            className="pr-10 font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => setShowToken((prev) => !prev)}
            aria-label={showToken ? "Hide token" : "Show token"}
            className={cn(
              "absolute inset-y-0 right-0 flex items-center px-3",
              "text-muted-foreground transition-colors hover:text-foreground",
              "rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            )}
          >
            {showToken ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Test Connection */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={!token.trim() || isTesting || isSaving}
        >
          {isTesting ? "Testing..." : "Test Connection"}
        </Button>
        {testResult && !testResult.error && (
          <span className="flex items-center gap-1 text-sm text-green-700">
            <Check className="h-4 w-4" aria-hidden="true" />
            {testResult.botName ?? "Bot"} connected
          </span>
        )}
        {testResult?.error && (
          <span className="flex items-center gap-1 text-sm text-red-600">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            {testResult.error}
          </span>
        )}
      </div>

      {/* Server ID — dropdown if test succeeded, plain input otherwise */}
      <div className="space-y-2">
        <Label htmlFor="discord-server">Server ID</Label>
        {testResult?.servers && testResult.servers.length > 0 ? (
          <select
            id="discord-server"
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            className={cn(
              "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1",
              "text-sm shadow-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            <option value="">Select a server...</option>
            {testResult.servers.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
            ))}
          </select>
        ) : (
          <Input
            id="discord-server"
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            placeholder="Discord server (guild) ID"
            className="font-mono text-sm"
          />
        )}
        <p className="text-xs text-muted-foreground">
          Enable Developer Mode in Discord, then right-click a server to copy its ID.
        </p>
      </div>

      {/* Channel ID */}
      <div className="space-y-2">
        <Label htmlFor="discord-channel">Channel ID</Label>
        <Input
          id="discord-channel"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          placeholder="Discord channel ID"
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Right-click a channel in Discord (with Developer Mode on) to copy its ID.
        </p>
      </div>

      {/* Project mapping */}
      <div className="space-y-2">
        <Label htmlFor="discord-project">Project (optional)</Label>
        <select
          id="discord-project"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className={cn(
            "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1",
            "text-sm shadow-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <option value="">No project (global)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center gap-3">
        <label htmlFor="discord-enabled" className="text-sm font-medium leading-none cursor-pointer">
          Enable this configuration
        </label>
        <button
          id="discord-enabled"
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled((prev) => !prev)}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
            "transition-colors duration-200 ease-in-out",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            enabled ? "bg-primary" : "bg-input",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg",
              "transform transition duration-200 ease-in-out",
              enabled ? "translate-x-4" : "translate-x-0",
            )}
          />
        </button>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={!token.trim() || !serverId.trim() || !channelId.trim() || isSaving || isTesting}
        >
          {isSaving ? "Saving..." : initial?.id ? "Update" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main settings component
// ---------------------------------------------------------------------------

export function DiscordSettings() {
  const [configs, setConfigs] = useState<DiscordConfig[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [botStatus, setBotStatus] = useState<BotStatus>("disconnected");
  const [showForm, setShowForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<DiscordConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfgs, projs, statusResult] = await Promise.all([
        rpc.getDiscordConfigs(),
        rpc.getProjects(),
        rpc.getDiscordStatus(),
      ]);
      setConfigs(cfgs);
      setProjects(projs);
      setBotStatus(statusResult.status);
    } catch {
      toast("error", "Failed to load Discord settings.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    try {
      await rpc.deleteDiscordConfig(id);
      toast("success", "Discord config deleted.");
      setConfigs((prev) => prev.filter((c) => c.id !== id));
    } catch {
      toast("error", "Failed to delete Discord config.");
    } finally {
      setDeletingId(null);
    }
  }, []);

  const handleSaved = useCallback(() => {
    setShowForm(false);
    setEditingConfig(null);
    load();
    // Poll status again after a short delay to pick up async connection result
    setTimeout(load, 3000);
  }, [load]);

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setEditingConfig(null);
  }, []);

  function parseConfig(raw: string): ParsedConfig {
    try {
      return JSON.parse(raw) as ParsedConfig;
    } catch {
      return { token: "", serverId: "", channelId: "" };
    }
  }

  function projectName(id: string | null): string {
    if (!id) return "Global";
    return projects.find((p) => p.id === id)?.name ?? id;
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-32 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold">Discord Integration</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Connect a Discord bot to receive notifications and interact with AgentDesk
          from your Discord server.
        </p>
      </div>

      <Separator />

      {/* Status card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-foreground" aria-hidden="true" />
              <CardTitle className="text-base">Bot Status</CardTitle>
            </div>
            <BotStatusIndicator status={botStatus} />
          </div>
          <CardDescription>
            Connect a Discord bot to receive and respond to messages from your server in real-time.
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Existing configurations */}
      {configs.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium">Configured Channels</h4>
          {configs.map((cfg) => {
            const parsed = parseConfig(cfg.config);
            return (
              <Card key={cfg.id}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "inline-block h-2 w-2 rounded-full shrink-0",
                            cfg.enabled ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600",
                          )}
                          aria-hidden="true"
                        />
                        <span className="text-sm font-medium truncate">
                          {projectName(cfg.projectId)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono">
                        Server: {parsed.serverId || "—"} &bull; Channel: {parsed.channelId || "—"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingConfig(cfg);
                          setShowForm(false);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(cfg.id)}
                        disabled={deletingId === cfg.id}
                        aria-label="Delete this Discord configuration"
                      >
                        {deletingId === cfg.id ? (
                          "..."
                        ) : (
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Inline edit form */}
                  {editingConfig?.id === cfg.id && (
                    <div className="mt-4 pt-4 border-t">
                      <ConfigForm
                        initial={{
                          id: cfg.id,
                          parsed: parseConfig(cfg.config),
                          projectId: cfg.projectId,
                          enabled: cfg.enabled === 1,
                        }}
                        projects={projects}
                        onSaved={handleSaved}
                        onCancel={handleCancel}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add new configuration */}
      {showForm ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">New Discord Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <ConfigForm
              projects={projects}
              onSaved={handleSaved}
              onCancel={handleCancel}
            />
          </CardContent>
        </Card>
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={() => { setShowForm(true); setEditingConfig(null); }}
          className="flex items-center gap-2"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add Discord Configuration
        </Button>
      )}
    </div>
  );
}
