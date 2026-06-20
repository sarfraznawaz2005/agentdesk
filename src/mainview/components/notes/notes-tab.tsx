import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { ArrowLeft, FileText, FolderOpen, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { MermaidDiagram } from "@/components/ui/mermaid-diagram";
import { rpc } from "@/lib/rpc";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SearchInput } from "@/components/ui/search-input";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/date-utils";

interface Note {
  id: string;
  projectId: string;
  title: string;
  content: string;
  authorAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Plan {
  title: string;
  content: string;
  path: string;
  updatedAt: string;
}

/** Union type for sidebar items */
type DocItem =
  | { kind: "note"; data: Note }
  | { kind: "plan"; data: Plan };

interface NotesTabProps {
  projectId: string;
}

// Highlight matching text fragments
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) =>
        re.test(part) ? (
          <mark key={i} className="bg-yellow-200 text-inherit rounded-sm px-px">{part}</mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

// Recursively highlight string children within React nodes
function highlightChildren(children: React.ReactNode, query: string): React.ReactNode {
  if (!query.trim()) return children;
  if (typeof children === "string") return <Highlight text={children} query={query} />;
  if (Array.isArray(children)) return children.map((c, i) => <React.Fragment key={i}>{highlightChildren(c, query)}</React.Fragment>);
  return children;
}

// Markdown components for the preview pane
function makeMdComponents(query: string) {
  const h = (children: React.ReactNode) => highlightChildren(children, query);
  return {
     
    code({ className, children, ref: _ref, ...props }: Record<string, unknown>) {
      const match = /language-(\w+)/.exec((className as string) ?? "");
      if (match?.[1] === "mermaid") {
        return <MermaidDiagram code={String(children).trim()} />;
      }
      if (!match) {
        return (
          <code className="px-1.5 py-0.5 rounded text-sm font-mono bg-muted text-foreground" {...props}>
            {children as React.ReactNode}
          </code>
        );
      }
      return (
        <pre className="my-3 rounded-lg bg-gray-900 text-gray-100 p-4 overflow-x-auto text-sm font-mono leading-relaxed">
          <code>{children as React.ReactNode}</code>
        </pre>
      );
    },
    p: ({ children }: { children: React.ReactNode }) => <p className="mb-3 last:mb-0 text-sm text-foreground leading-relaxed">{h(children)}</p>,
    ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc pl-5 mb-3 space-y-1 text-sm text-foreground">{children}</ul>,
    ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal pl-5 mb-3 space-y-1 text-sm text-foreground">{children}</ol>,
    li: ({ children }: { children: React.ReactNode }) => <li className="leading-relaxed">{h(children)}</li>,
    h1: ({ children }: { children: React.ReactNode }) => <h1 className="text-xl font-bold mb-3 mt-5 first:mt-0 text-foreground">{h(children)}</h1>,
    h2: ({ children }: { children: React.ReactNode }) => <h2 className="text-lg font-bold mb-2 mt-4 first:mt-0 text-foreground">{h(children)}</h2>,
    h3: ({ children }: { children: React.ReactNode }) => <h3 className="text-base font-semibold mb-2 mt-3 first:mt-0 text-foreground">{h(children)}</h3>,
    h4: ({ children }: { children: React.ReactNode }) => <h4 className="text-sm font-semibold mb-1 mt-2 first:mt-0 text-foreground">{h(children)}</h4>,
    blockquote: ({ children }: { children: React.ReactNode }) => (
      <blockquote className="border-l-4 border-border pl-4 italic mb-3 text-muted-foreground">{h(children)}</blockquote>
    ),
    a: ({ href, children }: { href?: string; children: React.ReactNode }) => (
      <a href={href} className="text-primary hover:text-primary/80 underline" target="_blank" rel="noopener noreferrer">
        {h(children)}
      </a>
    ),
    hr: () => <hr className="my-4 border-border" />,
    table: ({ children }: { children: React.ReactNode }) => (
      <div className="overflow-x-auto mb-3">
        <table className="min-w-full text-sm border-collapse">{children}</table>
      </div>
    ),
    th: ({ children }: { children: React.ReactNode }) => (
      <th className="border border-border px-3 py-1.5 bg-muted/50 font-semibold text-left text-foreground">{h(children)}</th>
    ),
    td: ({ children }: { children: React.ReactNode }) => (
      <td className="border border-border px-3 py-1.5 text-foreground/80">{h(children)}</td>
    ),
    strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-foreground">{h(children)}</strong>,
    em: ({ children }: { children: React.ReactNode }) => <em className="italic text-foreground/80">{h(children)}</em>,
  };
}

function getItemKey(item: DocItem): string {
  return item.kind === "note" ? `note:${item.data.id}` : `plan:${item.data.path}`;
}

export function NotesTab({ projectId }: NotesTabProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  // Selected item key + inline editing
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  // New doc creation
  const [creating, setCreating] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<DocItem | null>(null);

  // User name for authoring
  const [userName, setUserName] = useState<string>("");

  const mdComponents = useMemo(() => makeMdComponents(searchQuery), [searchQuery]);

  // Build flat list of all items for sidebar
  const allItems = useMemo<DocItem[]>(() => {
    const planItems: DocItem[] = plans.map((p) => ({ kind: "plan", data: p }));
    const noteItems: DocItem[] = notes.map((n) => ({ kind: "note", data: n }));
    return [...planItems, ...noteItems];
  }, [plans, notes]);

  const selectedItem = allItems.find((item) => getItemKey(item) === selectedKey) ?? null;

  const loadDocs = useCallback(async () => {
    try {
      const [notesResult, plansResult] = await Promise.all([
        rpc.getProjectNotes(projectId),
        rpc.getWorkspacePlans(projectId),
      ]);
      setNotes(notesResult);
      setPlans(plansResult as Plan[]);
    } catch (err) {
      console.error("Failed to load docs:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const searchAndSetNotes = useCallback(
    async (query: string) => {
      try {
        const [notesResult, plansResult] = await Promise.all([
          query.trim() ? rpc.searchNotes(projectId, query) : rpc.getProjectNotes(projectId),
          rpc.getWorkspacePlans(projectId),
        ]);
        setNotes(notesResult);
        // Filter plans client-side by search query
        const q = query.toLowerCase().trim();
        setPlans(
          q
            ? (plansResult as Plan[]).filter(
                (p) => p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q),
              )
            : (plansResult as Plan[]),
        );
      } catch (err) {
        console.error("Failed to search docs:", err);
      }
    },
    [projectId],
  );

  // Initial load
  useEffect(() => {
    loadDocs();
    rpc.getSetting("user_name", "user").then((v) => {
      if (typeof v === "string" && v.trim()) setUserName(v.trim());
    }).catch(() => {});
  }, [loadDocs]);

  // Re-search when query changes
  useEffect(() => {
    searchAndSetNotes(searchQuery);
  }, [searchQuery, searchAndSetNotes]);

  // Auto-select first item when docs load and nothing is selected
  useEffect(() => {
    if (allItems.length > 0 && !selectedKey) {
      setSelectedKey(getItemKey(allItems[0]));
    }
    if (selectedKey && !allItems.find((item) => getItemKey(item) === selectedKey)) {
      setSelectedKey(allItems.length > 0 ? getItemKey(allItems[0]) : null);
    }
  }, [allItems, selectedKey]);

  // Refresh when agents finish or PM stream completes
  useEffect(() => {
    const refresh = () => loadDocs();
    window.addEventListener("agentdesk:agent-inline-complete", refresh);
    window.addEventListener("agentdesk:stream-complete", refresh);
    return () => {
      window.removeEventListener("agentdesk:agent-inline-complete", refresh);
      window.removeEventListener("agentdesk:stream-complete", refresh);
    };
  }, [loadDocs]);

  function handleSelect(key: string) {
    if (editing || creating) return;
    setSelectedKey(key);
  }

  function startEdit() {
    if (!selectedItem) return;
    if (selectedItem.kind === "note") {
      setEditTitle(selectedItem.data.title);
      setEditContent(selectedItem.data.content);
      setEditing(true);
      setCreating(false);
    }
    // Plans are file-based, not editable inline for now
  }

  function startCreate() {
    setEditing(true);
    setCreating(true);
    setEditTitle("");
    setEditContent("");
    setSelectedKey(null);
  }

  function cancelEdit() {
    setEditing(false);
    setCreating(false);
    if (creating && allItems.length > 0) {
      setSelectedKey(getItemKey(allItems[0]));
    }
  }

  async function handleSave() {
    if (!editTitle.trim()) return;
    setSaving(true);
    try {
      if (creating) {
        const result = await rpc.createNote({ projectId, title: editTitle.trim(), content: editContent, authorAgentId: userName || "User" });
        await searchAndSetNotes(searchQuery);
        setSelectedKey(`note:${result.id}`);
      } else if (selectedItem?.kind === "note") {
        await rpc.updateNote({ id: selectedItem.data.id, title: editTitle.trim(), content: editContent });
        await searchAndSetNotes(searchQuery);
      }
      setEditing(false);
      setCreating(false);
    } catch (err) {
      console.error("Failed to save doc:", err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.kind === "note") {
        await rpc.deleteNote(deleteTarget.data.id);
      } else {
        await rpc.deleteWorkspacePlan(deleteTarget.data.path);
      }
      setDeleteTarget(null);
      const deletedKey = getItemKey(deleteTarget);
      if (selectedKey === deletedKey) {
        setSelectedKey(null);
        setEditing(false);
      }
      await searchAndSetNotes(searchQuery);
    } catch (err) {
      console.error("Failed to delete doc:", err);
    }
  }

  // Derive display info for selected item
  const selectedTitle = selectedItem
    ? selectedItem.kind === "note" ? selectedItem.data.title : selectedItem.data.title
    : null;
  const selectedContent = selectedItem
    ? selectedItem.kind === "note" ? selectedItem.data.content : selectedItem.data.content
    : null;
  const isNote = selectedItem?.kind === "note";

  return (
    <div className="flex h-full">
      {/* Left sidebar — doc list. Mobile: full-width single pane, hidden once a
          doc is selected/being created (the content pane takes over). */}
      <div className={cn(
        "w-64 shrink-0 border-r flex flex-col bg-muted/30 max-md:w-full",
        (selectedKey || creating) && "max-md:hidden",
      )}>
        {/* Search + New */}
        <div className="p-2 space-y-2 shrink-0 border-b">
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search docs..."
          />
          <Button size="sm" className="w-full" onClick={startCreate}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            New Doc
          </Button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-2 space-y-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="p-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2 mt-1" />
                </div>
              ))}
            </div>
          ) : allItems.length === 0 ? (
            <div className="p-4 text-center">
              <FileText className="w-5 h-5 text-muted-foreground/40 mx-auto mb-1" />
              <p className="text-xs text-muted-foreground">
                {searchQuery ? "No docs match" : "No docs yet"}
              </p>
            </div>
          ) : (
            <>
              {/* Plans section */}
              {plans.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted border-b">
                    <FolderOpen className="w-3 h-3 text-muted-foreground/60" />
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Plans
                    </span>
                  </div>
                  <ul>
                    {plans.map((plan) => {
                      const key = `plan:${plan.path}`;
                      return (
                        <li
                          key={key}
                          onClick={() => handleSelect(key)}
                          className={cn(
                            "group flex items-start justify-between gap-1 px-3 py-2 cursor-pointer transition-colors",
                            selectedKey === key
                              ? "bg-indigo-50 dark:bg-indigo-950/40 border-l-2 border-indigo-500"
                              : "hover:bg-muted border-l-2 border-transparent",
                          )}
                        >
                          <div className="flex-1 min-w-0">
                            <p className={cn(
                              "text-sm truncate",
                              selectedKey === key ? "font-semibold text-indigo-600 dark:text-indigo-400" : "font-medium text-foreground",
                            )}>
                              <Highlight text={plan.title} query={searchQuery} />
                            </p>
                            <span className="text-[10px] text-muted-foreground/60">
                              {relativeTime(plan.updatedAt)}
                            </span>
                          </div>
                          <div
                            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Tip content="Delete">
                              <button
                                className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-950/30 text-muted-foreground/60 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                                onClick={() => setDeleteTarget({ kind: "plan", data: plan })}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </Tip>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              {/* Notes section */}
              {notes.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted border-b">
                    <FileText className="w-3 h-3 text-muted-foreground/60" />
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Docs
                    </span>
                  </div>
                  <ul>
                    {notes.map((note) => {
                      const key = `note:${note.id}`;
                      return (
                        <li
                          key={key}
                          onClick={() => handleSelect(key)}
                          className={cn(
                            "group flex items-start justify-between gap-1 px-3 py-2 cursor-pointer transition-colors",
                            selectedKey === key
                              ? "bg-indigo-50 dark:bg-indigo-950/40 border-l-2 border-indigo-500"
                              : "hover:bg-muted border-l-2 border-transparent",
                          )}
                        >
                          <div className="flex-1 min-w-0">
                            <p className={cn(
                              "text-sm truncate",
                              selectedKey === key ? "font-semibold text-indigo-600 dark:text-indigo-400" : "font-medium text-foreground",
                            )}>
                              <Highlight text={note.title} query={searchQuery} />
                            </p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              {note.authorAgentId && (
                                <span className={cn(
                                  "text-[10px] px-1 py-px rounded font-medium",
                                  note.authorAgentId === "Agent"
                                    ? "bg-purple-100 text-purple-700"
                                    : "bg-blue-100 text-blue-700",
                                )}>
                                  {note.authorAgentId}
                                </span>
                              )}
                              <span className="text-[10px] text-muted-foreground/60">
                                {relativeTime(note.updatedAt)}
                              </span>
                            </div>
                          </div>
                          <div
                            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Tip content="Delete">
                              <button
                                className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-950/30 text-muted-foreground/60 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                                onClick={() => setDeleteTarget({ kind: "note", data: note })}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </Tip>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right pane — preview / edit */}
      <div className={cn(
        "flex-1 flex flex-col min-w-0",
        // Mobile: only show the content pane once a doc is selected/being created.
        !(selectedKey || creating) && "max-md:hidden",
      )}>
        {/* Toolbar */}
        {(selectedItem || creating) && (
          <div className="flex items-center justify-between px-4 py-2 border-b shrink-0 bg-background">
            <div className="flex items-center gap-2 min-w-0">
              {/* Back to the list (mobile single-pane) */}
              <button
                type="button"
                onClick={() => { setSelectedKey(null); setCreating(false); setEditing(false); }}
                className="md:hidden shrink-0 -ml-1 p-1 text-muted-foreground hover:text-foreground rounded"
                aria-label="Back to docs list"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              {editing ? (
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Doc title"
                  className="text-base font-semibold h-8 max-w-md"
                  autoFocus={creating}
                />
              ) : (
                <h2 className="text-base font-semibold text-foreground truncate">
                  {selectedTitle ? <Highlight text={selectedTitle} query={searchQuery} /> : null}
                </h2>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              {editing ? (
                <>
                  <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
                    <X className="w-3.5 h-3.5 mr-1" />
                    Cancel
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={!editTitle.trim() || saving}>
                    <Save className="w-3.5 h-3.5 mr-1" />
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </>
              ) : isNote ? (
                <Tip content="Edit doc">
                  <Button size="sm" variant="ghost" onClick={startEdit}>
                    <Pencil className="w-3.5 h-3.5 mr-1" />
                    Edit
                  </Button>
                </Tip>
              ) : null}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {!selectedItem && !creating ? (
            <EmptyState
              icon={<FileText className="w-5 h-5" />}
              title={allItems.length === 0 ? "No docs yet" : "Select a doc"}
              description={
                allItems.length === 0
                  ? "Create your first doc to get started."
                  : "Choose a doc from the sidebar to view it."
              }
              action={
                allItems.length === 0 ? (
                  <Button size="sm" onClick={startCreate}>
                    <Plus className="w-4 h-4 mr-1" />
                    New Doc
                  </Button>
                ) : undefined
              }
            />
          ) : editing ? (
            <div className="flex-1 h-full p-4">
              <Textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="Write your doc in Markdown..."
                className="font-mono text-sm resize-none h-full min-h-[300px]"
                autoFocus={!creating}
              />
            </div>
          ) : selectedContent !== null ? (
            <div className="p-6">
              {selectedContent.trim() ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeSanitize]}
                  components={mdComponents as never}
                >
                  {selectedContent}
                </ReactMarkdown>
              ) : (
                <p className="text-sm text-muted-foreground/60 italic">This doc is empty.</p>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Delete confirmation */}
      <ConfirmationDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={deleteTarget?.kind === "plan" ? "Delete Plan" : "Delete Doc"}
        description={`Are you sure you want to delete "${deleteTarget?.kind === "note" ? deleteTarget.data.title : deleteTarget?.data.title}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
