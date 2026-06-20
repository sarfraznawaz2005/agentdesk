import { useState, useEffect, useCallback } from "react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Button } from "@/components/ui/button";
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
import { Label } from "@/components/ui/label";

// ---------------------------------------------------------------------------
// DatabaseMaintenanceCard — optimize, vacuum, prune from settings
// ---------------------------------------------------------------------------

function DatabaseMaintenanceCard() {
  const [optimizing, setOptimizing] = useState(false);
  const [vacuuming, setVacuuming] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [pruneDays, setPruneDays] = useState(90);

  const handleOptimize = useCallback(async () => {
    setOptimizing(true);
    try {
      await rpc.optimizeDatabase();
      toast("success", "Database optimized.");
    } catch {
      toast("error", "Failed to optimize database.");
    } finally {
      setOptimizing(false);
    }
  }, []);

  const handleVacuum = useCallback(async () => {
    setVacuuming(true);
    try {
      await rpc.vacuumDatabase();
      toast("success", "Database vacuumed successfully.");
    } catch {
      toast("error", "Failed to vacuum database.");
    } finally {
      setVacuuming(false);
    }
  }, []);

  const handlePrune = useCallback(async () => {
    setPruning(true);
    try {
      await rpc.pruneDatabase(pruneDays);
      toast("success", `Pruned log data older than ${pruneDays} days.`);
    } catch {
      toast("error", "Failed to prune old data.");
    } finally {
      setPruning(false);
    }
  }, [pruneDays]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Database Maintenance</CardTitle>
        <CardDescription>
          Optimize performance and reclaim disk space.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleOptimize} disabled={optimizing}>
            {optimizing ? "Optimizing…" : "Optimize Database"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Runs PRAGMA optimize and WAL checkpoint.
          </span>
        </div>

        <Separator />

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleVacuum} disabled={vacuuming}>
            {vacuuming ? "Vacuuming…" : "Vacuum Database"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Rewrites the database file to reclaim disk space.
          </span>
        </div>

        <Separator />

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handlePrune} disabled={pruning}>
            {pruning ? "Pruning…" : "Prune Old Logs"}
          </Button>
          <Select
            value={String(pruneDays)}
            onValueChange={(v) => setPruneDays(parseInt(v, 10))}
          >
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30">30 days</SelectItem>
              <SelectItem value="60">60 days</SelectItem>
              <SelectItem value="90">90 days</SelectItem>
              <SelectItem value="180">180 days</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            Delete old cron history and webhook events.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// BackupsCard — create, list, restore, delete backups
// ---------------------------------------------------------------------------

function BackupsCard() {
  const [backups, setBackups] = useState<Array<{ filename: string; size: number; date: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingFilename, setPendingFilename] = useState<string | null>(null);

  const loadBackups = useCallback(async () => {
    try {
      const list = await rpc.listBackups();
      setBackups(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBackups();
  }, [loadBackups]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const result = await rpc.createBackup();
      toast("success", `Backup created: ${result.filename}`);
      loadBackups();
    } catch {
      toast("error", "Failed to create backup.");
    } finally {
      setCreating(false);
    }
  }, [loadBackups]);

  const handleRestore = useCallback((filename: string) => {
    setPendingFilename(filename);
    setRestoreConfirmOpen(true);
  }, []);

  const executeRestore = useCallback(async () => {
    if (!pendingFilename) return;
    try {
      await rpc.restoreBackup(pendingFilename);
      toast("success", "Backup restored. Please restart the app.");
    } catch {
      toast("error", "Failed to restore backup.");
    } finally {
      setPendingFilename(null);
    }
  }, [pendingFilename]);

  const handleDelete = useCallback((filename: string) => {
    setPendingFilename(filename);
    setDeleteConfirmOpen(true);
  }, []);

  const executeDelete = useCallback(async () => {
    if (!pendingFilename) return;
    try {
      await rpc.deleteBackup(pendingFilename);
      toast("success", "Backup deleted.");
      loadBackups();
    } catch {
      toast("error", "Failed to delete backup.");
    } finally {
      setPendingFilename(null);
    }
  }, [pendingFilename, loadBackups]);

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Database Backups</CardTitle>
        <CardDescription>
          Create and manage database backups.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button variant="outline" size="sm" onClick={handleCreate} disabled={creating}>
          {creating ? "Creating…" : "Create Backup"}
        </Button>

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading backups…</p>
        ) : backups.length === 0 ? (
          <p className="text-xs text-muted-foreground">No backups yet.</p>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-2 font-medium">Filename</th>
                  <th className="text-left p-2 font-medium">Size</th>
                  <th className="text-left p-2 font-medium">Date</th>
                  <th className="text-right p-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.filename} className="border-b last:border-0">
                    <td className="p-2 font-mono text-xs">{b.filename}</td>
                    <td className="p-2 text-muted-foreground">{formatSize(b.size)}</td>
                    <td className="p-2 text-muted-foreground">{new Date(b.date).toLocaleString()}</td>
                    <td className="p-2 text-right space-x-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => handleRestore(b.filename)}
                      >
                        Restore
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={() => handleDelete(b.filename)}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <ConfirmationDialog
        open={restoreConfirmOpen}
        onOpenChange={setRestoreConfirmOpen}
        title="Restore Backup"
        description={`Restore from "${pendingFilename}"? The app will need to restart.`}
        confirmLabel="Restore"
        variant="destructive"
        onConfirm={executeRestore}
      />

      <ConfirmationDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete Backup"
        description={`Delete backup "${pendingFilename}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={executeDelete}
      />
    </Card>
  );
}

interface ProjectOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// SettingsExportImportCard — export/import the full app settings bundle
// ---------------------------------------------------------------------------

function SettingsExportImportCard() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const result = await rpc.exportSettings();
      const blob = new Blob([result.data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `agentdesk-settings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("success", "Settings exported successfully.");
    } catch {
      toast("error", "Failed to export settings.");
    } finally {
      setExporting(false);
    }
  }, []);

  const handleImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      try {
        const text = await file.text();
        const result = await rpc.importSettings(text);
        if (result.success) {
          toast("success", "Settings imported. Some changes may require a restart.");
        } else {
          toast("error", result.error ?? "Import failed.");
        }
      } catch (err) {
        toast("error", `Import failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      } finally {
        setImporting(false);
      }
    };
    input.click();
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export / Import Settings</CardTitle>
        <CardDescription>
          Back up or restore your app configuration — AI providers (including API keys), channel configs,
          notification preferences, settings, scheduled jobs, prompts, and custom agents. Useful for migrating to a new machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export Settings"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Downloads a <code className="font-mono">agentdesk-settings-YYYY-MM-DD.json</code> file.
          </span>
        </div>
        <Separator />
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleImport} disabled={importing}>
            {importing ? "Importing…" : "Import Settings"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Replaces all providers, channels, and preferences from a previously exported file.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function DataSettings() {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [exportProjectId, setExportProjectId] = useState("");
  const [importProjectId, setImportProjectId] = useState("");
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importCounts, setImportCounts] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    rpc.getProjects().then((p) => {
      setProjects(p.map((proj) => ({ id: proj.id, name: proj.name })));
      if (p.length > 0) {
        setExportProjectId(p[0].id);
        setImportProjectId(p[0].id);
      }
    });
  }, []);

  const handleExport = useCallback(async () => {
    if (!exportProjectId) return;
    setExporting(true);
    try {
      const result = await rpc.exportProjectData(exportProjectId);
      const blob = new Blob([result.data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const project = projects.find((p) => p.id === exportProjectId);
      a.download = `agentdesk-export-${project?.name ?? "project"}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("success", "Project data exported.");
    } catch {
      toast("error", "Failed to export project data.");
    } finally {
      setExporting(false);
    }
  }, [exportProjectId, projects]);

  const handleImport = useCallback(async () => {
    if (!importProjectId) return;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      setImporting(true);
      setImportCounts(null);
      try {
        const text = await file.text();
        const result = await rpc.importProjectData(importProjectId, text, importMode);
        setImportCounts(result.counts);
        toast("success", "Project data imported successfully.");
      } catch (err) {
        toast("error", `Import failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      } finally {
        setImporting(false);
      }
    };
    input.click();
  }, [importProjectId, importMode]);

  return (
    <div className="space-y-6 py-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Data Management</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your database, backups, and project data.
        </p>
      </div>

      {/* Settings Export / Import */}
      <SettingsExportImportCard />

      {/* Project Data Export / Import */}
      <Card>
        <CardHeader>
          <CardTitle>Project Data</CardTitle>
          <CardDescription>
            Export or import all conversations, tasks, docs, and more for a project.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Export */}
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1">
              <Label>Project</Label>
              <Select value={exportProjectId} onValueChange={setExportProjectId}>
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting || !exportProjectId}>
              {exporting ? "Exporting…" : "Export Project Data"}
            </Button>
          </div>

          <Separator />

          {/* Import */}
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1">
              <Label>Target Project</Label>
              <Select value={importProjectId} onValueChange={setImportProjectId}>
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Import Mode</Label>
              <Select value={importMode} onValueChange={(v) => setImportMode(v as "merge" | "replace")}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="merge">Merge (skip existing)</SelectItem>
                  <SelectItem value="replace">Replace (overwrite)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" onClick={handleImport} disabled={importing || !importProjectId}>
              {importing ? "Importing…" : "Import Project Data"}
            </Button>
          </div>

          {importMode === "replace" && (
            <p className="text-xs text-destructive">
              Replace mode will delete all existing project data before importing.
            </p>
          )}

          {importCounts && (
            <div className="bg-muted/50 rounded-md p-3">
              <p className="text-sm font-medium mb-2">Import Results:</p>
              <div className="grid grid-cols-2 gap-1 text-xs">
                {Object.entries(importCounts).map(([key, count]) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-muted-foreground">{key}:</span>
                    <span className="font-mono">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Database Maintenance */}
      <DatabaseMaintenanceCard />

      {/* Database Backups */}
      <BackupsCard />
    </div>
  );
}
