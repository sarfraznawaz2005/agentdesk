import { useEffect, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { FileText, ExternalLink, FolderOpen, Download } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { MermaidDiagram } from "@/components/ui/mermaid-diagram";
import { cn } from "@/lib/utils";
import { rpc } from "../../lib/rpc";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";

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

interface SelectedDoc {
  title: string;
  content: string;
  subtitle?: string;
}

interface DocsTabProps {
  projectId?: string;
}

export interface DocsTabHandle {
  refresh: () => void;
}

export const DocsTab = forwardRef<DocsTabHandle, DocsTabProps>(function DocsTab({ projectId }, ref) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<SelectedDoc | null>(null);

  const loadDocs = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const [notesResult, plansResult] = await Promise.all([
        rpc.getProjectNotes(projectId),
        rpc.getWorkspacePlans(projectId),
      ]);
      setNotes(notesResult as Note[]);
      setPlans(plansResult as Plan[]);
    } catch {
      // Silently fail — empty state shown
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  // Load docs on mount and when projectId changes
  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  // Expose refresh() to parent via ref so the context-panel toolbar can trigger it
  useImperativeHandle(ref, () => ({ refresh: loadDocs }), [loadDocs]);

  // Refresh docs when agents finish, PM stream completes, or a kanban task moves columns
  useEffect(() => {
    const refresh = () => loadDocs();
    const onKanbanMove = (e: Event) => {
      const { action } = (e as CustomEvent<{ action: string }>).detail ?? {};
      if (action === "moved") loadDocs();
    };
    window.addEventListener("agentdesk:agent-inline-complete", refresh);
    window.addEventListener("agentdesk:stream-complete", refresh);
    window.addEventListener("agentdesk:kanban-task-updated", onKanbanMove);
    return () => {
      window.removeEventListener("agentdesk:agent-inline-complete", refresh);
      window.removeEventListener("agentdesk:stream-complete", refresh);
      window.removeEventListener("agentdesk:kanban-task-updated", onKanbanMove);
    };
  }, [loadDocs]);

  const handleViewAllNotes = () => {
    window.dispatchEvent(
      new CustomEvent("agentdesk:switch-tab", { detail: { tab: "notes" } }),
    );
  };

  const openNote = (note: Note) => {
    setSelectedDoc({
      title: note.title,
      content: note.content,
      subtitle: [
        note.authorAgentId ? `by ${note.authorAgentId}` : null,
        `Updated ${new Date(note.updatedAt).toLocaleString()}`,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  };

  const openPlan = (plan: Plan) => {
    setSelectedDoc({
      title: plan.title,
      content: plan.content,
      subtitle: `Updated ${new Date(plan.updatedAt).toLocaleString()}`,
    });
  };

  const hasContent = notes.length > 0 || plans.length > 0;

  const downloadSelectedDoc = () => {
    if (!selectedDoc) return;
    // Sanitize the title for filesystem use: replace runs of unsafe chars with a single dash.
    const safeName = selectedDoc.title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "document";
    const filename = `${safeName}.md`;
    try {
      const blob = new Blob([selectedDoc.content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("success", `Downloaded "${filename}"`);
    } catch {
      toast("error", "Failed to download document.");
    }
  };

  // Empty state
  if (!projectId || (!isLoading && !hasContent)) {
    return (
      <div
        id="docs-tab-panel"
        role="tabpanel"
        aria-label="Docs"
        className="flex-1 flex items-center justify-center p-4"
      >
        <div className="text-center">
          <FileText className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">No documents yet</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Agent-created docs will appear here
          </p>
        </div>
      </div>
    );
  }

  // Loading state (only shown before any data has loaded)
  if (isLoading && !hasContent) {
    return (
      <div
        id="docs-tab-panel"
        role="tabpanel"
        aria-label="Docs"
        className="flex-1 flex items-center justify-center p-4"
      >
        <p className="text-sm text-muted-foreground/60">Loading docs...</p>
      </div>
    );
  }

  return (
    <div
      id="docs-tab-panel"
      role="tabpanel"
      aria-label="Docs"
      className="flex flex-col flex-1 min-h-0"
    >
      <div className="flex-1 overflow-y-auto">
        {/* Plans section */}
        {plans.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted border-b border-border">
              <FolderOpen className="w-3 h-3 text-muted-foreground/60" aria-hidden="true" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Plans
              </span>
            </div>
            {plans.map((plan) => (
              <button
                key={plan.path}
                onClick={() => openPlan(plan)}
                className={cn(
                  "w-full text-left px-3 py-2.5 border-b border-border/50",
                  "hover:bg-muted transition-colors",
                  "focus:outline-none focus:bg-muted",
                )}
              >
                <div className="flex items-start gap-2">
                  <FileText
                    className="w-4 h-4 text-blue-400 mt-0.5 shrink-0"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">
                      {plan.title}
                    </p>
                    <p className="text-xs text-muted-foreground/60 mt-0.5 line-clamp-2">
                      {plan.content.slice(0, 120)}
                      {plan.content.length > 120 ? "..." : ""}
                    </p>
                    <span className="text-[10px] text-muted-foreground/60 mt-1 block">
                      {new Date(plan.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </>
        )}

        {/* Docs section */}
        {notes.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted border-b border-border">
              <FileText className="w-3 h-3 text-muted-foreground/60" aria-hidden="true" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Docs
              </span>
            </div>
            {notes.map((note) => (
              <button
                key={note.id}
                onClick={() => openNote(note)}
                className={cn(
                  "w-full text-left px-3 py-2.5 border-b border-border/50",
                  "hover:bg-muted transition-colors",
                  "focus:outline-none focus:bg-muted",
                )}
              >
                <div className="flex items-start gap-2">
                  <FileText
                    className="w-4 h-4 text-muted-foreground/60 mt-0.5 shrink-0"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">
                      {note.title}
                    </p>
                    <p className="text-xs text-muted-foreground/60 mt-0.5 line-clamp-2">
                      {note.content.slice(0, 120)}
                      {note.content.length > 120 ? "..." : ""}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      {note.authorAgentId && (
                        <span className="text-[10px] text-muted-foreground/60">
                          {note.authorAgentId}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground/60">
                        {new Date(note.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </>
        )}
      </div>

      {/* View all docs link */}
      <div className="shrink-0 border-t border-border/50 px-3 py-2">
        <button
          onClick={handleViewAllNotes}
          className={cn(
            "flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors",
            "focus:outline-none focus:underline",
          )}
        >
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
          View all docs
        </button>
      </div>

      {/* Document detail modal */}
      <Dialog
        open={selectedDoc !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedDoc(null);
        }}
      >
        <DialogContent
          className="max-w-2xl max-h-[80vh] flex flex-col"
          // Prevent Radix Dialog from auto-focusing the first interactive element
          // (the download button), which was triggering its tooltip on every open.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <div className="flex items-center gap-2 pr-8">
              <DialogTitle>{selectedDoc?.title}</DialogTitle>
              {selectedDoc && (
                <Tip content="Download as .md file" side="bottom">
                  <button
                    type="button"
                    onClick={(e) => {
                      downloadSelectedDoc();
                      e.currentTarget.blur();
                    }}
                    className="shrink-0 p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    aria-label="Download as .md file"
                  >
                    <Download className="w-4 h-4" aria-hidden="true" />
                  </button>
                </Tip>
              )}
            </div>
            {selectedDoc?.subtitle && (
              <p className="text-xs text-muted-foreground/60 mt-1 pr-8">{selectedDoc.subtitle}</p>
            )}
          </DialogHeader>

          <div className="flex-1 overflow-y-auto min-h-0 mt-2">
            {selectedDoc && (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSanitize]}
                components={{
                   
                  code({ className, children, ref: _ref, ...props }) {
                    const match = /language-(\w+)/.exec(className ?? "");
                    if (match?.[1] === "mermaid") {
                      return <MermaidDiagram code={String(children).trim()} />;
                    }
                    if (!match) {
                      return (
                        <code className="px-1.5 py-0.5 rounded text-sm font-mono bg-muted text-foreground" {...props}>
                          {children}
                        </code>
                      );
                    }
                    return (
                      <pre className="my-3 rounded-lg bg-gray-900 text-gray-100 p-4 overflow-x-auto text-sm font-mono leading-relaxed">
                        <code>{children}</code>
                      </pre>
                    );
                  },
                  p: ({ children }) => <p className="mb-3 last:mb-0 text-sm text-foreground leading-relaxed">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc pl-5 mb-3 space-y-1 text-sm text-foreground">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 space-y-1 text-sm text-foreground">{children}</ol>,
                  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                  h1: ({ children }) => <h1 className="text-xl font-bold mb-3 mt-5 first:mt-0 text-foreground">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-lg font-bold mb-2 mt-4 first:mt-0 text-foreground">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-base font-semibold mb-2 mt-3 first:mt-0 text-foreground">{children}</h3>,
                  h4: ({ children }) => <h4 className="text-sm font-semibold mb-1 mt-2 first:mt-0 text-foreground">{children}</h4>,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-4 border-border pl-4 italic mb-3 text-muted-foreground">{children}</blockquote>
                  ),
                  a: ({ href, children }) => (
                    <a href={href} className="text-indigo-600 hover:text-indigo-800 underline" target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                  hr: () => <hr className="my-4 border-border" />,
                  table: ({ children }) => (
                    <div className="overflow-x-auto mb-3">
                      <table className="min-w-full text-sm border-collapse">{children}</table>
                    </div>
                  ),
                  th: ({ children }) => (
                    <th className="border border-border px-3 py-1.5 bg-muted/50 font-semibold text-left text-foreground">{children}</th>
                  ),
                  td: ({ children }) => (
                    <td className="border border-border px-3 py-1.5 text-foreground/80">{children}</td>
                  ),
                  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                  em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
                }}
              >
                {selectedDoc.content}
              </ReactMarkdown>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
});
