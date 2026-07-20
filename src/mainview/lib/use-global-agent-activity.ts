import { useState, useEffect, useCallback } from "react";
import { rpc } from "@/lib/rpc";

const ACTIVITY_LOG_LIMIT = 50;

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  projectId: string;
  /** Raw agent type key (e.g. "code-explorer"), for color-coding. Absent for non-agent entries (kanban task updates). */
  agentKey?: string;
  /** Human-readable name to render in the agent's colored badge. */
  agentLabel?: string;
  /** The rest of the line, e.g. "started: Explore the codebase" or "Task abc moved to done". */
  text: string;
}

export interface GlobalAgentActivity {
  /** Active agent count per project, kept live via agentInlineStart/Complete events + a polling safety net. */
  activeProjectAgents: Record<string, number>;
  /** Kanban done/total task counts per project. */
  taskStats: Record<string, { done: number; total: number }>;
  /** Rolling log of the last ACTIVITY_LOG_LIMIT cross-project events, newest first. */
  activityLog: ActivityLogEntry[];
}

let logIdCounter = 0;

const AGENT_KEY_ACRONYMS = new Set(["qa", "ui", "ux", "api", "db", "ml"]);

/** "code-explorer" -> "Code Explorer" — completion events only carry the raw agent key, not its display name. */
function formatAgentKey(key: string): string {
  return key
    .split(/[-_]/)
    .map((w) => (AGENT_KEY_ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Cross-project live agent/task state, shared by the Dashboard and Ambient Mode
 * so both read the same listener wiring instead of duplicating it.
 *
 * Extracted from dashboard.tsx's pre-existing activeProjectAgents/taskStats
 * polling+event logic (docs/ambient-screen-plan.md Subsystem 4) — behavior is
 * unchanged, only relocated. The activity log is the one new addition.
 */
export function useGlobalAgentActivity(): GlobalAgentActivity {
  const [activeProjectAgents, setActiveProjectAgents] = useState<Record<string, number>>({});
  const [taskStats, setTaskStats] = useState<Record<string, { done: number; total: number }>>({});
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);

  const appendLogEntry = useCallback((
    projectId: string,
    text: string,
    agent?: { key: string; label: string },
  ) => {
    const entry: ActivityLogEntry = {
      id: `${Date.now()}-${logIdCounter++}`,
      timestamp: Date.now(),
      projectId,
      agentKey: agent?.key,
      agentLabel: agent?.label,
      text,
    };
    setActivityLog((prev) => [entry, ...prev].slice(0, ACTIVITY_LOG_LIMIT));
  }, []);

  const loadTaskStats = useCallback(async () => {
    try {
      const stats = await rpc.getProjectTaskStats();
      const map: Record<string, { done: number; total: number }> = {};
      for (const s of stats) map[s.projectId] = { done: s.done, total: s.total };
      setTaskStats(map);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadTaskStats();
  }, [loadTaskStats]);

  useEffect(() => {
    const onProjectsUpdated = () => loadTaskStats();
    window.addEventListener("agentdesk:projects-updated", onProjectsUpdated);
    return () => window.removeEventListener("agentdesk:projects-updated", onProjectsUpdated);
  }, [loadTaskStats]);

  // Load initial active-agent counts and keep them up to date via events.
  // Re-fetch on agent start/complete and stream-complete (catches PM finishing
  // its summary after sub-agents are done). A 10s polling interval acts as a
  // safety net for channel-dispatched agents whose events fire before this
  // hook mounts, or for the PM planning/summary phases where no
  // agentInlineStart event fires.
  useEffect(() => {
    const fetchCounts = () => {
      rpc.getActiveProjectAgents().then((list) => {
        const counts: Record<string, number> = {};
        for (const { projectId, agentCount } of list) {
          counts[projectId] = agentCount;
        }
        setActiveProjectAgents(counts);
      }).catch(() => {});
    };

    fetchCounts();

    const interval = setInterval(fetchCounts, 10_000);

    window.addEventListener("agentdesk:agent-inline-start", fetchCounts);
    window.addEventListener("agentdesk:agent-inline-complete", fetchCounts);
    window.addEventListener("agentdesk:stream-complete", fetchCounts);
    return () => {
      clearInterval(interval);
      window.removeEventListener("agentdesk:agent-inline-start", fetchCounts);
      window.removeEventListener("agentdesk:agent-inline-complete", fetchCounts);
      window.removeEventListener("agentdesk:stream-complete", fetchCounts);
    };
  }, []);

  // Rolling activity log — appends a line per cross-project event. Each event
  // now carries projectId (added alongside this hook — see engine-manager.ts's
  // onAgentInlineStart/onAgentInlineComplete); resolving projectId to a
  // display name is left to the consumer, which already has (or fetches) the
  // project list, to avoid a duplicate rpc.getProjects() call here.
  useEffect(() => {
    const onAgentInlineStart = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; agentName: string; agentDisplayName: string; task: string }>).detail;
      if (!detail?.projectId) return;
      appendLogEntry(detail.projectId, `started: ${detail.task}`, {
        key: detail.agentName.split("#")[0],
        label: detail.agentDisplayName,
      });
    };
    const onAgentInlineComplete = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; agentName: string; status: string; summary: string }>).detail;
      if (!detail?.projectId) return;
      const verb = detail.status === "failed" ? "failed" : detail.status === "cancelled" ? "cancelled" : "completed";
      const key = detail.agentName.split("#")[0];
      appendLogEntry(detail.projectId, `${verb}: ${detail.summary || detail.status}`, {
        key,
        label: formatAgentKey(key),
      });
    };
    const onKanbanTaskUpdated = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; taskId: string; action: string; toColumn?: string; reason?: string }>).detail;
      if (!detail?.projectId) return;
      let text: string;
      if (detail.reason === "review_changes_requested") {
        text = `Task ${detail.taskId} — review requested changes, back to working`;
      } else if (detail.action === "moved" && detail.toColumn === "review") {
        text = `Task ${detail.taskId} sent to review`;
      } else if (detail.action === "moved" && detail.toColumn === "done") {
        text = `Task ${detail.taskId} — review approved, done`;
      } else {
        text = `Task ${detail.taskId} ${detail.action}`;
      }
      appendLogEntry(detail.projectId, text);
    };
    const onShellApprovalRequest = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; agentId: string; agentName: string; command: string }>).detail;
      if (!detail?.projectId) return;
      appendLogEntry(detail.projectId, `waiting for you to approve: ${detail.command}`, {
        key: detail.agentId.split("#")[0],
        label: detail.agentName,
      });
    };
    const onUserQuestionRequest = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; agentId: string; agentName: string; question: string }>).detail;
      if (!detail?.projectId) return;
      appendLogEntry(detail.projectId, `asked: ${detail.question}`, {
        key: detail.agentId.split("#")[0],
        label: detail.agentName,
      });
    };
    const onPresentPlan = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; plan: { title: string; content: string } }>).detail;
      if (!detail?.projectId) return;
      appendLogEntry(detail.projectId, `proposed a plan for approval: ${detail.plan?.title ?? ""}`);
    };

    window.addEventListener("agentdesk:agent-inline-start", onAgentInlineStart);
    window.addEventListener("agentdesk:agent-inline-complete", onAgentInlineComplete);
    window.addEventListener("agentdesk:kanban-task-updated", onKanbanTaskUpdated);
    window.addEventListener("agentdesk:shell-approval-request", onShellApprovalRequest);
    window.addEventListener("agentdesk:user-question-request", onUserQuestionRequest);
    window.addEventListener("agentdesk:plan-presented", onPresentPlan);
    return () => {
      window.removeEventListener("agentdesk:agent-inline-start", onAgentInlineStart);
      window.removeEventListener("agentdesk:agent-inline-complete", onAgentInlineComplete);
      window.removeEventListener("agentdesk:kanban-task-updated", onKanbanTaskUpdated);
      window.removeEventListener("agentdesk:shell-approval-request", onShellApprovalRequest);
      window.removeEventListener("agentdesk:user-question-request", onUserQuestionRequest);
      window.removeEventListener("agentdesk:plan-presented", onPresentPlan);
    };
  }, [appendLogEntry]);

  return { activeProjectAgents, taskStats, activityLog };
}
