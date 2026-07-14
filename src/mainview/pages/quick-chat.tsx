import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ChatLayout } from "../components/chat/chat-layout";
import { NotesTab } from "../components/notes/notes-tab";
import { useChatStore } from "../stores/chat-store";
import { rpc } from "../lib/rpc";
import { toast } from "../components/ui/toast";
import { MessageSquare, FileText, FolderPlus, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { AGENT_BADGE_COLORS } from "../components/chat/message-parts";
import { takePendingQuickChatConversationId } from "../lib/quick-chat-fallback";

type QuickChatTab = "chat" | "notes";

/**
 * Quick Chat window — a reduced-chrome page (no main app Sidebar/TopNav, see
 * app-shell.tsx's /quick-chat bypass) for a project-less chat session opened
 * via the OS Explorer "Open in AgentDesk" entry. Deliberately a separate,
 * trimmed component rather than a parameterized ProjectPage — mirrors how
 * Playground is its own page rather than a ProjectPage variant. See
 * docs/quick-chat-plan.md.
 */
export function QuickChatPage() {
  const { projectId } = useParams({ strict: false }) as { projectId?: string };
  const [activeTab, setActiveTab] = useState<QuickChatTab>("chat");
  const [promoting, setPromoting] = useState(false);
  const [confirmPromote, setConfirmPromote] = useState(false);

  const setActiveProject = useChatStore((s) => s.setActiveProject);
  const loadConversations = useChatStore((s) => s.loadConversations);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const resetChat = useChatStore((s) => s.reset);
  const activeInlineAgent = useChatStore((s) => s.activeInlineAgent);

  // The window was opened with a specific conversation already chosen (see
  // src/bun/quick-chat/window.ts) — read it once from the hash query string
  // ("#/quick-chat/<id>?c=<conversationId>"), the same raw window.location.hash
  // source lib/rpc.ts's getViewState handler already treats as canonical.
  // Falls back to quick-chat-fallback.ts's bridge if the hash's "?c=" came up
  // empty — the pull-based route-recovery path (App.tsx) already has the
  // conversationId in hand from its own RPC response when it navigates here,
  // so it hands it off directly instead of round-tripping through the hash.
  const initialConversationId = useMemo(() => {
    const hash = window.location.hash;
    const qIndex = hash.indexOf("?");
    const fromHash = qIndex === -1 ? null : new URLSearchParams(hash.slice(qIndex + 1)).get("c");
    return fromHash ?? takePendingQuickChatConversationId();
  }, []);

  useEffect(() => {
    if (!projectId) return;
    resetChat();
    setActiveProject(projectId);

    loadConversations(projectId).then(() => {
      const { conversations } = useChatStore.getState();
      const target = initialConversationId && conversations.some((c) => c.id === initialConversationId)
        ? initialConversationId
        : conversations[0]?.id;
      if (target) {
        setActiveConversation(target);
        loadMessages(target);
      }
    });

    return () => {
      resetChat();
      setActiveProject(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/60">
        No project selected
      </div>
    );
  }

  const handleCreateProject = async () => {
    setPromoting(true);
    try {
      const result = await rpc.promoteQuickChatProject(projectId);
      if (result.success) {
        toast("success", "Project created — find it on your Dashboard.");
        setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 1200);
      } else {
        toast("error", result.error ?? "Failed to create project.");
      }
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Failed to create project.");
    } finally {
      setPromoting(false);
      setConfirmPromote(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar — Chat / Docs only, no Settings/Kanban/Git/Issue Tracker/Remote/Deploy */}
      <div className="flex flex-wrap items-center border-b px-4 py-1 shrink-0">
        <button
          onClick={() => setActiveTab("chat")}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "chat"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Chat
        </button>
        <button
          onClick={() => setActiveTab("notes")}
          className={cn(
            "flex items-center gap-1 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "notes"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <FileText className="w-3.5 h-3.5" />
          Docs
        </button>

        {/* Running agent name + Create Project — pushed right. No TopNav/project
            switcher is mounted for this route (see app-shell.tsx), so this is
            the header-actions equivalent Playground gets via useHeaderActions. */}
        <div className="ml-auto flex items-center gap-3 text-xs font-medium">
          {activeInlineAgent && (() => {
            const agentName = activeInlineAgent.agentName ?? "";
            const displayName = activeInlineAgent.agentDisplayName ?? agentName;
            const badgeClass = AGENT_BADGE_COLORS[agentName.split("#")[0]] ?? "bg-muted text-muted-foreground ring-border";
            return (
              <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ring-1", badgeClass)}>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-current" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
                </span>
                {displayName}
              </span>
            );
          })()}
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => setConfirmPromote(true)}
            disabled={promoting}
          >
            {promoting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderPlus className="w-3.5 h-3.5" />}
            Create Project
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === "chat" && <ChatLayout projectId={projectId} defaultSidebarOpen sidebarManualOnly />}
        {activeTab === "notes" && <NotesTab projectId={projectId} />}
      </div>

      {confirmPromote && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !promoting && setConfirmPromote(false)}>
          <div
            className="bg-background border border-border rounded-lg shadow-lg p-5 max-w-sm w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold mb-1.5">Create Project</h3>
            <p className="text-sm text-muted-foreground mb-4">
              This folder will become a normal AgentDesk project, visible on your Dashboard with the full Kanban and Git workflow. Nothing on disk is copied or moved.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmPromote(false)}
                disabled={promoting}
                className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateProject}
                disabled={promoting}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {promoting ? "Creating…" : "Create Project"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
