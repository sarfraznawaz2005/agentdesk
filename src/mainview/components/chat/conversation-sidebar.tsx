import { useState, useMemo, useRef, useEffect } from "react";
import { Plus, Pin, Pencil, Trash2, X, Check, Archive, ArchiveRestore, ChevronDown, ChevronRight, CheckSquare, Square, Clock } from "lucide-react";
import { cn } from "../../lib/utils";
import { relativeTime } from "../../lib/date-utils";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { rpc } from "../../lib/rpc";
import type { Conversation } from "../../stores/chat-store";

interface ConversationSidebarProps {
  projectId: string;
  conversations: Conversation[];
  archivedConversations?: Conversation[];
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive?: (id: string) => void;
  onRestore?: (id: string) => void;
}

export function ConversationSidebar({
  projectId,
  conversations,
  archivedConversations = [],
  activeConversationId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onPin,
  onArchive,
  onRestore,
}: ConversationSidebarProps) {
  const searchQuery = "";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [singleDeleteAgentNames, setSingleDeleteAgentNames] = useState<string[]>([]);
  const [bulkDeleteAgentNames, setBulkDeleteAgentNames] = useState<string[]>([]);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Warn before a delete silently stops agents currently working in the
  // conversation(s) being removed — conversation-scoped, so a sibling
  // conversation's agent never gets flagged as "in the way" here.
  useEffect(() => {
    if (!deleteConfirmId) return;
    let cancelled = false;
    rpc
      .getRunningAgentsForConversation(projectId, deleteConfirmId)
      .then((agents) => {
        if (!cancelled) setSingleDeleteAgentNames(agents.map((a) => a.displayName));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [deleteConfirmId, projectId]);

  useEffect(() => {
    if (!bulkDeleteConfirm) return;
    let cancelled = false;
    Promise.all(
      [...selectedIds].map((id) => rpc.getRunningAgentsForConversation(projectId, id)),
    )
      .then((results) => {
        if (cancelled) return;
        const names = new Set<string>();
        results.flat().forEach((a) => names.add(a.displayName));
        setBulkDeleteAgentNames([...names]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bulkDeleteConfirm, projectId, selectedIds]);

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Filter conversations by search
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const q = searchQuery.toLowerCase();
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, searchQuery]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filtered.forEach((c) => next.delete(c.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filtered.forEach((c) => next.add(c.id));
        return next;
      });
    }
  };

  // Focus edit input when entering rename mode
  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenuId) return;
    const handler = () => setContextMenuId(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [contextMenuId]);

  const startRename = (conv: Conversation) => {
    setEditingId(conv.id);
    setEditTitle(conv.title);
    setContextMenuId(null);
  };

  const commitRename = () => {
    if (editingId && editTitle.trim()) {
      onRename(editingId, editTitle.trim());
    }
    setEditingId(null);
    setEditTitle("");
  };

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextMenuId(id);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  };

  const isInArchivedList = (id: string) => archivedConversations.some((c) => c.id === id);

  return (
    <div className="flex flex-col h-full w-full">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 space-y-2 border-b border-border/50">
        {selectMode ? (
          <div className="flex items-center gap-2">
            <button
              onClick={toggleSelectAll}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {allFilteredSelected ? (
                <CheckSquare className="w-3.5 h-3.5 text-indigo-600" />
              ) : (
                <Square className="w-3.5 h-3.5" />
              )}
              All
            </button>
            <span className="flex-1 text-xs text-muted-foreground text-center">
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : ""}
            </span>
            <button
              onClick={exitSelectMode}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={onCreate}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New conversation
          </button>
        )}


        {/* Bulk deletion toggle — only shown when not already in select mode */}
        {!selectMode && (
          <button
            onClick={() => setSelectMode(true)}
            className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 text-xs text-muted-foreground hover:text-muted-foreground hover:bg-muted/50 rounded transition-colors border border-border bg-muted/50"
          >
            <Square className="w-3 h-3 shrink-0" />
            Bulk Deletion
          </button>
        )}
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto pb-2">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 text-center py-4">
            {searchQuery ? "No conversations match" : "No conversations yet"}
          </p>
        ) : (
          filtered.map((conv) => (
            <div
              key={conv.id}
              className={cn(
                "group relative px-3 py-2 cursor-pointer transition-colors",
                selectMode && selectedIds.has(conv.id)
                  ? "bg-indigo-50 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300"
                  : !selectMode && activeConversationId === conv.id
                  ? "bg-indigo-50 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300"
                  : "hover:bg-muted text-foreground/80"
              )}
              onClick={() => {
                if (selectMode) { toggleSelected(conv.id); return; }
                if (editingId !== conv.id) onSelect(conv.id);
              }}
              onContextMenu={(e) => !selectMode && handleContextMenu(e, conv.id)}
            >
              {editingId === conv.id ? (
                <div className="flex items-center gap-1">
                  <input
                    ref={editInputRef}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") {
                        setEditingId(null);
                        setEditTitle("");
                      }
                    }}
                    onBlur={commitRename}
                    className="flex-1 text-xs bg-background border border-indigo-300 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      commitRename();
                    }}
                    className="p-0.5 text-green-600 hover:text-green-700"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(null);
                      setEditTitle("");
                    }}
                    className="p-0.5 text-muted-foreground/60 hover:text-muted-foreground"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 min-w-0">
                    {selectMode ? (
                      selectedIds.has(conv.id) ? (
                        <CheckSquare className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                      ) : (
                        <Square className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                      )
                    ) : conv.isPinned ? (
                      <Pin className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                    ) : null}
                    <span className="text-xs font-medium truncate flex-1">
                      {conv.title}
                    </span>
                    <div className="relative group/time shrink-0 ml-2 -mr-1">
                      <div className="w-4 h-4 flex items-center justify-center">
                        <Clock className="w-3 h-3 text-muted-foreground" />
                      </div>
                      <div className="absolute right-0 top-full mt-1.5 hidden group-hover/time:block z-50 pointer-events-none">
                        <div className="absolute bottom-full right-1.5 border-4 border-transparent border-b-foreground" />
                        <div className="bg-foreground text-background text-[10px] font-medium px-2 py-1 rounded-md whitespace-nowrap shadow-lg">
                          {relativeTime(conv.updatedAt)}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))
        )}

        {/* Archived section */}
        {archivedConversations.length > 0 && (
          <div className="mt-3 border-t border-border pt-2">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showArchived ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <Archive className="w-3 h-3" />
              Archived ({archivedConversations.length})
            </button>
            {showArchived &&
              archivedConversations.map((conv) => (
                <div
                  key={conv.id}
                  className={cn(
                    "group relative px-3 py-2 cursor-pointer transition-colors",
                    activeConversationId === conv.id
                      ? "bg-muted text-foreground"
                      : "hover:bg-muted/50 text-muted-foreground"
                  )}
                  onClick={() => onSelect(conv.id)}
                  onContextMenu={(e) => handleContextMenu(e, conv.id)}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Archive className="w-3 h-3 text-muted-foreground/60 flex-shrink-0" />
                    <span className="text-xs font-medium truncate">
                      {conv.title}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground/60 mt-0.5 block">
                    {relativeTime(conv.updatedAt)}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Bulk delete action bar */}
      {selectMode && selectedIds.size > 0 && (
        <div className="shrink-0 px-3 py-2 border-t border-border bg-background">
          <button
            onClick={() => {
              setBulkDeleteAgentNames([]);
              setBulkDeleteConfirm(true);
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete {selectedIds.size} conversation{selectedIds.size !== 1 ? "s" : ""}
          </button>
        </div>
      )}

      {/* Single delete confirmation */}
      <ConfirmationDialog
        open={deleteConfirmId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirmId(null);
        }}
        title="Delete conversation"
        description={
          singleDeleteAgentNames.length > 0
            ? `${singleDeleteAgentNames.length} agent${singleDeleteAgentNames.length > 1 ? "s are" : " is"} currently working in this conversation (${singleDeleteAgentNames.join(", ")}) and will be stopped. This conversation and all its messages will be permanently deleted. This action cannot be undone.`
            : "This conversation and all its messages will be permanently deleted. This action cannot be undone."
        }
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          if (deleteConfirmId) onDelete(deleteConfirmId);
          setDeleteConfirmId(null);
        }}
        onCancel={() => setDeleteConfirmId(null)}
      />

      {/* Bulk delete confirmation */}
      <ConfirmationDialog
        open={bulkDeleteConfirm}
        onOpenChange={(open) => { if (!open) setBulkDeleteConfirm(false); }}
        title={`Delete ${selectedIds.size} conversation${selectedIds.size !== 1 ? "s" : ""}?`}
        description={
          bulkDeleteAgentNames.length > 0
            ? `${bulkDeleteAgentNames.length} agent${bulkDeleteAgentNames.length > 1 ? "s are" : " is"} currently working in the selected conversations (${bulkDeleteAgentNames.join(", ")}) and will be stopped. All selected conversations and their messages will be permanently deleted. This action cannot be undone.`
            : "All selected conversations and their messages will be permanently deleted. This action cannot be undone."
        }
        confirmLabel={`Delete ${selectedIds.size}`}
        variant="destructive"
        onConfirm={() => {
          selectedIds.forEach((id) => onDelete(id));
          setBulkDeleteConfirm(false);
          exitSelectMode();
        }}
        onCancel={() => setBulkDeleteConfirm(false)}
      />

      {/* Context Menu */}
      {contextMenuId && (
        <div
          className="fixed z-50 bg-background rounded-lg shadow-lg border border-border py-1 min-w-[140px]"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const isArchived = isInArchivedList(contextMenuId);
            const conv = isArchived
              ? archivedConversations.find((c) => c.id === contextMenuId)
              : conversations.find((c) => c.id === contextMenuId);
            if (!conv) return null;
            return (
              <>
                {isArchived ? (
                  // Archived conversation — show restore + delete
                  <>
                    {onRestore && (
                      <button
                        onClick={() => {
                          onRestore(conv.id);
                          setContextMenuId(null);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted"
                      >
                        <ArchiveRestore className="w-3 h-3" />
                        Restore
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setSingleDeleteAgentNames([]);
                        setDeleteConfirmId(conv.id);
                        setContextMenuId(null);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete
                    </button>
                  </>
                ) : (
                  // Active conversation — full context menu
                  <>
                    <button
                      onClick={() => {
                        onPin(conv.id, !conv.isPinned);
                        setContextMenuId(null);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted"
                    >
                      <Pin className="w-3 h-3" />
                      {conv.isPinned ? "Unpin" : "Pin"}
                    </button>
                    <button
                      onClick={() => startRename(conv)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted"
                    >
                      <Pencil className="w-3 h-3" />
                      Rename
                    </button>
                    {onArchive && (
                      <button
                        onClick={() => {
                          onArchive(conv.id);
                          setContextMenuId(null);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted"
                      >
                        <Archive className="w-3 h-3" />
                        Archive
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setSingleDeleteAgentNames([]);
                        setDeleteConfirmId(conv.id);
                        setContextMenuId(null);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete
                    </button>
                  </>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
