import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useHeaderActions } from "@/lib/header-context";
import { rpc } from "../lib/rpc";
import { toast } from "@/components/ui/toast";
import { Tip } from "@/components/ui/tooltip";
import { Plus, Trash2, Zap, RotateCcw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Agent {
  id: string;
  name: string;
  displayName: string;
  color: string;
  isBuiltin: boolean;
  systemPrompt: string;
  providerId: string | null;
  modelId: string | null;
  temperature: string | null;
  maxTokens: number | null;
  isEnabled: boolean;
  thinkingBudget: string | null;
  useSystemPromptOnly: boolean;
  chatEnabled: boolean;
  availableToPm: boolean;
}

interface Provider {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string | null;
  defaultModel: string | null;
  isDefault: boolean;
  isValid: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return displayName.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Tool definitions type + category display names
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  category: string;
  description: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  file: "File Operations",
  shell: "Shell",
  kanban: "Kanban",
  git: "Git",
  web: "Web",
  system: "System",
  process: "Process",
  notes: "Notes",
  communication: "Communication",
  skills: "Skills",
  plugin: "Plugins",
};

// ---------------------------------------------------------------------------
// Agent Tools Tab
// ---------------------------------------------------------------------------

interface AgentToolsTabProps {
  agentId: string;
  onDirty: (dirty: boolean) => void;
  saveRef: React.MutableRefObject<(() => Promise<void>) | null>;
}

function AgentToolsTab({ agentId, onDirty, saveRef }: AgentToolsTabProps) {
  const [allTools, setAllTools] = useState<ToolDef[]>([]);
  const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set());
  const [initialEnabled, setInitialEnabled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  // Load tool definitions + agent's current assignments
  useEffect(() => {
    setLoading(true);
    Promise.all([rpc.getAllToolDefinitions(), rpc.getAgentTools(agentId)])
      .then(([defs, agentToolRows]) => {
        setAllTools(defs);
        const enabled = new Set(
          agentToolRows.filter((t) => t.isEnabled).map((t) => t.toolName),
        );
        setEnabledTools(enabled);
        setInitialEnabled(new Set(enabled));
      })
      .catch(() => toast("error", "Failed to load tools."))
      .finally(() => setLoading(false));
  }, [agentId]);

  // Track dirty state
  useEffect(() => {
    const isDirty =
      enabledTools.size !== initialEnabled.size ||
      [...enabledTools].some((t) => !initialEnabled.has(t));
    onDirty(isDirty);
  }, [enabledTools, initialEnabled, onDirty]);

  // Expose save function via ref
  saveRef.current = async () => {
    setSaving(true);
    try {
      const tools = allTools.map((t) => ({
        toolName: t.name,
        isEnabled: enabledTools.has(t.name),
      }));
      await rpc.setAgentTools(agentId, tools);
      setInitialEnabled(new Set(enabledTools));
      toast("success", "Tool assignments saved.");
    } catch {
      toast("error", "Failed to save tools.");
    } finally {
      setSaving(false);
    }
  };

  const toggle = useCallback((toolName: string) => {
    setEnabledTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) next.delete(toolName);
      else next.add(toolName);
      return next;
    });
  }, []);

  const toggleCategory = useCallback(
    (categoryTools: ToolDef[], allEnabled: boolean) => {
      setEnabledTools((prev) => {
        const next = new Set(prev);
        for (const t of categoryTools) {
          if (allEnabled) next.delete(t.name);
          else next.add(t.name);
        }
        return next;
      });
    },
    [],
  );

  const handleReset = useCallback(async () => {
    setSaving(true);
    try {
      await rpc.resetAgentTools(agentId);
      const agentToolRows = await rpc.getAgentTools(agentId);
      const enabled = new Set(
        agentToolRows.filter((t) => t.isEnabled).map((t) => t.toolName),
      );
      setEnabledTools(enabled);
      setInitialEnabled(new Set(enabled));
      toast("success", "Tools reset to defaults.");
    } catch {
      toast("error", "Failed to reset tools.");
    } finally {
      setSaving(false);
    }
  }, [agentId]);

  // Group tools by category, filtered by search
  const grouped = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = q
      ? allTools.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q) ||
            (CATEGORY_LABELS[t.category] ?? t.category).toLowerCase().includes(q),
        )
      : allTools;

    const map = new Map<string, ToolDef[]>();
    for (const t of filtered) {
      const list = map.get(t.category) ?? [];
      list.push(t);
      map.set(t.category, list);
    }
    return map;
  }, [allTools, search]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        Loading tools...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search tools..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-sm h-8"
        />
        <Tip content="Reset to defaults">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={saving}
            className="h-8 w-8 p-0 flex-shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </Button>
        </Tip>
      </div>

      <p className="text-xs text-muted-foreground">
        {enabledTools.size} of {allTools.length} tools enabled
      </p>

      <div className="max-h-[45vh] overflow-y-auto space-y-3 pr-1">
        {[...grouped.entries()].map(([category, tools]) => {
          const allEnabled = tools.every((t) => enabledTools.has(t.name));
          const someEnabled = tools.some((t) => enabledTools.has(t.name));
          return (
            <div key={category} className="rounded-lg border border-border overflow-hidden">
              {/* Category header */}
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-2 bg-muted/50 hover:bg-muted transition-colors"
                onClick={() => toggleCategory(tools, allEnabled)}
              >
                <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                  {CATEGORY_LABELS[category] ?? category}
                </span>
                <span className={`text-xs font-medium ${allEnabled ? "text-primary" : someEnabled ? "text-muted-foreground" : "text-muted-foreground/50"}`}>
                  {tools.filter((t) => enabledTools.has(t.name)).length}/{tools.length}
                </span>
              </button>
              {/* Tool rows */}
              <div className="divide-y divide-border">
                {tools.map((t) => (
                  <label
                    key={t.name}
                    className="flex items-center gap-3 px-3 py-1.5 hover:bg-muted/30 transition-colors cursor-pointer"
                  >
                    <Switch
                      checked={enabledTools.has(t.name)}
                      onCheckedChange={() => toggle(t.name)}
                      className="scale-75"
                    />
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-mono text-foreground">{t.name}</span>
                      {t.description && (
                        <p className="text-[10px] text-muted-foreground leading-tight line-clamp-1 mt-0.5">
                          {t.description}
                        </p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {grouped.size === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">No tools match your search.</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Settings Dialog
// ---------------------------------------------------------------------------

interface AgentSettingsDialogProps {
  agent: Agent | null;
  providers: Provider[];
  open: boolean;
  onClose: () => void;
  onSaved: (updated: Agent) => void;
}

function AgentSettingsDialog({
  agent,
  providers,
  open,
  onClose,
  onSaved,
}: AgentSettingsDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const [color, setColor] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState("");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [isEnabled, setIsEnabled] = useState(true);
  const [thinkingBudget, setThinkingBudget] = useState<string>("");
  const [useSystemPromptOnly, setUseSystemPromptOnly] = useState(false);
  const [chatEnabled, setChatEnabled] = useState(false);
  const [availableToPm, setAvailableToPm] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [activeTab, setActiveTab] = useState("settings");
  const [toolsDirty, setToolsDirty] = useState(false);
  const toolsSaveRef = useRef<(() => Promise<void>) | null>(null);

  // PM-specific settings state


  // Populate form when dialog opens with a new agent
  useEffect(() => {
    if (agent) {
      setDisplayName(agent.displayName);
      setColor(agent.color);
      setSystemPrompt(agent.systemPrompt);
      setProviderId(agent.providerId ?? "");
      setModelId(agent.modelId ?? "");
      setTemperature(agent.temperature ?? "");
      setMaxTokens(agent.maxTokens != null ? String(agent.maxTokens) : "");
      setIsEnabled(agent.isEnabled);
      setThinkingBudget(agent.thinkingBudget ?? "");
      setUseSystemPromptOnly(agent.useSystemPromptOnly);
      setChatEnabled(agent.chatEnabled);
      setAvailableToPm(agent.availableToPm);
      setActiveTab("settings");
      setToolsDirty(false);
    }
  }, [agent]);

  if (!agent) return null;

  async function handleSave() {
    if (!agent) return;
    setSaving(true);
    try {
      const result = await rpc.updateAgent({
        id: agent.id,
        displayName: displayName || undefined,
        color: color || undefined,
        systemPrompt,
        providerId: providerId || undefined,
        modelId: modelId || undefined,
        temperature: temperature || undefined,
        maxTokens: maxTokens ? parseInt(maxTokens, 10) : undefined,
        isEnabled,
        thinkingBudget: thinkingBudget || null,
        // Only persisted for non-built-in agents (UI hides these toggles otherwise,
        // so the stored values stay at their defaults for built-ins).
        useSystemPromptOnly: agent.isBuiltin ? undefined : useSystemPromptOnly,
        chatEnabled:         agent.isBuiltin ? undefined : chatEnabled,
        availableToPm:       agent.isBuiltin ? undefined : availableToPm,
      });
      if (!result.success) {
        toast("error", result.error || "Failed to save agent settings.");
        return; // keep the modal open so the user can fix the name; finally resets saving
      }

      // Save tool assignments if changed
      if (toolsDirty && toolsSaveRef.current) {
        await toolsSaveRef.current();
      }

      toast("success", "Agent settings saved.");
      onSaved({
        ...agent,
        displayName,
        color,
        systemPrompt,
        providerId: providerId || null,
        modelId: modelId || null,
        temperature: temperature || null,
        maxTokens: maxTokens ? parseInt(maxTokens, 10) : null,
        isEnabled,
        thinkingBudget: thinkingBudget || null,
        useSystemPromptOnly: agent.isBuiltin ? agent.useSystemPromptOnly : useSystemPromptOnly,
        chatEnabled:         agent.isBuiltin ? agent.chatEnabled         : chatEnabled,
        availableToPm:       agent.isBuiltin ? agent.availableToPm       : availableToPm,
      });
      onClose();
    } catch {
      toast("error", "Failed to save agent settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!agent) return;
    setResetting(true);
    try {
      const result = await rpc.resetAgent(agent.id);
      if (!result.success) {
        toast("error", result.error ?? "Reset failed.");
        return;
      }
      toast("success", "Agent reset to defaults.");
      const resetAgent: Agent = {
        ...agent,
        systemPrompt: "",
        providerId: null,
        modelId: null,
        temperature: null,
        maxTokens: null,
        isEnabled: true,
        thinkingBudget: null,
      };
      setSystemPrompt("");
      setProviderId("");
      setModelId("");
      setTemperature("");
      setMaxTokens("");
      setIsEnabled(true);
      setThinkingBudget("");
      onSaved(resetAgent);
    } catch {
      toast("error", "Failed to reset agent.");
    } finally {
      setResetting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3 pr-6">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0"
              style={{ backgroundColor: color || agent.color }}
            >
              {getInitials(displayName || agent.displayName)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <DialogTitle>{agent.displayName}</DialogTitle>
                {agent.isBuiltin ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">
                    <Zap className="w-2.5 h-2.5" />
                    Built-in
                  </span>
                ) : (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                    Custom
                  </span>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-2">
          <TabsList className="w-full">
            <TabsTrigger value="settings" className="flex-1">Settings</TabsTrigger>
            <TabsTrigger value="tools" className="flex-1">
              Tools{toolsDirty ? " *" : ""}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="settings" className="mt-3">
            <div className="flex flex-col gap-4">
              {/* Display Name */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-display-name">Display Name</Label>
                <Input
                  id="agent-display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Project Manager"
                />
              </div>

              {/* Color */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-color">Color</Label>
                <div className="flex items-center gap-2">
                  <label
                    className="w-8 h-8 rounded-full border border-input flex-shrink-0 overflow-hidden cursor-pointer"
                    style={{ backgroundColor: color || "#cccccc" }}
                  >
                    <input
                      type="color"
                      value={color || "#cccccc"}
                      onChange={(e) => setColor(e.target.value)}
                      className="opacity-0 w-full h-full cursor-pointer"
                    />
                  </label>
                  <Input
                    id="agent-color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    placeholder="#4f46e5"
                    className="font-mono"
                  />
                </div>
              </div>

              <Separator />

              {/* System Prompt */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-system-prompt">System Prompt</Label>
                <Textarea
                  id="agent-system-prompt"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Enter a custom system prompt, or leave empty to use the built-in default."
                  className="font-mono text-xs min-h-[9rem] resize-y"
                  rows={6}
                />
              </div>

              {/* Use this system prompt only — custom agents only */}
              {!agent.isBuiltin && (
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="agent-use-system-prompt-only" className="cursor-pointer">
                      Use this system prompt only
                    </Label>
                    <Tip content="If checked, agentdesk will not add internal code related prompts for this agent">
                      <span className="text-xs text-muted-foreground rounded-full border border-input w-4 h-4 flex items-center justify-center cursor-help select-none">?</span>
                    </Tip>
                  </div>
                  <Switch
                    id="agent-use-system-prompt-only"
                    checked={useSystemPromptOnly}
                    onCheckedChange={setUseSystemPromptOnly}
                  />
                </div>
              )}

              <Separator />

              {/* Provider */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-provider">AI Provider Override</Label>
                <Select
                  value={providerId || "__none__"}
                  onValueChange={(v) => setProviderId(v === "__none__" ? "" : v)}
                >
                  <SelectTrigger id="agent-provider">
                    <SelectValue placeholder="Use project / global default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Use project / global default</SelectItem>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Model */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-model">Model ID Override</Label>
                <Input
                  id="agent-model"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="e.g. claude-sonnet-4-20250514"
                  className="font-mono text-sm"
                />
              </div>

              {/* Temperature */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-temperature">Temperature</Label>
                <Input
                  id="agent-temperature"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(e.target.value)}
                  placeholder="0.0 – 2.0 (leave empty for default)"
                />
              </div>

              {/* Max Tokens */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-max-tokens">Max Tokens</Label>
                <Input
                  id="agent-max-tokens"
                  type="number"
                  min={1}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  placeholder="Leave empty for provider default"
                />
              </div>

              {/* Thinking Budget */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-thinking-budget">Thinking Budget</Label>
                <p className="text-xs text-muted-foreground">
                  Controls how much reasoning the model is allowed to do before responding.
                </p>
                <Select
                  value={thinkingBudget || "__none__"}
                  onValueChange={(v) => setThinkingBudget(v === "__none__" ? "" : v)}
                >
                  <SelectTrigger id="agent-thinking-budget">
                    <SelectValue placeholder="Default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Default</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Separator />

              {/* Enabled / Disabled toggle */}
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="agent-is-enabled">Agent Enabled</Label>
                  <p className="text-xs text-muted-foreground">
                    Disabled agents are excluded from orchestration runs.
                  </p>
                </div>
                <Switch
                  id="agent-is-enabled"
                  checked={isEnabled}
                  onCheckedChange={setIsEnabled}
                />
              </div>

              {/* Enable Chat — custom agents only */}
              {!agent.isBuiltin && (
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="agent-chat-enabled" className="cursor-pointer">
                    Enable Chat
                  </Label>
                  <Switch
                    id="agent-chat-enabled"
                    checked={chatEnabled}
                    onCheckedChange={setChatEnabled}
                  />
                </div>
              )}

              {/* Make Agent Available to PM — custom agents only */}
              {!agent.isBuiltin && (
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-col gap-0.5">
                    <Label htmlFor="agent-available-to-pm" className="cursor-pointer">
                      Make Agent Available to PM
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      When off, this agent is hidden from the PM and cannot be dispatched in orchestration runs.
                    </p>
                  </div>
                  <Switch
                    id="agent-available-to-pm"
                    checked={availableToPm}
                    onCheckedChange={setAvailableToPm}
                  />
                </div>
              )}

              {/* PM-Specific Settings */}
            </div>
          </TabsContent>

          <TabsContent value="tools" className="mt-3">
            {agent && (
              <AgentToolsTab
                agentId={agent.id}
                onDirty={setToolsDirty}
                saveRef={toolsSaveRef}
              />
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter className="gap-2 pt-2">
          {agent.isBuiltin && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting || saving}
              className="mr-auto"
            >
              {resetting ? "Resetting..." : "Reset to Defaults"}
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving || resetting}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || resetting}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create Agent Dialog
// ---------------------------------------------------------------------------

interface CreateAgentDialogProps {
  providers: Provider[];
  agents: Agent[];
  open: boolean;
  onClose: () => void;
  onCreated: (agent: Agent) => void;
}

function CreateAgentDialog({ providers, agents: existingAgents, open, onClose, onCreated }: CreateAgentDialogProps) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [color, setColor] = useState("#6366f1");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState("");
  const [copyToolsFrom, setCopyToolsFrom] = useState<string>("");
  const [useSystemPromptOnly, setUseSystemPromptOnly] = useState(false);
  const [chatEnabled, setChatEnabled] = useState(false);
  const [availableToPm, setAvailableToPm] = useState(true);
  const [saving, setSaving] = useState(false);

  function resetForm() {
    setName("");
    setDisplayName("");
    setColor("#6366f1");
    setSystemPrompt("");
    setProviderId("");
    setModelId("");
    setCopyToolsFrom("");
    setUseSystemPromptOnly(false);
    setChatEnabled(false);
    setAvailableToPm(true);
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  async function handleCreate() {
    if (!name.trim() || !displayName.trim()) {
      toast("error", "Name and Display Name are required.");
      return;
    }
    setSaving(true);
    try {
      const result = await rpc.createAgent({
        name: name.trim(),
        displayName: displayName.trim(),
        color: color.trim() || "#6366f1",
        systemPrompt,
        providerId: providerId || undefined,
        modelId: modelId || undefined,
        useSystemPromptOnly,
        chatEnabled,
        availableToPm,
      });
      if (!result.success || !result.id) {
        toast("error", result.error || "Failed to create agent.");
        return;
      }

      // Copy tools from selected source agent
      if (copyToolsFrom) {
        try {
          const sourceTools = await rpc.getAgentTools(copyToolsFrom);
          if (sourceTools.length > 0) {
            await rpc.setAgentTools(result.id, sourceTools);
          }
        } catch {
          // Non-critical — agent is created, tools just didn't copy
          toast("error", "Agent created but failed to copy tools.");
        }
      }

      toast("success", `Agent "${displayName}" created.`);
      onCreated({
        id: result.id,
        name: name.trim(),
        displayName: displayName.trim(),
        color: color.trim() || "#6366f1",
        isBuiltin: false,
        systemPrompt,
        providerId: providerId || null,
        modelId: modelId || null,
        temperature: null,
        maxTokens: null,
        isEnabled: true,
        thinkingBudget: null,
        useSystemPromptOnly,
        chatEnabled,
        availableToPm,
      });
      handleClose();
    } catch {
      toast("error", "Failed to create agent.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Custom Agent</DialogTitle>
        </DialogHeader>

        <Separator />

        <div className="flex flex-col gap-4">
          {/* Name (slug) */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-agent-name">Name (slug)</Label>
            <p className="text-xs text-muted-foreground">
              Lowercase identifier with hyphens, e.g. "my-custom-agent"
            </p>
            <Input
              id="create-agent-name"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="my-custom-agent"
              className="font-mono"
            />
          </div>

          {/* Display Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-agent-display-name">Display Name</Label>
            <Input
              id="create-agent-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. My Custom Agent"
            />
          </div>

          {/* Color */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-agent-color">Color</Label>
            <div className="flex items-center gap-2">
              <label
                className="w-8 h-8 rounded-full border border-input flex-shrink-0 overflow-hidden cursor-pointer"
                style={{ backgroundColor: color || "#cccccc" }}
              >
                <input
                  type="color"
                  value={color || "#cccccc"}
                  onChange={(e) => setColor(e.target.value)}
                  className="opacity-0 w-full h-full cursor-pointer"
                />
              </label>
              <Input
                id="create-agent-color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#6366f1"
                className="font-mono"
              />
            </div>
          </div>

          <Separator />

          {/* System Prompt */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-agent-system-prompt">System Prompt</Label>
            <Textarea
              id="create-agent-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Describe what this agent should do..."
              className="font-mono text-xs min-h-[9rem] resize-y"
              rows={6}
            />
          </div>

          {/* Use this system prompt only */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="create-agent-use-system-prompt-only" className="cursor-pointer">
                Use this system prompt only
              </Label>
              <Tip content="If checked, agentdesk will not add internal code related prompts for this agent">
                <span className="text-xs text-muted-foreground rounded-full border border-input w-4 h-4 flex items-center justify-center cursor-help select-none">?</span>
              </Tip>
            </div>
            <Switch
              id="create-agent-use-system-prompt-only"
              checked={useSystemPromptOnly}
              onCheckedChange={setUseSystemPromptOnly}
            />
          </div>

          <Separator />

          {/* Provider */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-agent-provider">AI Provider</Label>
            <Select
              value={providerId || "__none__"}
              onValueChange={(v) => setProviderId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger id="create-agent-provider">
                <SelectValue placeholder="Use project / global default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Use project / global default</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-agent-model">Model ID</Label>
            <Input
              id="create-agent-model"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="e.g. claude-sonnet-4-20250514"
              className="font-mono text-sm"
            />
          </div>

          <Separator />

          {/* Copy tools from existing agent */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-agent-copy-tools">Copy Tools From</Label>
            <p className="text-xs text-muted-foreground">
              Clone another agent's tool set. Leave empty to get all tools.
            </p>
            <Select
              value={copyToolsFrom || "__none__"}
              onValueChange={(v) => setCopyToolsFrom(v === "__none__" ? "" : v)}
            >
              <SelectTrigger id="create-agent-copy-tools">
                <SelectValue placeholder="None (all tools enabled)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None (all tools enabled)</SelectItem>
                {existingAgents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* Enable Chat */}
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="create-agent-chat-enabled" className="cursor-pointer">
              Enable Chat
            </Label>
            <Switch
              id="create-agent-chat-enabled"
              checked={chatEnabled}
              onCheckedChange={setChatEnabled}
            />
          </div>

          {/* Make Agent Available to PM */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="create-agent-available-to-pm" className="cursor-pointer">
                Make Agent Available to PM
              </Label>
              <p className="text-xs text-muted-foreground">
                When off, this agent is hidden from the PM and cannot be dispatched in orchestration runs.
              </p>
            </div>
            <Switch
              id="create-agent-available-to-pm"
              checked={availableToPm}
              onCheckedChange={setAvailableToPm}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button variant="outline" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={saving}>
            {saving ? "Creating..." : "Create Agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete Confirmation Dialog
// ---------------------------------------------------------------------------

interface DeleteAgentDialogProps {
  agent: Agent | null;
  open: boolean;
  onClose: () => void;
  onDeleted: (id: string) => void;
}

function DeleteAgentDialog({ agent, open, onClose, onDeleted }: DeleteAgentDialogProps) {
  const [deleting, setDeleting] = useState(false);

  if (!agent) return null;

  async function handleDelete() {
    if (!agent) return;
    setDeleting(true);
    try {
      const result = await rpc.deleteAgent(agent.id);
      if (!result.success) {
        toast("error", result.error ?? "Failed to delete agent.");
        return;
      }
      toast("success", `Agent "${agent.displayName}" deleted.`);
      onDeleted(agent.id);
      onClose();
    } catch {
      toast("error", "Failed to delete agent.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete Agent</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Are you sure you want to delete <span className="font-semibold text-foreground">{agent.displayName}</span>? This action cannot be undone.
        </p>
        <DialogFooter className="gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Agent Card
// ---------------------------------------------------------------------------

interface AgentCardProps {
  agent: Agent;
  onClick: () => void;
  onDelete?: () => void;
}

function AgentCard({ agent, onClick, onDelete }: AgentCardProps) {
  return (
    <div className={`group relative bg-card rounded-2xl border-2 border-border hover:border-primary/40 transition-all${agent.isEnabled ? "" : " opacity-50"}`}>
      <button
        type="button"
        className="p-4 cursor-pointer text-left w-full"
        onClick={onClick}
      >
        <div className="flex items-start gap-3">
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0"
            style={{ backgroundColor: agent.color }}
          >
            {getInitials(agent.displayName)}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-foreground truncate text-sm">
              {agent.displayName}
            </h3>
            <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
              {agent.isBuiltin ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">
                  <Zap className="w-2.5 h-2.5" />
                  Built-in
                </span>
              ) : (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                  Custom
                </span>
              )}
              {!agent.isEnabled && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                  Disabled
                </span>
              )}
            </div>
          </div>
        </div>

        {agent.systemPrompt && (
          <p className="mt-3 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {agent.systemPrompt}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {agent.providerId && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              Provider override
            </span>
          )}
          {agent.modelId && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono truncate max-w-[10rem]">
              {agent.modelId}
            </span>
          )}
          {agent.temperature && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              temp: {agent.temperature}
            </span>
          )}
          {agent.thinkingBudget && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              thinking: {agent.thinkingBudget}
            </span>
          )}
        </div>
      </button>

      {/* Delete button — only visible on custom agents, shown on hover */}
      {!agent.isBuiltin && onDelete && (
        <Tip content="Delete agent">
          <button
            type="button"
            className="absolute top-3 right-3 p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </Tip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function AgentCardSkeleton() {
  return (
    <div className="bg-card rounded-2xl border border-border p-4 space-y-3 animate-pulse">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-full bg-muted flex-shrink-0" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-3.5 bg-muted rounded w-3/4" />
          <div className="h-3 bg-muted rounded w-1/2" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agents Page
// ---------------------------------------------------------------------------

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  useEffect(() => {
    Promise.all([rpc.getAgents(), rpc.getProviders()])
      .then(([agentData, providerData]) => {
        setAgents(agentData as Agent[]);
        setProviders(providerData);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  function openDialog(agent: Agent) {
    setSelectedAgent(agent);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setSelectedAgent(null);
  }

  function handleSaved(updated: Agent) {
    setAgents((prev) =>
      prev.map((a) => (a.id === updated.id ? updated : a))
    );
  }

  function openDeleteDialog(agent: Agent) {
    setDeleteTarget(agent);
    setDeleteDialogOpen(true);
  }

  function closeDeleteDialog() {
    setDeleteDialogOpen(false);
    setDeleteTarget(null);
  }

  function handleDeleted(id: string) {
    setAgents((prev) => prev.filter((a) => a.id !== id));
  }

  function handleCreated(agent: Agent) {
    setAgents((prev) => [...prev, agent]);
  }

  const builtinAgents = agents.filter((a) => a.isBuiltin);
  const customAgents = agents.filter((a) => !a.isBuiltin);

  useHeaderActions(
    () => (
      <Button onClick={() => setCreateDialogOpen(true)}>
        <Plus className="w-4 h-4" />
        Add Custom Agent
      </Button>
    ),
    [],
  );

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 13 }).map((_, i) => (
            <AgentCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <>
          {builtinAgents.length > 0 && (
            <section className="mb-8">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Built-in Agents ({builtinAgents.length})
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {builtinAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onClick={() => openDialog(agent)}
                  />
                ))}
              </div>
            </section>
          )}

          {customAgents.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Custom Agents
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {customAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onClick={() => openDialog(agent)}
                    onDelete={() => openDeleteDialog(agent)}
                  />
                ))}
              </div>
            </section>
          )}

          {agents.length === 0 && (
            <div className="text-center py-16 text-muted-foreground">
              <p>No agents found.</p>
            </div>
          )}
        </>
      )}

      <AgentSettingsDialog
        agent={selectedAgent}
        providers={providers}
        open={dialogOpen}
        onClose={closeDialog}
        onSaved={handleSaved}
      />

      <CreateAgentDialog
        providers={providers}
        agents={agents}
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={handleCreated}
      />

      <DeleteAgentDialog
        agent={deleteTarget}
        open={deleteDialogOpen}
        onClose={closeDeleteDialog}
        onDeleted={handleDeleted}
      />
    </div>
  );
}
