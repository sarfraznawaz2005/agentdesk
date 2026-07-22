import { useState, useEffect, useCallback } from "react";
import { useChatStore } from "@/stores/chat-store";
import { useKanbanStore } from "@/stores/kanban-store";
import { useNavigate } from "@tanstack/react-router";
import { rpc } from "@/lib/rpc";
import { IS_REMOTE } from "@/lib/remote-transport";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FolderOpen, Download, Check } from "lucide-react";
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
  shellApprovalMode: string;
  sessionSummarizationThreshold: string;
  contextWindowLimit: string;
  agentKnowledge: string;
  autoExecuteNextTask: string;
  devServerUrl: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const AI_FORM_DEFAULTS: AiForm = {
  shellApprovalMode: "ask",
  sessionSummarizationThreshold: "200000", // deprecated — no longer surfaced in UI or used by the engine
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
  projectId: string;
  projectName: string;
  onConfirm: () => Promise<void>;
}

function DeleteConfirmDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const [inputValue, setInputValue] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [activeAgentNames, setActiveAgentNames] = useState<string[]>([]);

  // Reset input whenever dialog opens, and check whether any agents are
  // currently working in this project so we can warn before they get stopped.
  useEffect(() => {
    if (!open) return;
    setInputValue("");
    let cancelled = false;
    rpc
      .getRunningAgents(projectId)
      .then((agents) => {
        if (!cancelled) setActiveAgentNames(agents.map((a) => a.displayName));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

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
          {activeAgentNames.length > 0 && (
            <p className="font-medium text-amber-600 dark:text-amber-500">
              {activeAgentNames.length} agent{activeAgentNames.length > 1 ? "s are" : " is"} currently
              working in this project ({activeAgentNames.join(", ")}) and will be stopped.
            </p>
          )}
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
  projectId,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  onConfirm: () => Promise<void>;
}) {
  const [resetting, setResetting] = useState(false);
  const [activeAgentNames, setActiveAgentNames] = useState<string[]>([]);

  // Check whether any agents are currently working in this project so we can
  // warn before they get stopped.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    rpc
      .getRunningAgents(projectId)
      .then((agents) => {
        if (!cancelled) setActiveAgentNames(agents.map((a) => a.displayName));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

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
          {activeAgentNames.length > 0 && (
            <p className="font-medium text-amber-600 dark:text-amber-500">
              {activeAgentNames.length} agent{activeAgentNames.length > 1 ? "s are" : " is"} currently
              working in this project ({activeAgentNames.join(", ")}) and will be stopped.
            </p>
          )}
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
  // null = repo state not yet known (loading); true/false once resolved.
  const [hasGit, setHasGit] = useState<boolean | null>(null);
  const [cloning, setCloning] = useState(false);
  // Per-project GitHub token (used by ALL GitHub operations). Saved together with
  // the rest of the form via the single "Save Changes" button.
  const [tokenSource, setTokenSource] = useState<"global" | "custom">("global");
  const [customToken, setCustomToken] = useState("");
  const [hasCustomToken, setHasCustomToken] = useState(false);

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

  // Detect whether the workspace is already a git repo, to decide whether to
  // offer a "Clone" action next to the GitHub URL.
  useEffect(() => {
    let cancelled = false;
    rpc
      .getProjectRepoState(project.id)
      .then((r) => {
        if (!cancelled) setHasGit(r.hasGit);
      })
      .catch(() => {
        if (!cancelled) setHasGit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // Load the current per-project GitHub token config (source + whether one is saved).
  useEffect(() => {
    let cancelled = false;
    rpc
      .getProjectGitHubTokenInfo(project.id)
      .then((info) => {
        if (cancelled) return;
        setTokenSource(info.source);
        setHasCustomToken(info.hasCustomToken);
        setCustomToken("");
        setDirty(false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project.id]);

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

  // Persist the form without UI chrome (no success toast). Returns whether it
  // succeeded so callers can chain follow-up actions (e.g. clone after save).
  const saveForm = useCallback(async (): Promise<boolean> => {
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
      return false;
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

    // Persist the per-project GitHub token settings alongside the project info.
    await rpc.saveProjectSetting(project.id, "githubTokenSource", tokenSource);
    if (tokenSource === "custom" && customToken.trim()) {
      await rpc.saveProjectSetting(project.id, "githubToken", customToken.trim());
      setHasCustomToken(true);
    }
    setCustomToken("");

    setDirty(false);
    return true;
  }, [form, project, onProjectUpdated, tokenSource, customToken]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (await saveForm()) toast("success", "Project settings saved.");
    } catch {
      toast("error", "Failed to save project settings.");
    } finally {
      setSaving(false);
    }
  }, [saveForm]);

  const handleClone = useCallback(async () => {
    setCloning(true);
    try {
      // Persist any unsaved edits first so the clone uses the latest URL/branch
      // (cloneProjectRepo reads the persisted values from the DB).
      if (dirty && !(await saveForm())) return;

      const res = await rpc.cloneProjectRepo(project.id);
      if (!res.success) {
        toast("error", res.error ?? "Clone failed.");
        return;
      }
      setHasGit(true);
      toast("success", "Repository cloned into the workspace.");
      // Refresh the branch indicator and file tree now that a repo exists.
      window.dispatchEvent(new CustomEvent("agentdesk:stream-complete"));
    } catch {
      toast("error", "Clone failed.");
    } finally {
      setCloning(false);
    }
  }, [dirty, saveForm, project.id]);

  const handleDelete = useCallback(async () => {
    await rpc.deleteProjectCascade(project.id);
    toast("success", "Project deleted.");
    // The confirmation dialog can be closed (Escape / click-outside) while
    // this await is in flight, letting the user switch to a different,
    // still-valid project before the delete resolves — only force-navigate
    // away if they're still looking at the project that was just deleted.
    if (useChatStore.getState().activeProjectId === project.id) {
      navigate({ to: "/" });
    }
  }, [project.id, navigate]);

  const handleReset = useCallback(async () => {
    await rpc.resetProjectData(project.id);

    // Same reasoning as handleDelete: the confirm dialog can be closed mid-await,
    // letting the user switch to a different project before this resolves. The
    // backend reset for project.id already succeeded either way — but the
    // frontend follow-up (clearing GLOBAL chat/kanban stores, creating a
    // conversation, forcing navigation) must not run against whatever project
    // is now active, or it corrupts that project's live chat state and yanks
    // the user back to the one they just reset.
    if (useChatStore.getState().activeProjectId !== project.id) {
      toast("success", "Project data reset.");
      return;
    }

    // Clear both Zustand stores immediately — ProjectPage stays mounted for the
    // same projectId so navigate() alone won't trigger their reload effects.
    useChatStore.getState().reset();
    useKanbanStore.getState().reset();

    // Create a fresh empty conversation so the chat tab has something to show.
    // loadConversations is insufficient here because conversationsLoaded in
    // ProjectPage won't toggle (projectId didn't change), so its auto-create
    // useEffect won't re-run.
    const newConvId = await useChatStore.getState().createConversation(project.id);
    // Re-check after this second await for the same reason.
    if (useChatStore.getState().activeProjectId !== project.id) {
      toast("success", "Project data reset.");
      return;
    }
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
              {/* Native directory picker — desktop only. In web mode it would
                  open a dialog on the desktop the remote user can't see, so hide
                  it; the path can still be typed (matches settings/general.tsx). */}
              {!IS_REMOTE && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleBrowse}
                  disabled={browsingDir}
                  aria-label="Browse for workspace directory"
                >
                  <FolderOpen aria-hidden="true" />
                </Button>
              )}
            </div>
          </FieldRow>

        </CardContent>
      </Card>

      {/* GitHub */}
      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            Repository, working branch, and the token used for all GitHub operations in this
            project — issue sync, pull requests, and the Auto Issues Fixer.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FieldRow
            id="proj-github-url"
            label="GitHub Repository URL"
            description="Optional link to the remote repository."
          >
            <div className="flex gap-2 w-full">
              <Input
                id="proj-github-url"
                value={form.githubUrl}
                onChange={(e) => handleChange("githubUrl", e.target.value)}
                placeholder="https://github.com/org/repo"
                className="flex-1"
              />
              {/* Clone is only offered when a URL is set and the workspace isn't
                  already a git repo (hasGit === false, i.e. resolved & negative). */}
              {form.githubUrl.trim() && hasGit === false && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleClone}
                  disabled={cloning}
                  className="shrink-0"
                >
                  <Download aria-hidden="true" />
                  {cloning ? "Cloning…" : "Clone"}
                </Button>
              )}
            </div>
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

          <Separator />

          <FieldRow
            id="gh-token-source"
            label="Token source"
            description="Where this project's GitHub token comes from. Global uses Settings → GitHub."
          >
            <Select
              value={tokenSource}
              onValueChange={(v) => {
                setTokenSource(v as "global" | "custom");
                setDirty(true);
              }}
            >
              <SelectTrigger id="gh-token-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Use global default (Settings → GitHub)</SelectItem>
                <SelectItem value="custom">Custom token for this project</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          {tokenSource === "custom" && (
            <>
              <Separator />
              <FieldRow
                id="gh-custom-token"
                label="Custom token"
                description="Stored per-project, encrypted at rest. Leave blank to keep the existing one."
              >
                <div>
                  <PasswordInput
                    id="gh-custom-token"
                    value={customToken}
                    onChange={(e) => {
                      setCustomToken(e.target.value);
                      setDirty(true);
                    }}
                    placeholder={hasCustomToken ? "•••••••••• (saved)" : "ghp_…"}
                    className="font-mono text-xs"
                  />
                  {hasCustomToken && !customToken.trim() && (
                    <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                      <Check className="h-3 w-3" />
                      A custom token is saved. Leave blank to keep it, or type a new one to replace it.
                    </p>
                  )}
                  {!hasCustomToken && !customToken.trim() && (
                    <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                      No custom token saved yet — the global token is used until you add one.
                    </p>
                  )}
                </div>
              </FieldRow>
            </>
          )}
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
        projectId={project.id}
        onConfirm={handleReset}
      />
      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        projectId={project.id}
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
  initialSettings: Record<string, string>;
}

function AiTab({ projectId, initialSettings }: AiTabProps) {
  const [form, setForm] = useState<AiForm>(() => ({
    shellApprovalMode:
      initialSettings.shellApprovalMode ?? AI_FORM_DEFAULTS.shellApprovalMode,
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
            id="ai-context-window-limit"
            label="Context Window Limit"
            description="The one limit that governs context: the bar fills toward it, and the conversation auto-compacts on the next turn once usage reaches it. Set it to your model's context window (e.g. 200,000 for Claude/GLM; 1,000,000 for Gemini/1M models). The bar counts REAL usage including the agent's system prompt (~20k), which compaction can't shrink — so the minimum is 50,000. Default: 1,000,000."
          >
            <Input
              id="ai-context-window-limit"
              type="number"
              min={50000}
              step={1000}
              value={form.contextWindowLimit}
              onChange={(e) => handleChange("contextWindowLimit", e.target.value)}
              onBlur={(e) => {
                // Enforce the 50k floor: values below it (or invalid) make the bar/
                // compaction useless because the agent's system prompt alone (~20k) is
                // the irreducible base. Clamp up to 50,000.
                const raw = parseInt(e.target.value, 10);
                const clamped = Number.isNaN(raw) ? 1000000 : Math.max(50000, raw);
                if (String(clamped) !== e.target.value) handleChange("contextWindowLimit", String(clamped));
              }}
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
            description="When ON, the PM automatically dispatches the next kanban task after the current one passes code review. When OFF, the PM stops after each task — no task is moved to In Progress automatically, even if undone tasks remain; say “continue” to start the next one. Saved immediately (no restart needed). Explicitly asking the PM to work on a specific task always works regardless of this setting."
          >
            <Switch
              id="ai-auto-execute-next-task"
              checked={form.autoExecuteNextTask === "true"}
              onCheckedChange={(checked) => {
                const value = checked ? "true" : "false";
                // Persist immediately (not behind the "Save Changes" button) so the
                // backend's live read picks it up at once — the auto-continue
                // decision in the engine/review-cycle reads this on every task
                // completion.
                setForm((prev) => ({ ...prev, autoExecuteNextTask: value }));
                rpc
                  .saveProjectSetting(projectId, "autoExecuteNextTask", value)
                  .then(() => toast("success", `Auto-execute next task ${checked ? "enabled" : "disabled"}.`))
                  .catch(() => toast("error", "Failed to update setting."));
              }}
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
// ProjectSettingsTab — the exported component
// ---------------------------------------------------------------------------

interface ProjectSettingsTabProps {
  projectId: string;
}

export function ProjectSettingsTab({ projectId }: ProjectSettingsTabProps) {
  const [project, setProject] = useState<ProjectData | null>(null);
  const [projectSettings, setProjectSettings] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [proj, ps] = await Promise.all([
          rpc.getProject(projectId),
          rpc.getProjectSettings(projectId),
        ]);
        if (cancelled) return;
        setProject(proj);
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
              initialSettings={projectSettings}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
