import { useEffect, useState, useCallback } from "react";
import { Puzzle, Power, Settings, Download, Trash2, Loader2, MessageSquareText, RotateCcw } from "lucide-react";
import { rpc } from "../lib/rpc";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Tip } from "../components/ui/tooltip";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";

interface PluginInfo {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  permissions: string[];
  enabled: boolean;
  settings: Record<string, unknown>;
  toolCount: number;
  isLoaded: boolean;
  prompt: string | null;
  defaultPrompt: string | null;
  manifest?: {
    settings?: Record<string, { type: string; default?: unknown; description?: string }>;
  };
}

interface PluginSettingsDialogProps {
  plugin: PluginInfo;
  onClose: () => void;
  onSave: (settings: Record<string, unknown>) => void;
}

/** Convert snake_case key to readable label: "typescript_enabled" → "Typescript Enabled" */
function formatSettingLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Group settings by prefix. E.g. typescript_enabled + typescript_binary → group "typescript".
 * Ungrouped keys get their own group with key as the group name.
 */
function groupSettings(
  entries: Array<[string, { type: string; default?: unknown; description?: string }]>,
): Array<{ groupLabel: string; fields: Array<[string, { type: string; default?: unknown; description?: string }]> }> {
  const groups = new Map<string, Array<[string, { type: string; default?: unknown; description?: string }]>>();

  for (const [key, def] of entries) {
    // Try to extract a prefix (e.g. "typescript" from "typescript_enabled")
    const match = key.match(/^(.+?)_(enabled|binary|path|host|port|url|key|secret|token)$/);
    const groupKey = match ? match[1] : key;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)?.push([key, def]);
  }

  return Array.from(groups.entries()).map(([groupKey, fields]) => ({
    groupLabel: groupKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    fields,
  }));
}

