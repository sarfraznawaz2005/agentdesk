import { useEffect, useState, useCallback } from "react";
import { Eye, Trash2, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";

const PAGE_SIZE = 20;

type TableMeta = { name: string; displayName: string; deletable: boolean };
type Row = Record<string, unknown>;

// Format a column name from snake_case to Title Case
function colLabel(col: string): string {
  return col.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Detect if a column likely holds datetime values (by name convention)
const DATETIME_COL_PATTERN = /(?:^|_)(?:at|date|time|timestamp|created|updated|deleted|expired|last_run|started|completed|finished)(?:_at)?$/i;

// Format a UTC datetime string to the app's configured timezone
function formatDbDateTime(val: string, tz: string): string {
  // Match SQLite datetime format: "2026-03-19 04:18:24" or ISO strings
  if (!/^\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}/.test(val)) return val;
  try {
    const needsUtcHint = !/Z$|[+-]\d{2}:\d{2}$/.test(val);
    const d = new Date(needsUtcHint ? val.replace(" ", "T") + "Z" : val);
    if (isNaN(d.getTime())) return val;
    return d.toLocaleString(undefined, {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return val;
  }
}

// Truncate a cell value for display in the table
function cellDisplay(val: unknown, col?: string, tz?: string): string {
  if (val === null || val === undefined) return "—";
  const str = typeof val === "object" ? JSON.stringify(val) : String(val);
  if (tz && col && DATETIME_COL_PATTERN.test(col)) return formatDbDateTime(str, tz);
  return str.length > 80 ? str.slice(0, 78) + "…" : str;
}

function RowViewDialog({
  row,
  columns,
  onClose,
  timezone,
}: {
  row: Row | null;
  columns: string[];
  onClose: () => void;
  timezone: string;
}) {
  if (!row) return null;
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="w-4 h-4" />
            Row Details
          </DialogTitle>
        </DialogHeader>
        <div className="mt-2 space-y-2">
          {columns.map((col) => (
            <div key={col} className="grid grid-cols-[180px_1fr] gap-3 text-sm border-b border-border pb-2">
              <span className="font-medium text-muted-foreground shrink-0">{colLabel(col)}</span>
              <span className="text-foreground break-all font-mono text-xs bg-muted/50 rounded px-2 py-1">
                {row[col] === null || row[col] === undefined
                  ? <span className="text-muted-foreground/60 italic">null</span>
                  : typeof row[col] === "object"
                  ? JSON.stringify(row[col], null, 2)
                  : DATETIME_COL_PATTERN.test(col)
                  ? formatDbDateTime(String(row[col]), timezone)
                  : String(row[col])}
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DbViewerPage() {
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [selectedTable, setSelectedTable] = useState<string>("");
  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [viewRow, setViewRow] = useState<Row | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [appTimezone, setAppTimezone] = useState<string>("UTC");

  const tableMeta = tables.find((t) => t.name === selectedTable);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Load table list and timezone setting once
  useEffect(() => {
    rpc.dbViewerGetTables().then((list) => {
      setTables(list as TableMeta[]);
      if (list.length > 0) setSelectedTable(list[0].name);
    }).catch(() => {});
    rpc.getSetting("timezone", "general").then((val) => {
      if (typeof val === "string" && val.length > 0) setAppTimezone(val);
    }).catch(() => {});
  }, []);

  const loadRows = useCallback(async (table: string, p: number) => {
    if (!table) return;
    setLoading(true);
    try {
      const result = await rpc.dbViewerGetRows({ table, page: p, pageSize: PAGE_SIZE });
      setRows(result.rows as Row[]);
      setColumns(result.columns);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedTable) {
      setPage(1);
      loadRows(selectedTable, 1);
    }
  }, [selectedTable, loadRows]);

  useEffect(() => {
    if (selectedTable) loadRows(selectedTable, page);
  }, [page, selectedTable, loadRows]);

  async function handleDelete() {
    if (!deleteTarget || !selectedTable) return;
    setDeleting(true);
    try {
      await rpc.dbViewerDeleteRow({ table: selectedTable, id: String(deleteTarget.id) });
      setDeleteTarget(null);
      await loadRows(selectedTable, page);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Table selector + row info */}
      <div className="shrink-0 px-6 py-3 border-b border-border bg-background">
        <div className="flex items-center gap-3">
          <Select value={selectedTable} onValueChange={setSelectedTable}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Select a table…" />
            </SelectTrigger>
            <SelectContent>
              {tables.map((t) => (
                <SelectItem key={t.name} value={t.name}>
                  {t.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {tableMeta && (
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{tableMeta.name}</span>
              {" · "}
              {total.toLocaleString()} row{total !== 1 ? "s" : ""}
              {!tableMeta.deletable && (
                <span className="ml-2 text-amber-600">(read-only)</span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            No rows found
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-muted/50 z-10">
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="text-left px-3 py-2 font-medium text-muted-foreground border-b border-border whitespace-nowrap"
                  >
                    {colLabel(col)}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium text-muted-foreground border-b border-border text-right whitespace-nowrap">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={String(row.id ?? i)}
                  className={cn(
                    "border-b border-border hover:bg-muted/50 transition-colors",
                    i % 2 === 0 ? "bg-background" : "bg-muted/20"
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col}
                      className="px-3 py-1.5 text-foreground/80 max-w-[200px] truncate"
                      title={row[col] === null || row[col] === undefined ? "" : String(row[col])}
                    >
                      {row[col] === null || row[col] === undefined ? (
                        <span className="text-muted-foreground/40 italic">null</span>
                      ) : (
                        cellDisplay(row[col], col, appTimezone)
                      )}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1">
                      <Tip content="View full row" side="left">
                        <button
                          onClick={() => setViewRow(row)}
                          className="p-1 rounded text-muted-foreground/60 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                      </Tip>
                      {tableMeta?.deletable && (
                        <Tip content="Delete row" side="left">
                          <button
                            onClick={() => setDeleteTarget(row)}
                            className="p-1 rounded text-muted-foreground/60 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </Tip>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="shrink-0 px-6 py-3 border-t border-border bg-background flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {page} of {totalPages} · {total.toLocaleString()} total rows
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="h-7 px-2"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="h-7 px-2"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Row view modal */}
      <RowViewDialog
        row={viewRow}
        columns={columns}
        onClose={() => setViewRow(null)}
        timezone={appTimezone}
      />

      {/* Delete confirmation */}
      <ConfirmationDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Delete Row"
        description={
          deleteTarget?.id
            ? `Delete row with id "${String(deleteTarget.id)}" from ${tableMeta?.displayName}? This cannot be undone.`
            : "Delete this row? This cannot be undone."
        }
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
