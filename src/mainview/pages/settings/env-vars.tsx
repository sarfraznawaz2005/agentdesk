import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Trash2, Eye, EyeOff, Pencil, Check, X } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { CustomEnvVar } from "../../../shared/rpc/env-vars";

// Secret-name pattern that matches the get_env tool's blocklist
const SECRET_PATTERN = /key|token|secret|password|credential|auth|private|apikey|api_key/i;

// ---------------------------------------------------------------------------
// Add row form
// ---------------------------------------------------------------------------

interface AddRowProps {
  onAdd: (name: string, value: string) => Promise<void>;
}

function AddRow({ onAdd }: AddRowProps) {
  const [name, setName]   = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const handleAdd = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) { toast("error", "Variable name is required."); return; }
    setSaving(true);
    try {
      await onAdd(trimmedName, value);
      setName("");
      setValue("");
    } finally {
      setSaving(false);
    }
  }, [name, value, onAdd]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => { if (e.key === "Enter") handleAdd(); },
    [handleAdd],
  );

  return (
    <div className="flex gap-2 items-start pt-2 border-t border-border">
      <Input
        placeholder="VARIABLE_NAME"
        value={name}
        onChange={(e) => setName(e.target.value.toUpperCase())}
        onKeyDown={handleKeyDown}
        className="font-mono text-sm w-48 shrink-0"
        disabled={saving}
        aria-label="New variable name"
      />
      <Input
        placeholder="value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        className="font-mono text-sm flex-1"
        disabled={saving}
        aria-label="New variable value"
      />
      <Button size="sm" onClick={handleAdd} disabled={saving || !name.trim()}>
        <Plus className="h-4 w-4 mr-1" />
        {saving ? "Adding…" : "Add"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual row (view / edit modes)
// ---------------------------------------------------------------------------

interface EnvRowProps {
  envVar: CustomEnvVar;
  onUpdate: (id: string, name: string, value: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function EnvRow({ envVar, onUpdate, onDelete }: EnvRowProps) {
  const [editing, setEditing]   = useState(false);
  const [editName, setEditName] = useState(envVar.name);
  const [editValue, setEditValue] = useState(envVar.value);
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [deleting, setDeleting]     = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSecret = SECRET_PATTERN.test(envVar.name);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onUpdate(envVar.id, editName.trim(), editValue);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [envVar.id, editName, editValue, onUpdate]);

  const handleCancel = useCallback(() => {
    setEditName(envVar.name);
    setEditValue(envVar.value);
    setEditing(false);
  }, [envVar.name, envVar.value]);

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      confirmDeleteTimer.current = setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await onDelete(envVar.id);
    } finally {
      setDeleting(false);
    }
  }, [confirmDelete, envVar.id, onDelete]);

  if (editing) {
    return (
      <div className="flex gap-2 items-center py-1.5">
        <Input
          value={editName}
          onChange={(e) => setEditName(e.target.value.toUpperCase())}
          className="font-mono text-sm w-48 shrink-0 h-8"
          disabled={saving}
        />
        <Input
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          className="font-mono text-sm flex-1 h-8"
          disabled={saving}
        />
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-green-600" onClick={handleSave} disabled={saving} aria-label="Save">
          <Check className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={handleCancel} disabled={saving} aria-label="Cancel">
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex gap-2 items-center py-1.5 group">
      <span className="font-mono text-sm w-48 shrink-0 truncate text-foreground">
        {envVar.name}
      </span>

      <div className="flex-1 flex items-center gap-1 min-w-0">
        <span className={`font-mono text-sm truncate ${isSecret && !showValue ? "text-muted-foreground" : "text-foreground"}`}>
          {isSecret && !showValue
            ? "•".repeat(Math.min(envVar.value.length, 12))
            : envVar.value || <span className="text-muted-foreground italic">empty</span>}
        </span>
        {isSecret && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => setShowValue((v) => !v)}
            aria-label={showValue ? "Hide value" : "Show value"}
          >
            {showValue ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </Button>
        )}
      </div>

      {isSecret && (
        <span
          className="text-[10px] text-amber-600 dark:text-amber-400 border border-amber-400/40 rounded px-1 py-0.5 shrink-0"
          title="Variable name matches secret pattern — agents cannot read this via get_env"
        >
          blocked
        </span>
      )}

      <div className={`flex gap-1 transition-opacity shrink-0 ${confirmDelete ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(true)} aria-label="Edit">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={`h-7 transition-colors ${confirmDelete ? "text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 px-2 text-xs" : "w-7 text-destructive hover:text-destructive px-0"}`}
          onClick={handleDelete}
          disabled={deleting}
          aria-label="Delete"
        >
          {confirmDelete ? "Confirm?" : <Trash2 className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EnvVarsSettings — main export
// ---------------------------------------------------------------------------

export function EnvVarsSettings() {
  const [vars, setVars]     = useState<CustomEnvVar[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    rpc.listCustomEnvVars()
      .then((rows) => { if (!cancelled) { setVars(rows); setLoading(false); } })
      .catch(() => { if (!cancelled) { toast("error", "Failed to load environment variables."); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const handleAdd = useCallback(async (name: string, value: string) => {
    try {
      const created = await rpc.createCustomEnvVar(name, value);
      setVars((prev) => [...prev, created]);
      toast("success", `${created.name} added.`);
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Failed to add variable.");
    }
  }, []);

  const handleUpdate = useCallback(async (id: string, name: string, value: string) => {
    try {
      const updated = await rpc.updateCustomEnvVar(id, { name, value });
      setVars((prev) => prev.map((v) => (v.id === id ? updated : v)));
      toast("success", `${updated.name} updated.`);
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Failed to update variable.");
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const target = vars.find((v) => v.id === id);
    try {
      await rpc.deleteCustomEnvVar(id);
      setVars((prev) => prev.filter((v) => v.id !== id));
      if (target) toast("success", `${target.name} deleted.`);
    } catch {
      toast("error", "Failed to delete variable.");
    }
  }, [vars]);

  return (
    <div className="space-y-6 py-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Environment Variables</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Custom environment variables created here are saved to your OS and injected into the app process on startup so agents can read them.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Variables</CardTitle>
          <CardDescription>
            Variables are available to agents via the <code className="text-xs bg-muted px-1 py-0.5 rounded">get_env</code> tool.
            Names are auto-uppercased. Variables whose names contain <em>key, token, secret, password, credential</em>, or <em>auth</em> are blocked from agent access for security.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
          ) : (
            <div className="space-y-0.5">
              {vars.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3 text-center">No variables yet. Add one below.</p>
              ) : (
                <div>
                  {/* Header row */}
                  <div className="flex gap-2 items-center py-1 mb-1 border-b border-border">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider w-48 shrink-0">Name</span>
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex-1">Value</span>
                  </div>
                  {vars.map((v) => (
                    <EnvRow
                      key={v.id}
                      envVar={v}
                      onUpdate={handleUpdate}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
              <AddRow onAdd={handleAdd} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
