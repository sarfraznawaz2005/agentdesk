import { useState, useEffect } from "react";
import { FolderOpen } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { rpc } from "@/lib/rpc";

interface NewProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

interface FormState {
  name: string;
  description: string;
  workspacePath: string;
  githubUrl: string;
  workingBranch: string;
}

const INITIAL_FORM: FormState = {
  name: "",
  description: "",
  workspacePath: "",
  githubUrl: "",
  workingBranch: "",
};

export function NewProjectModal({
  open,
  onOpenChange,
  onCreated,
}: NewProjectModalProps) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [browsingDir, setBrowsingDir] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [globalWorkspace, setGlobalWorkspace] = useState<string>("");
  const [manualPath, setManualPath] = useState(false);

  // Load global workspace path when modal opens
  useEffect(() => {
    if (!open) return;
    rpc
      .getSetting("global_workspace_path", "general")
      .then((result) => {
        if (typeof result === "string" && result) {
          try {
            const parsed = JSON.parse(result);
            if (typeof parsed === "string" && parsed) {
              setGlobalWorkspace(parsed);
            }
          } catch {
            if (typeof result === "string" && result) {
              setGlobalWorkspace(result);
            }
          }
        }
      })
      .catch(() => {});
  }, [open]);

  // Auto-derive workspace path from global workspace + project name
  // (only if user hasn't manually selected/typed a path)
  useEffect(() => {
    if (globalWorkspace && form.name.trim() && !manualPath) {
      const slug = form.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const sep = globalWorkspace.includes("\\") ? "\\" : "/";
      setForm((prev) => ({
        ...prev,
        workspacePath: `${globalWorkspace}${sep}${slug}`,
      }));
    }
  }, [globalWorkspace, form.name, manualPath]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => ({ ...prev, [key]: undefined }));
    }
  }

  function validate(): boolean {
    const next: Partial<Record<keyof FormState, string>> = {};

    if (!form.name.trim()) {
      next.name = "Project name is required.";
    }

    if (!form.workspacePath.trim()) {
      next.workspacePath = "Workspace path is required. Set a global workspace in Settings > General.";
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function handleBrowse() {
    setBrowsingDir(true);

    function onResult(e: Event) {
      const { path } = (e as CustomEvent<{ path: string | null }>).detail;
      window.removeEventListener("agentdesk:directory-selected", onResult);
      setBrowsingDir(false);
      if (path) {
        updateField("workspacePath", path);
        setManualPath(true);
      }
    }

    window.addEventListener("agentdesk:directory-selected", onResult);
    rpc.selectDirectory().catch(() => {
      window.removeEventListener("agentdesk:directory-selected", onResult);
      setBrowsingDir(false);
      toast("error", "Failed to open directory picker.");
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!validate()) return;

    setSubmitting(true);
    try {
      const res = await rpc.createProject({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        workspacePath: form.workspacePath.trim(),
        githubUrl: form.githubUrl.trim() || undefined,
        workingBranch: form.workingBranch.trim() || undefined,
      });

      if (!res.success) {
        if (res.error?.includes("already exists")) {
          setErrors({ name: res.error });
        } else {
          toast("error", res.error ?? "Failed to create project.");
        }
        return;
      }

      toast("success", `Project "${form.name.trim()}" created.`);
      setForm(INITIAL_FORM);
      setErrors({});
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create project.";
      toast("error", message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setForm(INITIAL_FORM);
      setErrors({});
      setManualPath(false);
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Fill in the details below to create a new project.
          </DialogDescription>
        </DialogHeader>

        <form
          id="new-project-form"
          onSubmit={handleSubmit}
          noValidate
          className="flex flex-col gap-4"
        >
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">
              Name <span aria-hidden="true" className="text-destructive">*</span>
            </Label>
            <Input
              id="project-name"
              type="text"
              placeholder="My awesome project"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              aria-required="true"
              aria-describedby={errors.name ? "project-name-error" : undefined}
              aria-invalid={!!errors.name}
              disabled={submitting}
            />
            {errors.name && (
              <p id="project-name-error" className="text-xs text-destructive" role="alert">
                {errors.name}
              </p>
            )}
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              placeholder="A brief description of the project (optional)"
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              disabled={submitting}
              className="min-h-[80px] resize-y"
            />
          </div>

          {/* Workspace Path — auto-derived from global workspace + name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-workspace">
              Workspace Path {!globalWorkspace && <span aria-hidden="true" className="text-destructive">*</span>}
            </Label>
            <div className="flex gap-2">
              <Input
                id="project-workspace"
                type="text"
                placeholder={globalWorkspace ? "Auto-derived from project name" : "/path/to/project"}
                value={form.workspacePath}
                onChange={(e) => { updateField("workspacePath", e.target.value); setManualPath(true); }}
                aria-required={!globalWorkspace}
                aria-describedby={
                  errors.workspacePath ? "project-workspace-error" : undefined
                }
                aria-invalid={!!errors.workspacePath}
                disabled={submitting}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={handleBrowse}
                disabled={submitting || browsingDir}
                aria-label="Browse for workspace directory"
              >
                <FolderOpen aria-hidden="true" />
                Browse
              </Button>
            </div>
            {globalWorkspace && (
              <p className="text-xs text-muted-foreground">
                Auto-derived from global workspace: {globalWorkspace}
              </p>
            )}
            {errors.workspacePath && (
              <p
                id="project-workspace-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {errors.workspacePath}
              </p>
            )}
          </div>

          {/* GitHub URL */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-github">GitHub URL</Label>
            <Input
              id="project-github"
              type="url"
              placeholder="https://github.com/org/repo (optional)"
              value={form.githubUrl}
              onChange={(e) => updateField("githubUrl", e.target.value)}
              disabled={submitting}
            />
            {form.githubUrl.trim() && (
              <p className="text-xs text-muted-foreground">
                The repository will be cloned into the workspace path above.
              </p>
            )}
          </div>

          {/* Branch */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-branch">Branch</Label>
            <Input
              id="project-branch"
              type="text"
              placeholder="main (optional)"
              value={form.workingBranch}
              onChange={(e) => updateField("workingBranch", e.target.value)}
              disabled={submitting}
            />
            {form.githubUrl.trim() && form.workingBranch.trim() && (
              <p className="text-xs text-muted-foreground">
                Will checkout <code className="font-mono">{form.workingBranch.trim()}</code> after cloning.
              </p>
            )}
          </div>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-project-form"
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting
            ? (form.githubUrl.trim() ? "Cloning…" : "Creating…")
            : "Create Project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
