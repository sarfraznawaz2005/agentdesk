import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Plus, Trash2, Rocket, ExternalLink, Clock, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { rpc } from "../../lib/rpc";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";

interface DeployTabProps {
  projectId: string;
}

interface Environment {
  id: string;
  projectId: string;
  name: string;
  branch: string | null;
  command: string;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeployHistoryItem {
  id: string;
  environmentId: string;
  status: string;
  logOutput: string | null;
  triggeredBy: string;
  durationMs: number | null;
  createdAt: string;
}

const statusColors: Record<string, string> = {
  pending: "bg-yellow-500",
  running: "bg-blue-500",
  success: "bg-green-500",
  failed: "bg-red-500",
};

const statusIcons: Record<string, React.ReactNode> = {
  pending: <Clock className="w-3 h-3" />,
  running: <Loader2 className="w-3 h-3 animate-spin" />,
  success: <CheckCircle className="w-3 h-3" />,
  failed: <XCircle className="w-3 h-3" />,
};

export function DeployTab({ projectId }: DeployTabProps) {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [historyByEnv, setHistoryByEnv] = useState<Record<string, DeployHistoryItem[]>>({});
  const [loading, setLoading] = useState(false);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [expandedEnv, setExpandedEnv] = useState<string | null>(null);

  // Deploy confirmation dialog state
  const [confirmDeploy, setConfirmDeploy] = useState<Environment | null>(null);

  // Delete environment confirmation dialog state
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Deploy error dialog state
  const [deployErrorOpen, setDeployErrorOpen] = useState(false);
  const [deployErrorMessage, setDeployErrorMessage] = useState("");

  // Form state for creating/editing environments
  const [editingEnv, setEditingEnv] = useState<Environment | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    branch: "",
    command: "",
    url: "",
  });
  const [saving, setSaving] = useState(false);

  const loadEnvironments = useCallback(async () => {
    setLoading(true);
    try {
      const envs = await rpc.getEnvironments(projectId);
      setEnvironments(envs);

      // Load history for each environment
      const historyMap: Record<string, DeployHistoryItem[]> = {};
      for (const env of envs) {
        const history = await rpc.getDeployHistory(env.id, 5);
        historyMap[env.id] = history;
      }
      setHistoryByEnv(historyMap);
    } catch (err) {
      console.error("Failed to load environments:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadEnvironments();
  }, [loadEnvironments]);

  const resetForm = () => {
    setFormData({ name: "", branch: "", command: "", url: "" });
    setEditingEnv(null);
  };

  const startEdit = (env: Environment) => {
    setEditingEnv(env);
    setFormData({
      name: env.name,
      branch: env.branch || "",
      command: env.command,
      url: env.url || "",
    });
  };

  const saveEnvironment = async () => {
    if (!formData.name || !formData.command) return;

    setSaving(true);
    try {
      await rpc.saveEnvironment({
        projectId,
        id: editingEnv?.id,
        name: formData.name,
        branch: formData.branch || undefined,
        command: formData.command,
        url: formData.url || undefined,
      });
      resetForm();
      loadEnvironments();
    } catch (err) {
      console.error("Failed to save environment:", err);
    } finally {
      setSaving(false);
    }
  };

  const deleteEnvironment = (id: string) => {
    setPendingDeleteId(id);
    setDeleteConfirmOpen(true);
  };

  const confirmDeleteEnvironment = async () => {
    if (!pendingDeleteId) return;
    try {
      await rpc.deleteEnvironment(pendingDeleteId);
      loadEnvironments();
    } catch (err) {
      console.error("Failed to delete environment:", err);
    } finally {
      setPendingDeleteId(null);
    }
  };

  const executeDeploy = async (env: Environment) => {
    setDeploying(env.id);
    setConfirmDeploy(null);
    try {
      const result = await rpc.executeDeploy(env.id);
      if (!result.success) {
        setDeployErrorMessage(`Deploy failed: ${result.error || "Unknown error"}`);
        setDeployErrorOpen(true);
      }
      loadEnvironments();
    } catch (err) {
      console.error("Deploy failed:", err);
      setDeployErrorMessage("Deploy failed. Check console for details.");
      setDeployErrorOpen(true);
    } finally {
      setDeploying(null);
    }
  };

  const formatDuration = (ms: number | null) => {
    if (!ms) return "-";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-y-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Deploy</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadEnvironments}
            disabled={loading}
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              resetForm();
              setExpandedEnv("new");
            }}
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Environment
          </Button>
        </div>
      </div>

      {/* Deploy Confirmation Dialog */}
      <ConfirmationDialog
        open={!!confirmDeploy}
        onOpenChange={(open) => { if (!open) setConfirmDeploy(null); }}
        title="Confirm Deploy"
        description={
          confirmDeploy
            ? `Deploy to "${confirmDeploy.name}" (branch: ${confirmDeploy.branch || "current"}) using command: ${confirmDeploy.command}?`
            : ""
        }
        confirmLabel="Deploy"
        onConfirm={() => { if (confirmDeploy) executeDeploy(confirmDeploy); }}
      />

      {/* Delete Environment Confirmation */}
      <ConfirmationDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete Environment"
        description="Are you sure you want to delete this environment? This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={confirmDeleteEnvironment}
      />

      {/* Deploy Error Dialog */}
      <ConfirmationDialog
        open={deployErrorOpen}
        onOpenChange={setDeployErrorOpen}
        title="Deploy Failed"
        description={deployErrorMessage}
        confirmLabel="OK"
        cancelLabel="Dismiss"
        onConfirm={() => setDeployErrorOpen(false)}
      />

      {/* New/Edit Environment Form */}
      {expandedEnv === "new" && (
        <div className="border rounded-lg p-4 bg-muted/30">
          <h3 className="text-sm font-medium mb-3">
            {editingEnv ? "Edit Environment" : "New Environment"}
          </h3>
          <div className="grid gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Name *</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Production, Staging"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Branch</label>
              <Input
                value={formData.branch}
                onChange={(e) => setFormData({ ...formData, branch: e.target.value })}
                placeholder="e.g., main, develop"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Deploy Command *</label>
              <Input
                value={formData.command}
                onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                placeholder="e.g., npm run deploy"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">URL (optional)</label>
              <Input
                value={formData.url}
                onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                placeholder="https://your-app.com"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={saveEnvironment} disabled={saving || !formData.name || !formData.command}>
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button variant="outline" onClick={() => { resetForm(); setExpandedEnv(null); }}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Environments List */}
      {environments.length === 0 && expandedEnv !== "new" && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No deploy environments configured. Click "Add Environment" to create one.
        </div>
      )}

      {environments.map((env) => (
        <div key={env.id} className="border rounded-lg overflow-hidden">
          {/* Environment Header */}
          <div
            className="flex items-center justify-between p-3 bg-muted/30 cursor-pointer hover:bg-muted/50"
            onClick={() => setExpandedEnv(expandedEnv === env.id ? null : env.id)}
          >
            <div className="flex items-center gap-3">
              <Rocket className="w-4 h-4 text-muted-foreground" />
              <div>
                <h3 className="text-sm font-medium">{env.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {env.branch && <span className="mr-2">branch: {env.branch}</span>}
                  <code className="text-xs bg-muted px-1 rounded">{env.command}</code>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {env.url && (
                <a
                  href={env.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="p-1 hover:bg-muted rounded"
                >
                  <ExternalLink className="w-4 h-4 text-muted-foreground" />
                </a>
              )}
              <Button
                variant="default"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDeploy(env);
                }}
                disabled={deploying === env.id}
              >
                {deploying === env.id ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                ) : (
                  <Rocket className="w-4 h-4 mr-1" />
                )}
                Deploy
              </Button>
            </div>
          </div>

          {/* Expanded Details */}
          {expandedEnv === env.id && (
            <div className="border-t p-3">
              <div className="flex justify-between items-start mb-3">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Recent Deploys
                </h4>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => startEdit(env)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteEnvironment(env.id)}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>

              {/* Edit Form (inline) */}
              {editingEnv?.id === env.id && (
                <div className="mb-3 p-3 border rounded bg-muted/30">
                  <div className="grid gap-2">
                    <Input
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="Name"
                    />
                    <Input
                      value={formData.branch}
                      onChange={(e) => setFormData({ ...formData, branch: e.target.value })}
                      placeholder="Branch"
                    />
                    <Input
                      value={formData.command}
                      onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                      placeholder="Deploy command"
                    />
                    <Input
                      value={formData.url}
                      onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                      placeholder="URL"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={saveEnvironment}
                        disabled={saving || !formData.name || !formData.command}
                      >
                        Save
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={resetForm}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* History */}
              {historyByEnv[env.id]?.length === 0 ? (
                <p className="text-xs text-muted-foreground">No deployments yet.</p>
              ) : (
                <div className="space-y-2">
                  {historyByEnv[env.id]?.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between py-2 border-b last:border-0"
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "flex items-center gap-1 px-2 py-0.5 rounded text-xs text-white",
                          statusColors[item.status]
                        )}>
                          {statusIcons[item.status]}
                          {item.status}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDuration(item.durationMs)}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(item.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}