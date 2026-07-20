import { useState, useEffect } from "react";
import { rpc } from "@/lib/rpc";
import { AmbientChrome, AmbientRadarContent, type AmbientProjectRow } from "@/components/ambient/ambient-radar-view";
import type { AmbientActivityLogEntry } from "../../shared/rpc/ambient";

const POLL_INTERVAL_MS = 4000;

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Ambient Mode projected onto a second display/TV (docs/ambient-screen-plan.md
 * Subsystem 7). Loaded by a dedicated, project-less BrowserWindow
 * (src/bun/ambient/window.ts) — broadcastToProject's per-project routing
 * never reaches a window with no associated project, so this polls a
 * snapshot RPC instead of the live push-broadcast path the main overlay uses.
 * No keyboard is assumed on a kiosk display, so — unlike the main overlay,
 * which relies on Esc — this always shows a visible, touch-reachable Exit
 * control.
 */
export function AmbientDisplayPage() {
  const [projectRows, setProjectRows] = useState<AmbientProjectRow[]>([]);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [agentsActiveNow, setAgentsActiveNow] = useState(0);
  const [tasksDone, setTasksDone] = useState(0);
  const [awaitingYou, setAwaitingYou] = useState(0);
  const [activityLog, setActivityLog] = useState<AmbientActivityLogEntry[]>([]);
  const clock = useClock();

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      rpc.getAmbientActivitySnapshot().then((snapshot) => {
        if (cancelled) return;
        const ids = new Set([
          ...Object.keys(snapshot.activeProjectAgents),
          ...Object.keys(snapshot.taskStats),
        ]);
        setProjectRows(
          Array.from(ids).map((id) => ({
            id,
            name: snapshot.projectNames[id] ?? id,
            activeAgents: snapshot.activeProjectAgents[id] ?? 0,
            done: snapshot.taskStats[id]?.done ?? 0,
            total: snapshot.taskStats[id]?.total ?? 0,
          })),
        );
        setProjectNames(snapshot.projectNames);
        setAgentsActiveNow(Object.values(snapshot.activeProjectAgents).reduce((sum, n) => sum + n, 0));
        setTasksDone(Object.values(snapshot.taskStats).reduce((sum, s) => sum + s.done, 0));
        setAwaitingYou(snapshot.awaitingYou);
        setActivityLog(snapshot.activityLog);
      }).catch(() => {});
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <AmbientChrome
      brand="AgentDesk — Beacon (projected)"
      clock={clock}
      onExit={() => rpc.closeAmbientDisplayWindow().catch(() => {})}
      exitLabel="Exit"
    >
      <AmbientRadarContent
        projectRows={projectRows}
        agentsActiveNow={agentsActiveNow}
        tasksDone={tasksDone}
        awaitingYou={awaitingYou}
        projectNames={projectNames}
        activityLog={activityLog}
      />
    </AmbientChrome>
  );
}
