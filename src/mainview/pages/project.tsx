import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChatLayout } from "../components/chat/chat-layout";
import { KanbanBoard } from "../components/kanban/kanban-board";
import { TaskDetailModal } from "../components/kanban/task-detail-modal";
import { GitTab } from "../components/git/git-tab";
import { IssueTrackerTab } from "../components/issues/issue-tracker-tab";
import { DeployTab } from "../components/deploy/deploy-tab";
import { RemoteSyncTab } from "../components/remote-sync/remote-sync-tab";
import { NotesTab } from "../components/notes/notes-tab";
import { ProjectSettingsTab } from "../components/project-settings/project-settings-tab";
import { useChatStore } from "../stores/chat-store";
import { useKanbanStore, type KanbanColumn } from "../stores/kanban-store";
import { useUnreadStore, hasUnread, hasUnreadPrefix } from "../stores/unread-store";
import { UnreadDot } from "../components/ui/unread-dot";
import { cn } from "../lib/utils";
import { rpc } from "../lib/rpc";
import { FileText, Settings, Puzzle, ServerCog, MessageSquare, LayoutGrid, GitBranch, Rocket, ListChecks } from "lucide-react";
import { Tip } from "../components/ui/tooltip";
import { AGENT_BADGE_COLORS } from "../components/chat/message-parts";

type ProjectTab = "chat" | "kanban" | "git" | "issues" | "deploy" | "remote" | "notes" | "settings" | string;

interface PluginTab {
  id: string;
  label: string;
  description?: string;
  pluginName: string;
}

