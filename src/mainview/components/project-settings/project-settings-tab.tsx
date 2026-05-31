import { useState, useEffect, useCallback } from "react";
import { useChatStore } from "@/stores/chat-store";
import { useKanbanStore } from "@/stores/kanban-store";
import { useNavigate } from "@tanstack/react-router";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FolderOpen } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Copy, Eye, EyeOff } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectData {
  id: string;
  name: string;
  description: string | null;
  status: string;
  workspacePath: string;
  githubUrl: string | null;
  workingBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GeneralForm {
  name: string;
  description: string;
  status: string;
  workspacePath: string;
  githubUrl: string;
  workingBranch: string;
}

interface AiForm {
  providerId: string;
  modelOverride: string;
  thinkingBudget: string;
  shellApprovalMode: string;
  allowedShellPatterns: string;
  sessionSummarizationThreshold: string;
  contextWindowLimit: string;
  agentKnowledge: string;
  autoExecuteNextTask: string;
  devServerUrl: string;
}

interface ProviderItem {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string | null;
  defaultModel: string | null;
  isDefault: boolean;
  isValid: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const AI_FORM_DEFAULTS: AiForm = {
  providerId: "",
  modelOverride: "",
  thinkingBudget: "medium",
  shellApprovalMode: "ask",
  allowedShellPatterns: "",
  sessionSummarizationThreshold: "200000",
  contextWindowLimit: "1000000",
  agentKnowledge: "true",
  autoExecuteNextTask: "true",
  devServerUrl: "",
};

// ---------------------------------------------------------------------------
// FieldRow — label + control in a two-column layout (matches settings/general)
// ---------------------------------------------------------------------------

interface FieldRowProps {
  id: string;
  label: string;
  description?: string;
  children: React.ReactNode;
}

function FieldRow({ id, label, description, children }: FieldRowProps) {
  return (
    <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[240px_1fr]">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="w-full max-w-xs">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeleteConfirmDialog — requires user to type project name before deleting
// ---------------------------------------------------------------------------

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  onConfirm: () => Promise<void>;
}

function DeleteConfirmDialog({
  open,
  onOpenChange,
  projectName,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const [inputValue, setInputValue] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Reset input whenever dialog opens
  useEffect(() => {
    if (open) setInputValue("");
  }, [open]);

  const isMatch = inputValue === projectName;

  async function handleConfirm() {
    if (!isMatch) return;
    setDeleting(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Project</DialogTitle>
          <DialogDescription>
            This action is permanent and cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>The following will be permanently deleted:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>All conversations and messages</li>
            <li>All kanban tasks and activity</li>
            <li>All docs</li>
            <li>All deploy environments and history</li>
            <li>All project settings</li>
          </ul>
          <p>
            Type{" "}
            <span className="font-semibold text-foreground">{projectName}</span>{" "}
            to confirm deletion.
          </p>
        </div>
        <div className="py-2">
          <Input
            id="delete-confirm-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={projectName}
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!isMatch || deleting}
          >
            {deleting ? "Deleting..." : "Delete Project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ResetConfirmDialog
// ---------------------------------------------------------------------------

function ResetConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [resetting, setResetting] = useState(false);

  async function handleConfirm() {
    setResetting(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setResetting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset Project Data</DialogTitle>
          <DialogDescription>
            This will permanently erase all project data. The project itself will remain.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>The following will be permanently deleted:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>All conversations and messages</li>
            <li>All kanban tasks and activity</li>
            <li>All docs</li>
            <li>All deploy environments and history</li>
            <li>All pull requests and GitHub issues</li>
            <li>All inbox messages</li>
            <li>Cron job history (job definitions kept)</li>
          </ul>
          <p className="font-medium text-foreground">This cannot be undone.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={resetting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={resetting}>
            {resetting ? "Resetting..." : "Reset All Data"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// GeneralTab
// ---------------------------------------------------------------------------

interface GeneralTabProps {
  project: ProjectData;
  onProjectUpdated: (updated: ProjectData) => void;
}

function GeneralTab({ project, onProjectUpdated }: GeneralTabProps) {
  const navigate = useNavigate();
  const [form, setForm] = useState<GeneralForm>({
    name: project.name,
    description: project.description ?? "",
    status: project.status,
    workspacePath: project.workspacePath,
    githubUrl: project.githubUrl ?? "",
    workingBranch: project.workingBranch ?? "",
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [browsingDir, setBrowsingDir] = useState(false);

  // Keep form in sync if project prop changes (e.g. after a save)
  useEffect(() => {
    setForm({
      name: project.name,
      description: project.description ?? "",
      status: project.status,
      workspacePath: project.workspacePath,
      githubUrl: project.githubUrl ?? "",
      workingBranch: project.workingBranch ?? "",
    });
    setDirty(false);
  }, [project]);

  function handleChange<K extends keyof GeneralForm>(
    key: K,
    value: GeneralForm[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function handleBrowse() {
    setBrowsingDir(true);

    // Listen for the result event (fire-and-forget pattern)
    function onResult(e: Event) {
      const { path } = (e as CustomEvent<{ path: string | null }>).detail;
      window.removeEventListener("agentdesk:directory-selected", onResult);
      setBrowsingDir(false);
      if (path) {
        handleChange("workspacePath", path);
      }
    }

    window.addEventListener("agentdesk:directory-selected", onResult);
    rpc.selectDirectory().catch(() => {
      window.removeEventListener("agentdesk:directory-selected", onResult);
      setBrowsingDir(false);
      toast("error", "Failed to open directory picker.");
    });
  }

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await rpc.updateProject({
        id: project.id,
        name: form.name,
        description: form.description || undefined,
        status: form.status,
        workspacePath: form.workspacePath,
        githubUrl: form.githubUrl || undefined,
        workingBranch: form.workingBranch || undefined,
      });
      if (!res.success) {
        toast("error", res.error ?? "Failed to save project settings.");
        return;
      }
      onProjectUpdated({
        ...project,
        name: form.name,
        description: form.description || null,
        status: form.status,
        workspacePath: form.workspacePath,
        githubUrl: form.githubUrl || null,
        workingBranch: form.workingBranch || null,
      });
      setDirty(false);
      toast("success", "Project settings saved.");
    } catch {
      toast("error", "Failed to save project settings.");
    } finally {
      setSaving(false);
    }
  }, [form, project, onProjectUpdated]);

  const handleDelete = useCallback(async () => {
    await rpc.deleteProjectCascade(project.id);
    toast("success", "Project deleted.");
    navigate({ to: "/" });
  }, [project.id, navigate]);

  const handleReset = useCallback(async () => {
    await rpc.resetProjectData(project.id);

    // Clear both Zustand stores immediately — ProjectPage stays mounted for the
    // same projectId so navigate() alone won't trigger their reload effects.
    useChatStore.getState().reset();
    useKanbanStore.getState().reset();

    // Create a fresh empty conversation so the chat tab has something to show.
    // loadConversations is insufficient here because conversationsLoaded in
    // ProjectPage won't toggle (projectId didn't change), so its auto-create
    // useEffect won't re-run.
    const newConvId = await useChatStore.getState().createConversation(project.id);
    useChatStore.getState().setActiveConversation(newConvId);

    toast("success", "Project data reset. All conversations and tasks have been cleared.");
    navigate({ to: "/project/$projectId", params: { projectId: project.id } });
    window.dispatchEvent(new CustomEvent("agentdesk:switch-tab", { detail: { tab: "chat" } }));
    // Trigger files-tab and notes-tab to reload immediately without requiring navigation
    window.dispatchEvent(new CustomEvent("agentdesk:stream-complete"));
  }, [project.id, navigate]);

  return (
    <div className="space-y-6">
      {/* General info */}
      <Card>
        <CardHeader>
          <CardTitle>Project Info</CardTitle>
          <CardDescription>
            Basic metadata for this project.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FieldRow
            id="proj-name"
            label="Project Name"
            description="The display name shown in the sidebar."
          >
            <Input
              id="proj-name"
              value={form.name}
              onChange={(e) => handleChange("name", e.target.value)}
              placeholder="My Project"
            />
          </FieldRow>

          <Separator />

          <FieldRow
            id="proj-description"
            label="Description"
            description="A short summary of what this project is."
          >
            <Textarea
              id="proj-description"
              value={form.description}
              onChange={(e) => handleChange("description", e.target.value)}
              placeholder="Describe your project..."
              rows={3}
            />
          </FieldRow>

          <Separator />

          <FieldRow
            id="proj-status"
            label="Status"
            description="Current lifecycle status of the project."
          >
            <Select
              value={form.status}
              onValueChange={(v) => handleChange("status", v)}
            >
              <SelectTrigger id="proj-status" className="w-full">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="idle">Idle</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          <Separator />

          <FieldRow
            id="proj-workspace"
            label="Workspace Path"
            description="The local directory for this project."
          >
            <div className="flex gap-2 w-full max-w-xs">
              <Input
                id="proj-workspace"
                value={form.workspacePath}
                onChange={(e) => handleChange("workspacePath", e.target.value)}
                placeholder="/path/to/workspace"
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleBrowse}
                disabled={browsingDir}
                aria-label="Browse for workspace directory"
              >
                <FolderOpen aria-hidden="true" />
              </Button>
            </div>
          </FieldRow>

          <Separator />

          <FieldRow
            id="proj-github-url"
            label="GitHub Repository URL"
            description="Optional link to the remote repository."
          >
            <Input
              id="proj-github-url"
              value={form.githubUrl}
              onChange={(e) => handleChange("githubUrl", e.target.value)}
              placeholder="https://github.com/org/repo"
            />
          </FieldRow>

          <Separator />

          <FieldRow
            id="proj-branch"
            label="Working Branch"
            description="The default branch agents check out when working."
          >
            <Input
              id="proj-branch"
              value={form.workingBranch}
              onChange={(e) => handleChange("workingBranch", e.target.value)}
              placeholder="main"
            />
          </FieldRow>
        </CardContent>
      </Card>

      {/* Save footer */}
      <div className="flex items-center justify-end gap-3">
        <p
          className={cn(
            "text-xs text-muted-foreground transition-opacity duration-150",
            dirty ? "opacity-100" : "opacity-0",
          )}
          aria-live="polite"
        >
          You have unsaved changes.
        </p>
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      {/* Danger zone */}
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>
            These actions are irreversible. Please be certain before proceeding.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Reset project data</p>
              <p className="text-xs text-muted-foreground">
                Clears all conversations, tasks, docs, deploy history, inbox,
                and activity. The project itself and its settings are kept.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0"
              onClick={() => setResetDialogOpen(true)}
            >
              Reset Data
            </Button>
          </div>
          <Separator />
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Delete this project</p>
              <p className="text-xs text-muted-foreground">
                Permanently removes the project along with all conversations,
                tasks, docs, deploy environments, and settings. This cannot be
                undone.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0"
              onClick={() => setDeleteDialogOpen(true)}
            >
              Delete Project
            </Button>
          </div>
        </CardContent>
      </Card>

      <ResetConfirmDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        onConfirm={handleReset}
      />
      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        projectName={project.name}
        onConfirm={handleDelete}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AiTab
// ---------------------------------------------------------------------------

interface AiTabProps {
  projectId: string;
  providers: ProviderItem[];
  initialSettings: Record<string, string>;
}

function AiTab({ projectId, providers, initialSettings }: AiTabProps) {
  const [form, setForm] = useState<AiForm>(() => ({
    providerId: initialSettings.providerId ?? AI_FORM_DEFAULTS.providerId,
    modelOverride: initialSettings.modelOverride ?? AI_FORM_DEFAULTS.modelOverride,
    thinkingBudget:
      initialSettings.thinkingBudget ?? AI_FORM_DEFAULTS.thinkingBudget,
    shellApprovalMode:
      initialSettings.shellApprovalMode ?? AI_FORM_DEFAULTS.shellApprovalMode,
    allowedShellPatterns:
      initialSettings.allowedShellPatterns ??
      AI_FORM_DEFAULTS.allowedShellPatterns,
    sessionSummarizationThreshold:
      initialSettings.sessionSummarizationThreshold ??
      AI_FORM_DEFAULTS.sessionSummarizationThreshold,
    contextWindowLimit:
      initialSettings.contextWindowLimit ??
      AI_FORM_DEFAULTS.contextWindowLimit,
    agentKnowledge:
      initialSettings.agentKnowledge ?? AI_FORM_DEFAULTS.agentKnowledge,
    autoExecuteNextTask:
      initialSettings.autoExecuteNextTask ?? AI_FORM_DEFAULTS.autoExecuteNextTask,
    devServerUrl:
      initialSettings.devServerUrl ?? AI_FORM_DEFAULTS.devServerUrl,
  }));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  function handleChange<K extends keyof AiForm>(key: K, value: AiForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await Promise.all(
        (Object.entries(form) as [keyof AiForm, string][]).map(([key, value]) =>
          rpc.saveProjectSetting(projectId, key, value),
        ),
      );
      setDirty(false);
      toast("success", "AI settings saved.");
    } catch {
      toast("error", "Failed to save AI settings.");
    } finally {
      setSaving(false);
    }
  }, [form, projectId]);

  return (
    <div className="space-y-6">
      {/* Model */}
      <Card>
        <CardHeader>
          <CardTitle>Model Override</CardTitle>
          <CardDescription>
            Override the global AI provider and model for this project.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FieldRow
            id="ai-provider"
            label="Provider"
            description="Use a specific provider for this project (overrides global default)."
          >
            <Select
              value={form.providerId || "__none__"}
              onValueChange={(v) => handleChange("providerId", v === "__none__" ? "" : v)}
            >
              <SelectTrigger id="ai-provider" className="w-full">
                <SelectValue placeholder="Inherit global default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Inherit global default</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

          <Separator />

          <FieldRow
            id="ai-model"
            label="Model"
            description="Model identifier to use (e.g. claude-opus-4-6)."
          >
            <Input
              id="ai-model"
              value={form.modelOverride}
              onChange={(e) => handleChange("modelOverride", e.target.value)}
              placeholder="Inherit from provider"
            />
          </FieldRow>
        </CardContent>
      </Card>

      {/* Agent behaviour */}
      <Card>
        <CardHeader>
          <CardTitle>Agent Behaviour</CardTitle>
          <CardDescription>
            Control thinking, prompt configuration, and agent behaviour.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FieldRow
            id="ai-thinking"
            label="Thinking Budget"
            description="How much reasoning time agents are allowed per step."
          >
            <Select
              value={form.thinkingBudget}
              onValueChange={(v) => handleChange("thinkingBudget", v)}
            >
              <SelectTrigger id="ai-thinking" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </CardContent>
      </Card>

      {/* Safety */}
      <Card>
        <CardHeader>
          <CardTitle>Safety Settings</CardTitle>
          <CardDescription>
            Define approval policies, timeouts, and restrictions for agents in
            this project.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FieldRow
            id="ai-shell-approval"
            label="Shell Approval Mode"
            description="Whether shell commands require approval before running."
          >
            <Select
              value={form.shellApprovalMode}
              onValueChange={(v) => handleChange("shellApprovalMode", v)}
            >
              <SelectTrigger id="ai-shell-approval" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">Always Ask</SelectItem>
                <SelectItem value="auto">Auto-Approve</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          <Separator />

          <FieldRow
            id="ai-shell-patterns"
            label="Allowed Shell Patterns"
            description="Glob/regex patterns for commands that may run without approval (one per line)."
          >
            <Textarea
              id="ai-shell-patterns"
              value={form.allowedShellPatterns}
              onChange={(e) =>
                handleChange("allowedShellPatterns", e.target.value)
              }
              placeholder={"git status\nbun run *\nnpm test"}
              rows={4}
              className="font-mono text-xs"
            />
          </FieldRow>

          <Separator />

          <FieldRow
            id="ai-session-summarization-threshold"
            label="Session Summarization Threshold"
            description="Token count at which agent session history is summarized to keep context manageable. Lower = more frequent summarization."
          >
            <Input
              id="ai-session-summarization-threshold"
              type="number"
              min={5000}
              max={200000}
              step={5000}
              value={form.sessionSummarizationThreshold}
              onChange={(e) => {
                handleChange("sessionSummarizationThreshold", e.target.value);
              }}
              onBlur={(e) => {
                const raw = parseInt(e.target.value, 10);
                const clamped = Number.isNaN(raw) || raw < 5000
                  ? 200000
                  : Math.min(500000, raw);
                handleChange("sessionSummarizationThreshold", String(clamped));
              }}
            />
          </FieldRow>

          <Separator />

          <FieldRow
            id="ai-context-window-limit"
            label="Context Window Limit"
            description="Max context window (tokens) for agents. Agents compact history when approaching this limit. Default: 1,000,000."
          >
            <Input
              id="ai-context-window-limit"
              type="number"
              min={10000}
              step={100000}
              value={form.contextWindowLimit}
              onChange={(e) => handleChange("contextWindowLimit", e.target.value)}
              placeholder="1000000"
            />
          </FieldRow>


          <Separator />

          <FieldRow
            id="ai-agent-knowledge"
            label="Auto-update project knowledge"
            description="When enabled, worker agents automatically update project-knowledge docs when their changes invalidate existing content (e.g. new dependencies, changed architecture). Knowledge docs are always visible to agents regardless of this setting."
          >
            <Switch
              id="ai-agent-knowledge"
              checked={form.agentKnowledge === "true"}
              onCheckedChange={(checked) =>
                handleChange("agentKnowledge", checked ? "true" : "false")
              }
            />
          </FieldRow>

          <Separator />

          <FieldRow
            id="ai-auto-execute-next-task"
            label="Auto-execute next task"
            description="When a task passes code review and moves to done, automatically dispatch the next task without waiting for a 'continue' command."
          >
            <Switch
              id="ai-auto-execute-next-task"
              checked={form.autoExecuteNextTask === "true"}
              onCheckedChange={(checked) =>
                handleChange("autoExecuteNextTask", checked ? "true" : "false")
              }
            />
          </FieldRow>

          <Separator />

          <FieldRow
            id="ai-dev-server-url"
            label="Dev Server URL"
            description="URL of the running dev server (e.g. http://localhost:3000). Used by take_screenshot tool for visual verification."
          >
            <Input
              id="ai-dev-server-url"
              value={form.devServerUrl}
              onChange={(e) => handleChange("devServerUrl", e.target.value)}
              placeholder="e.g. http://localhost:3000"
            />
          </FieldRow>
        </CardContent>
      </Card>

      {/* Save footer */}
      <div className="flex items-center justify-end gap-3">
        <p
          className={cn(
            "text-xs text-muted-foreground transition-opacity duration-150",
            dirty ? "opacity-100" : "opacity-0",
          )}
          aria-live="polite"
        >
          You have unsaved changes.
        </p>
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save AI Settings"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IntegrationsTab
// ---------------------------------------------------------------------------

interface IntegrationsTabProps {
  projectId: string;
  initialSettings: Record<string, string>;
}

function IntegrationsTab({ projectId, initialSettings }: IntegrationsTabProps) {
  const webhookUrl = `${window.location.origin}/api/webhooks/github/${projectId}`;

  const [webhookSecret, setWebhookSecret] = useState<string>(
    initialSettings.webhookSecret ?? "",
  );
  const [showSecret, setShowSecret] = useState(false);

  // Generate and persist webhook secret if not already set
  useEffect(() => {
    if (!initialSettings.webhookSecret) {
      const generated = crypto.randomUUID();
      setWebhookSecret(generated); // eslint-disable-line react-hooks/set-state-in-effect
      rpc.saveProjectSetting(projectId, "webhookSecret", generated).catch(() => {
        toast("error", "Failed to save webhook secret.");
      });
    }
  }, [projectId, initialSettings.webhookSecret]);

  function copyToClipboard(value: string, label: string) {
    navigator.clipboard.writeText(value).then(
      () => toast("success", `${label} copied to clipboard.`),
      () => toast("error", `Failed to copy ${label}.`),
    );
  }

  return (
    <div className="space-y-6">
      {/* GitHub Webhook */}
      <Card>
        <CardHeader>
          <CardTitle>GitHub Webhook</CardTitle>
          <CardDescription>
            Configure GitHub to send events to this project via webhook.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FieldRow
            id="webhook-url"
            label="Webhook URL"
            description="Add this URL as a GitHub webhook payload URL for your repository."
          >
            <div className="flex items-center gap-2 w-full max-w-xs">
              <Input
                id="webhook-url"
                value={webhookUrl}
                readOnly
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(webhookUrl, "Webhook URL")}
                aria-label="Copy webhook URL"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </FieldRow>

          <Separator />

          <FieldRow
            id="webhook-secret"
            label="Webhook Secret"
            description="Use this secret in GitHub's webhook configuration to verify requests."
          >
            <div className="flex items-center gap-2 w-full max-w-xs">
              <Input
                id="webhook-secret"
                type={showSecret ? "text" : "password"}
                value={webhookSecret}
                readOnly
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowSecret((prev) => !prev)}
                aria-label={showSecret ? "Hide webhook secret" : "Show webhook secret"}
              >
                {showSecret ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(webhookSecret, "Webhook secret")}
                aria-label="Copy webhook secret"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </FieldRow>

          <Separator />

          <FieldRow
            id="github-auth-status"
            label="GitHub Status"
            description="Whether GitHub integration is configured for this project."
          >
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "size-2.5 rounded-full",
                  webhookSecret ? "bg-green-500" : "bg-yellow-500",
                )}
              />
              <span className="text-sm text-muted-foreground">
                {webhookSecret ? "Webhook configured" : "Pending setup"}
              </span>
            </div>
          </FieldRow>
        </CardContent>
      </Card>

    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectSettingsTab — the exported component
// ---------------------------------------------------------------------------

interface ProjectSettingsTabProps {
  projectId: string;
}

export function ProjectSettingsTab({ projectId }: ProjectSettingsTabProps) {
  const [project, setProject] = useState<ProjectData | null>(null);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [projectSettings, setProjectSettings] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [proj, provs, ps] = await Promise.all([
          rpc.getProject(projectId),
          rpc.getProviders(),
          rpc.getProjectSettings(projectId),
        ]);
        if (cancelled) return;
        setProject(proj);
        setProviders(provs);
        setProjectSettings(ps);
      } catch {
        if (!cancelled) toast("error", "Failed to load project settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading settings...</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-32 items-center justify-center">
        <p className="text-sm text-muted-foreground">Project not found.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">
            Project Settings
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure project-specific overrides for{" "}
            <span className="font-medium">{project.name}</span>.
          </p>
        </div>

        <Tabs defaultValue="general">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="ai">AI</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="pt-4">
            <GeneralTab
              project={project}
              onProjectUpdated={setProject}
            />
          </TabsContent>

          <TabsContent value="ai" className="pt-4">
            <AiTab
              projectId={projectId}
              providers={providers}
              initialSettings={projectSettings}
            />
          </TabsContent>

          <TabsContent value="integrations" className="pt-4">
            <IntegrationsTab
              projectId={projectId}
              initialSettings={projectSettings}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
