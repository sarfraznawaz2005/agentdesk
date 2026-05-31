import { useState, useEffect, useCallback } from "react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
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

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: string | null;
  createdAt: string;
}

const ENTITY_TYPES = [
  { value: "__all__", label: "All types" },
  { value: "error", label: "Errors" },
  { value: "project", label: "Project" },
  { value: "conversation", label: "Conversation" },
  { value: "agent", label: "Agent" },
  { value: "provider", label: "Provider" },
  { value: "setting", label: "Setting" },
  { value: "deploy", label: "Deploy" },
  { value: "backup", label: "Backup" },
];

const PAGE_SIZE = 25;

export function AuditLogSettings() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [entityType, setEntityType] = useState("__all__");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearAllConfirmOpen, setClearAllConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rpc.getAuditLog({
        entityType: (entityType && entityType !== "__all__") ? entityType : undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setEntries(result.entries);
      setTotal(result.total);
    } catch {
      toast("error", "Failed to load audit log.");
    } finally {
      setLoading(false);
    }
  }, [entityType, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const executeClear = useCallback(async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const result = await rpc.clearAuditLog(cutoff);
      toast("success", `Cleared ${result.deleted} old entries.`);
      load();
    } catch {
      toast("error", "Failed to clear audit log.");
    }
  }, [load]);

  const executeClearAll = useCallback(async () => {
    try {
      // Pass a future cutoff so every existing entry is included
      const cutoff = new Date(Date.now() + 1000).toISOString();
      const result = await rpc.clearAuditLog(cutoff);
      toast("success", `Cleared all ${result.deleted} audit log entries.`);
      setOffset(0);
      load();
    } catch {
      toast("error", "Failed to clear audit log.");
    }
  }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-6 py-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Audit Log</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Track all actions performed in AgentDesk.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Event Log</CardTitle>
          <CardDescription>
            {total} total entries
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Select value={entityType || "__all__"} onValueChange={(v) => { setEntityType(v); setOffset(0); }}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => setClearConfirmOpen(true)}>
              Clear old entries
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setClearAllConfirmOpen(true)}
            >
              Clear All
            </Button>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No audit entries found.</p>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-2 font-medium">Time</th>
                    <th className="text-left p-2 font-medium">Action</th>
                    <th className="text-left p-2 font-medium">Entity</th>
                    <th className="text-left p-2 font-medium">ID</th>
                    <th className="text-left p-2 font-medium w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <>
                      <tr
                        key={entry.id}
                        className={`border-b cursor-pointer ${entry.action === "error" ? "bg-destructive/5 hover:bg-destructive/10" : "hover:bg-muted/30"}`}
                        onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                      >
                        <td className="p-2 text-muted-foreground whitespace-nowrap">
                          {new Date(entry.createdAt).toLocaleString()}
                        </td>
                        <td className="p-2">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${entry.action === "error" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}`}>
                            {entry.action}
                          </span>
                        </td>
                        <td className="p-2">{entry.entityType}</td>
                        <td className="p-2 font-mono text-xs text-muted-foreground truncate max-w-[200px]">
                          {entry.entityId ?? "—"}
                        </td>
                        <td className="p-2 text-muted-foreground">
                          {entry.details ? (expandedId === entry.id ? "▲" : "▼") : ""}
                        </td>
                      </tr>
                      {expandedId === entry.id && entry.details && (
                        <tr key={`${entry.id}-details`}>
                          <td colSpan={5} className="p-3 bg-muted/20">
                            <pre className="text-xs whitespace-pre-wrap font-mono overflow-auto max-h-48">
                              {(() => {
                                try { return JSON.stringify(JSON.parse(entry.details ?? ""), null, 2); }
                                catch { return entry.details; }
                              })()}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Page {currentPage} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmationDialog
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title="Clear Old Audit Entries"
        description="Delete all audit log entries older than 30 days? This action cannot be undone."
        confirmLabel="Clear"
        variant="destructive"
        onConfirm={executeClear}
      />

      <ConfirmationDialog
        open={clearAllConfirmOpen}
        onOpenChange={setClearAllConfirmOpen}
        title="Clear All Audit Logs"
        description="This will permanently delete every audit log entry. This action cannot be undone."
        confirmLabel="Delete All"
        variant="destructive"
        onConfirm={executeClearAll}
      />
    </div>
  );
}