export function ProjectPage() {
  const { projectId } = useParams({ strict: false });
  const [activeTab, setActiveTab] = useState<ProjectTab>("chat");
  const [pluginTabs, setPluginTabs] = useState<PluginTab[]>([]);
  // Unread agent-activity dots (per-tab). `chat` clears as soon as the Chat tab is
  // active; the git/issue-fixer dots only clear at their leaf (History inner tab).
  const chatUnread = useUnreadStore(hasUnread(projectId ?? "", "chat"));
  // Auto Issues Fixer now lives under the Issue Tracker tab.
  const issueFixerUnread = useUnreadStore(hasUnreadPrefix(projectId ?? "", "issue-fixer"));
  const markSeen = useUnreadStore((s) => s.markSeen);
  const markCardSeen = useUnreadStore((s) => s.markCardSeen);
  // Tracks which projectId's conversations are fully loaded in the store.
  // Using a project-scoped ID (not a plain boolean) prevents Effect 2 from
  // firing with stale conversationsLoaded=true while conversations are still
  // being reset/reloaded after a project switch.
  const [conversationsLoadedForProject, setConversationsLoadedForProject] = useState<string | null>(null);

  const loadConversations = useChatStore((s) => s.loadConversations);
  const createConversation = useChatStore((s) => s.createConversation);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const resetChat = useChatStore((s) => s.reset);
  const syncRunningAgents = useChatStore((s) => s.syncRunningAgents);

  const activeInlineAgent = useChatStore((s) => s.activeInlineAgent);

  const tasks = useKanbanStore((s) => s.tasks);
  const selectedTaskId = useKanbanStore((s) => s.selectedTaskId);
  const selectTask = useKanbanStore((s) => s.selectTask);
  const createTask = useKanbanStore((s) => s.createTask);
  const loadTasks = useKanbanStore((s) => s.loadTasks);
  const resetKanban = useKanbanStore((s) => s.reset);

  const selectedTask = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  // Load plugin-contributed project tabs
  useEffect(() => {
    rpc.getPluginExtensions().then((ext) => {
      setPluginTabs(ext.projectTabs);
    }).catch(() => {});
  }, []);

  // Listen for tab-switch events dispatched from child components (e.g. docs tab "View all notes")
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tab) setActiveTab(detail.tab as ProjectTab);
    };
    window.addEventListener("agentdesk:switch-tab", handler);
    return () => window.removeEventListener("agentdesk:switch-tab", handler);
  }, []);

  // Opening a project acknowledges its dashboard-card dot (so the user isn't forced
  // to open every unread leaf to clear the card). The per-tab/leaf dots persist
  // until each is opened; only NEW activity after this re-lights the card.
  useEffect(() => {
    if (projectId) markCardSeen(projectId);
  }, [projectId, markCardSeen]);

  // Viewing the Chat tab marks its agent activity read — on open, and immediately
  // if new activity streams in while it's the active tab (no need to read it).
  useEffect(() => {
    if (activeTab === "chat" && chatUnread && projectId) markSeen(projectId, "chat");
  }, [activeTab, chatUnread, projectId, markSeen]);

  // Load conversations on mount / project change
  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    // Reset loaded marker synchronously so Effect 2 exits early in the same
    // render cycle — prevents it from running with stale data while we reload.
    setConversationsLoadedForProject(null); // eslint-disable-line react-hooks/set-state-in-effect
    setActiveTab("chat");
    resetChat();
    resetKanban();

    loadConversations(projectId).then(() => {
      if (cancelled) return;
      setConversationsLoadedForProject(projectId);
      // Restore active-agent indicators lost when resetChat() cleared them on unmount
      syncRunningAgents(projectId);
      // Defer kanban load until after conversations (critical path) are ready
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(() => { if (!cancelled) loadTasks(projectId); });
      } else {
        setTimeout(() => { if (!cancelled) loadTasks(projectId); }, 100);
      }
    }).catch(() => {
      if (!cancelled) {
        setConversationsLoadedForProject(projectId);
        loadTasks(projectId);
      }
    });

    return () => {
      cancelled = true;
      resetChat();
      resetKanban();
    };
  }, [projectId, loadConversations, loadTasks, resetChat, resetKanban, syncRunningAgents]);

  // Auto-select the most recent conversation, or create one if none exist.
  // Keyed on conversationsLoadedForProject (not a plain boolean) so this effect
  // never fires while conversations are being reset mid-project-switch.
  useEffect(() => {
    if (!projectId || conversationsLoadedForProject !== projectId) return;

    const { conversations, activeConversationId } = useChatStore.getState();

    // Filter to the current project — guards against a stale loadConversations
    // from a previous project resolving late and overwriting the store.
    const projectConvs = conversations.filter((c) => c.projectId === projectId);

    if (projectConvs.length === 0) {
      createConversation(projectId).then((id) => {
        setActiveConversation(id);
        loadMessages(id);
      });
      return;
    }

    if (!activeConversationId) {
      // Prefer the last conversation the user was switched to (e.g. a task conv),
      // falling back to the most recently updated one.
      const target = projectConvs[0];
      setActiveConversation(target.id);
      loadMessages(target.id);
    }
  }, [projectId, conversationsLoadedForProject, createConversation, setActiveConversation, loadMessages]);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/60">
        No project selected
      </div>
    );
  }

  const handleCreateTask = async (column: KanbanColumn) => {
    // Create the card, then immediately open its detail dialog so the user can fill it in
    // without having to click the freshly-created card.
    const id = await createTask({ projectId, title: "New task", column });
    if (id) selectTask(id);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex flex-wrap items-center border-b px-4 shrink-0">
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
          {chatUnread && <UnreadDot />}
        </button>
        <button
          onClick={() => setActiveTab("kanban")}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "kanban"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          Kanban
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
        <button
          onClick={() => setActiveTab("git")}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "git"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <GitBranch className="w-3.5 h-3.5" />
          Git
        </button>
        <button
          onClick={() => setActiveTab("issues")}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "issues"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <ListChecks className="w-3.5 h-3.5" />
          Issue Tracker
          {/* Cascade dot for unseen Auto Issues Fixer activity (the deeper History dot still
              guides the user to the exact leaf). */}
          {issueFixerUnread && activeTab !== "issues" && <UnreadDot />}
        </button>
        <button
          onClick={() => setActiveTab("remote")}
          className={cn(
            "flex items-center gap-1 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "remote"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <ServerCog className="w-3.5 h-3.5" />
          Remote
        </button>
        <button
          onClick={() => setActiveTab("deploy")}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "deploy"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Rocket className="w-3.5 h-3.5" />
          Deploy
        </button>
        <button
          onClick={() => setActiveTab("settings")}
          className={cn(
            "flex items-center gap-1 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "settings"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Settings className="w-3.5 h-3.5" />
          Settings
        </button>
        {pluginTabs.map((pt) => (
          <button
            key={`plugin-${pt.pluginName}-${pt.id}`}
            onClick={() => setActiveTab(`plugin:${pt.pluginName}:${pt.id}`)}
            className={cn(
              "flex items-center gap-1 px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
              activeTab === `plugin:${pt.pluginName}:${pt.id}`
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Puzzle className="w-3.5 h-3.5" />
            {pt.label}
          </button>
        ))}

        {/* Agent name + kanban counts — pushed right */}
        <div className="ml-auto flex items-center gap-4 text-xs font-medium">
          {/* Running agent name */}
          {activeInlineAgent && (() => {
            const agentName = activeInlineAgent.agentName ?? "";
            const displayName = activeInlineAgent.agentDisplayName ?? agentName;
            const badgeClass = AGENT_BADGE_COLORS[agentName.split("#")[0]] ?? "bg-muted text-muted-foreground ring-border";
            return (
              <>
                <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ring-1", badgeClass)}>
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-current" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
                  </span>
                  {displayName}
                </span>
              </>
            );
          })()}

          {/* Kanban counts */}
          {tasks.length > 0 && (
            <>
            {activeInlineAgent && <div className="w-px h-3 bg-border flex-shrink-0" aria-hidden="true" />}
            <div className="flex items-center gap-1.5">
            <Tip content="Backlog">
              <span className="px-2 py-1 rounded bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 tabular-nums cursor-default">
                {tasks.filter((t) => t.column === "backlog").length}
              </span>
            </Tip>
            <Tip content="Working">
              <span className="px-2 py-1 rounded bg-blue-500/10 text-blue-500 dark:text-blue-400 tabular-nums cursor-default">
                {tasks.filter((t) => t.column === "working").length}
              </span>
            </Tip>
            <Tip content="Review">
              <span className="px-2 py-1 rounded bg-amber-500/10 text-amber-500 dark:text-amber-400 tabular-nums cursor-default">
                {tasks.filter((t) => t.column === "review").length}
              </span>
            </Tip>
            <Tip content="Done">
              <span className="px-2 py-1 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 tabular-nums cursor-default">
                {tasks.filter((t) => t.column === "done").length}
              </span>
            </Tip>
            </div>
            </>
          )}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "chat" && <ChatLayout projectId={projectId} />}
        {activeTab === "kanban" && (
          <KanbanBoard
            projectId={projectId}
            onTaskClick={(taskId) => selectTask(taskId)}
            onCreateTask={handleCreateTask}
          />
        )}
        {activeTab === "git" && <GitTab projectId={projectId} />}
        {activeTab === "issues" && <IssueTrackerTab projectId={projectId} />}
        {activeTab === "deploy" && <DeployTab projectId={projectId} />}
        {activeTab === "remote" && <RemoteSyncTab projectId={projectId} />}
        {activeTab === "notes" && <NotesTab projectId={projectId} />}
        {activeTab === "settings" && (
          <ProjectSettingsTab projectId={projectId} />
        )}
        {activeTab.startsWith("plugin:") && (
          <div className="flex items-center justify-center h-full text-muted-foreground p-8">
            <div className="text-center space-y-2">
              <Puzzle className="w-8 h-8 mx-auto opacity-50" />
              <p className="text-sm font-medium">
                {pluginTabs.find((pt) => activeTab === `plugin:${pt.pluginName}:${pt.id}`)?.label ?? "Plugin Tab"}
              </p>
              <p className="text-xs">
                {pluginTabs.find((pt) => activeTab === `plugin:${pt.pluginName}:${pt.id}`)?.description
                  ?? "This tab is provided by a plugin."}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Task detail modal */}
      <TaskDetailModal
        task={selectedTask}
        open={!!selectedTask}
        onClose={() => selectTask(null)}
      />
    </div>
  );
}