function PluginSettingsDialog({ plugin, onClose, onSave }: PluginSettingsDialogProps) {
  const [settings, setSettings] = useState<Record<string, unknown>>(plugin.settings);
  const manifestSettings = plugin.manifest?.settings;

  const handleChange = (key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    await rpc.savePluginSettings(plugin.name, settings);
    onSave(settings);
    onClose();
  };

  const renderField = (key: string, def: { type: string; default?: unknown; description?: string }) => {
    const value = settings[key] ?? def.default;
    // Derive a short label from the suffix: "typescript_binary" → "Binary path"
    const suffix = key.includes("_") ? key.split("_").pop() : key;
    const shortLabel = suffix === "enabled" ? null : formatSettingLabel(suffix ?? key);

    if (def.type === "boolean") {
      return (
        <label key={key} className="flex items-center gap-2.5 cursor-pointer py-0.5">
          <input
            type="checkbox"
            checked={value as boolean}
            onChange={(e) => handleChange(key, e.target.checked)}
            className="w-4 h-4 rounded border-border accent-primary"
          />
          <div>
            <span className="text-sm">{shortLabel ?? "Enabled"}</span>
            {def.description && (
              <span className="text-xs text-muted-foreground block">{def.description}</span>
            )}
          </div>
        </label>
      );
    }

    return (
      <div key={key} className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {shortLabel ?? formatSettingLabel(key)}
        </label>
        {def.type === "number" ? (
          <Input
            type="number"
            value={value as number}
            onChange={(e) => handleChange(key, parseFloat(e.target.value))}
            className="h-8 text-sm"
          />
        ) : def.type === "array" ? (
          <Input
            value={Array.isArray(value) ? value.join(", ") : ""}
            onChange={(e) => handleChange(key, e.target.value.split(",").map((s) => s.trim()))}
            placeholder="Comma-separated values"
            className="h-8 text-sm"
          />
        ) : (
          <Input
            value={(value as string) ?? ""}
            onChange={(e) => handleChange(key, e.target.value)}
            placeholder={def.description ?? ""}
            className="h-8 text-sm"
          />
        )}
      </div>
    );
  };

  const entries = manifestSettings ? Object.entries(manifestSettings) : [];
  const groups = groupSettings(entries);
  const hasMultipleGroups = groups.length > 1;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{plugin.displayName} Settings</DialogTitle>
        </DialogHeader>
        {entries.length > 0 ? (
          <div className="space-y-3">
            {groups.map(({ groupLabel, fields }) => (
              <div
                key={groupLabel}
                className={hasMultipleGroups ? "border rounded-lg p-3 space-y-2.5" : "space-y-3"}
              >
                {hasMultipleGroups && (
                  <h4 className="text-sm font-semibold">{groupLabel}</h4>
                )}
                {fields.map(([key, def]) => renderField(key, def))}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No configurable settings for this plugin.</p>
        )}
        <DialogFooter>
          {manifestSettings && Object.keys(manifestSettings).length > 0 ? (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button variant="default" onClick={handleSave}>Save</Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PluginPromptDialogProps {
  plugin: PluginInfo;
  onClose: () => void;
  onSave: (prompt: string | null) => void;
}

function PluginPromptDialog({ plugin, onClose, onSave }: PluginPromptDialogProps) {
  const [prompt, setPrompt] = useState(plugin.prompt ?? "");
  const [saving, setSaving] = useState(false);
  const hasDefault = !!plugin.defaultPrompt;
  const isModified = hasDefault && prompt.trim() !== (plugin.defaultPrompt ?? "").trim();

  const handleSave = async () => {
    setSaving(true);
    try {
      const value = prompt.trim() || null;
      await rpc.savePluginPrompt(plugin.name, value);
      onSave(value);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setPrompt(plugin.defaultPrompt ?? "");
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{plugin.displayName} — Agent Prompt</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          This text is injected into agent system prompts when the plugin is enabled.
          Use it to teach agents how to use the plugin's tools.
        </p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={12}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="## My Plugin Tools&#10;&#10;Describe how agents should use this plugin's tools..."
        />
        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <div>
            {hasDefault && (
              <Tip content="Reset to the default prompt from the plugin manifest" side="bottom">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleReset}
                  disabled={!isModified}
                  className="gap-1.5 text-muted-foreground"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset to default
                </Button>
              </Tip>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button variant="default" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface LspServerStatus {
  id: string;
  displayName: string;
  extensions: string[];
  status: "disabled" | "not_installed" | "installed" | "installing" | "running";
  source?: "custom" | "system" | "managed";
  prereq?: { tool: string; installUrl: string; missing: boolean };
}

function statusBadge(status: LspServerStatus["status"], source?: string) {
  const colors: Record<string, string> = {
    disabled: "bg-muted text-muted-foreground",
    not_installed: "bg-yellow-500/15 text-yellow-600",
    installed: "bg-green-500/15 text-green-600",
    installing: "bg-blue-500/15 text-blue-600",
    running: "bg-emerald-500/15 text-emerald-600",
  };
  const label = status === "not_installed" ? "Not Installed"
    : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", colors[status] ?? "bg-muted")}>
      {label}{source ? ` (${source})` : ""}
    </span>
  );
}

function LspManagerCard({ pluginEnabled }: { pluginEnabled: boolean }) {
  const [servers, setServers] = useState<LspServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const data = await rpc.getLspStatus();
      setServers(data);
    } catch {
      // Plugin may not be loaded yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, pluginEnabled]);

  const handleInstall = async (serverId: string) => {
    setActionInProgress(serverId);
    setInstallErrors((prev) => { const { [serverId]: _removed, ...rest } = prev; return rest; });
    try {
      const result = await rpc.installLspServer(serverId);
      if (!result.success && result.error) {
        setInstallErrors((prev) => ({ ...prev, [serverId]: result.error ?? "Unknown error" }));
      }
      await refresh();
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUninstall = async (serverId: string) => {
    setActionInProgress(serverId);
    try {
      const result = await rpc.uninstallLspServer(serverId);
      if (!result.success) {
        console.error(`Uninstall failed: ${result.error}`);
      }
      await refresh();
    } finally {
      setActionInProgress(null);
    }
  };

  const handleToggleLanguage = async (serverId: string, enabled: boolean) => {
    // Save the per-language setting via plugin settings RPC
    const settings = await rpc.getPluginSettings("lsp-manager");
    await rpc.savePluginSettings("lsp-manager", {
      ...settings,
      [`${serverId}_enabled`]: enabled,
    });
    await refresh();
  };

  if (loading) {
    return (
      <div className="border rounded-lg p-4 bg-card">
        <div className="text-sm text-muted-foreground">Loading language servers...</div>
      </div>
    );
  }

  if (servers.length === 0) return null;

  return (
    <div className="border rounded-lg p-4 bg-card">
      <h3 className="text-sm font-semibold mb-3">Language Servers</h3>
      <div className="space-y-2">
        {servers.map((server) => {
          const isLoading = actionInProgress === server.id;
          const isDisabled = server.status === "disabled";
          const isInstalled = server.status === "installed" || server.status === "running";
          const canInstall = server.status === "not_installed";
          const canUninstall = isInstalled && server.source === "managed";

          return (
            <div
              key={server.id}
              className={cn(
                "flex items-center justify-between py-2 px-3 rounded-md border",
                isDisabled ? "opacity-50 bg-muted/20" : "bg-background"
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{server.displayName}</span>
                  {statusBadge(server.status, server.source)}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {server.extensions.join(", ")}
                </div>
                {installErrors[server.id] && (
                  <div className="text-xs text-destructive mt-1">
                    {installErrors[server.id]}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 ml-2">
                {/* Enable/Disable toggle */}
                <Tip content={isDisabled ? "Enable" : "Disable"} side="top">
                  <button
                    onClick={() => handleToggleLanguage(server.id, isDisabled)}
                    className={cn(
                      "p-1.5 rounded transition-colors",
                      isDisabled ? "bg-muted hover:bg-muted/80" : "bg-primary/10 text-primary hover:bg-primary/20"
                    )}
                  >
                    <Power className="w-3.5 h-3.5" />
                  </button>
                </Tip>

                {/* Install button */}
                {canInstall && !isDisabled && (
                  <Tip
                    content={
                      server.prereq?.missing
                        ? `Requires ${server.prereq.tool} — install from ${server.prereq.installUrl}`
                        : `Install ${server.displayName}`
                    }
                    side="top"
                  >
                    <span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        disabled={isLoading || (server.prereq?.missing ?? false)}
                        onClick={() => handleInstall(server.id)}
                      >
                        {isLoading ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Download className="w-3 h-3" />
                        )}
                        Install
                      </Button>
                    </span>
                  </Tip>
                )}

                {/* Installing spinner */}
                {server.status === "installing" && (
                  <span className="flex items-center gap-1 text-xs text-blue-600">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Installing...
                  </span>
                )}

                {/* Uninstall button (only for managed installs) */}
                {canUninstall && !isDisabled && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-destructive hover:text-destructive gap-1"
                    disabled={isLoading}
                    onClick={() => handleUninstall(server.id)}
                  >
                    {isLoading ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                    Uninstall
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSettings, setEditingSettings] = useState<PluginInfo | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<PluginInfo | null>(null);

  useEffect(() => {
    rpc.getPlugins().then((list) => {
      setPlugins(list);
      setLoading(false);
    });
  }, []);

  const handleToggle = async (name: string, enabled: boolean) => {
    await rpc.togglePlugin(name, enabled);
    setPlugins((prev) =>
      prev.map((p) => (p.name === name ? { ...p, enabled } : p))
    );
    window.dispatchEvent(new CustomEvent("agentdesk:plugins-changed"));
  };

  const handleSettingsSave = async (name: string, newSettings: Record<string, unknown>) => {
    setPlugins((prev) =>
      prev.map((p) => (p.name === name ? { ...p, settings: newSettings } : p))
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Loading plugins...
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Puzzle className="w-6 h-6" />
        <h1 className="text-xl font-semibold">Plugins</h1>
      </div>

      {plugins.length === 0 ? (
        <p className="text-muted-foreground">No plugins installed.</p>
      ) : (
        <div className="space-y-3">
          {plugins.map((plugin) => (
            <div
              key={plugin.id}
              className={cn(
                "border rounded-lg p-4 transition-colors",
                plugin.enabled ? "bg-card" : "bg-muted/30 opacity-60"
              )}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{plugin.displayName}</h3>
                    <code className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      v{plugin.version}
                    </code>
                    {plugin.toolCount > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {plugin.toolCount} tool{plugin.toolCount !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {plugin.description}
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs text-muted-foreground">by {plugin.author}</span>
                    {plugin.permissions.length > 0 && (
                      <div className="flex gap-1">
                        {plugin.permissions.map((perm) => (
                          <span
                            key={perm}
                            className="text-xs bg-muted px-1.5 py-0.5 rounded"
                          >
                            {perm}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setEditingPrompt(plugin)}
                    className={cn(
                      "p-2 rounded-lg hover:bg-muted transition-colors",
                      plugin.prompt ? "text-primary" : "text-muted-foreground"
                    )}
                    aria-label="Edit agent prompt"
                    title={plugin.prompt
                      ? `Agent prompt: ${plugin.prompt.split("\n").find((l) => l.trim())?.trim().slice(0, 60) ?? ""}...`
                      : "No agent prompt configured"
                    }
                  >
                    <MessageSquareText className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setEditingSettings(plugin)}
                    className="p-2 rounded-lg hover:bg-muted transition-colors"
                    aria-label="Edit plugin settings"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleToggle(plugin.name, !plugin.enabled)}
                    className={cn(
                      "p-2 rounded-lg transition-colors",
                      plugin.enabled
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted hover:bg-muted/80"
                    )}
                    aria-label={plugin.enabled ? "Disable plugin" : "Enable plugin"}
                  >
                    <Power className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* LSP Manager Card — shown when lsp-manager plugin exists */}
      {plugins.some((p) => p.name === "lsp-manager") && (
        <div className="mt-6">
          <LspManagerCard
            pluginEnabled={plugins.find((p) => p.name === "lsp-manager")?.enabled ?? false}
          />
        </div>
      )}

      {/* Plugin Settings Dialog */}
      {editingSettings && (
        <PluginSettingsDialog
          plugin={editingSettings}
          onClose={() => setEditingSettings(null)}
          onSave={(newSettings) => handleSettingsSave(editingSettings.name, newSettings)}
        />
      )}

      {/* Plugin Prompt Dialog */}
      {editingPrompt && (
        <PluginPromptDialog
          plugin={editingPrompt}
          onClose={() => setEditingPrompt(null)}
          onSave={(newPrompt) => {
            setPlugins((prev) =>
              prev.map((p) => (p.name === editingPrompt.name ? { ...p, prompt: newPrompt } : p))
            );
          }}
        />
      )}
    </div>
  );
}