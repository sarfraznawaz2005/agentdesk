// ---------------------------------------------------------------------------
// Auto-Earn — freelance-expert dashboard
//
// Surfaces the autonomous pipeline: earnings/success metrics, the needs-attention
// (escalation) queue, and the job list with state + per-job audit timeline.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { getCurrencySymbol } from "../../../shared/freelance-currencies";
import type {
  FreelanceEarningsDto,
  FreelanceEscalationDto,
  FreelanceJobDto,
} from "../../../shared/rpc/freelance";

export function ExpertDashboard() {
  const [earnings, setEarnings] = useState<FreelanceEarningsDto | null>(null);
  const [escalations, setEscalations] = useState<FreelanceEscalationDto[]>([]);
  const [jobs, setJobs] = useState<FreelanceJobDto[]>([]);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<Array<{ action: string; detail: string | null; outcome: string; createdAt: string }>>([]);
  // Show earnings in the user's preferred currency (Freelance → Settings).
  const [currencySym, setCurrencySym] = useState("$");

  const refresh = useCallback(() => {
    rpc.freelanceGetEarnings().then(setEarnings).catch(() => {});
    rpc.freelanceGetEscalations("open").then((r) => setEscalations(r.items)).catch(() => {});
    rpc.freelanceGetJobs().then((r) => setJobs(r.jobs)).catch(() => {});
    rpc.freelanceGetSettings().then((s) => setCurrencySym(getCurrencySymbol(s.preferredCurrency || "USD"))).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const on = () => refresh();
    window.addEventListener("agentdesk:freelance-escalation-created", on);
    window.addEventListener("agentdesk:freelance-escalation-resolved", on);
    window.addEventListener("agentdesk:freelance-job-updated", on);
    const t = setInterval(refresh, 20_000);
    return () => {
      window.removeEventListener("agentdesk:freelance-escalation-created", on);
      window.removeEventListener("agentdesk:freelance-escalation-resolved", on);
      window.removeEventListener("agentdesk:freelance-job-updated", on);
      clearInterval(t);
    };
  }, [refresh]);

  const openTimeline = (jobId: string) => {
    setOpenJobId(jobId);
    rpc.freelanceGetJobTimeline(jobId).then((r) => setTimeline(r.entries)).catch(() => {});
  };

  const resolve = (id: string) => {
    rpc.freelanceResolveEscalation(id).then(refresh).catch(() => {});
  };

  const approveDelivery = (jobId: string) => {
    rpc.freelanceApproveDelivery(jobId).then(refresh).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Earnings + performance metrics — 4 per row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Bids sent" value={earnings?.bidsSent ?? 0} />
        <Metric label="Jobs won" value={earnings?.jobsWon ?? 0} />
        <Metric label="Delivered" value={earnings?.delivered ?? 0} />
        <Metric label="Earned" value={earnings?.earned ?? 0} prefix={currencySym} />
        <Metric label="Open alerts" value={earnings?.openEscalations ?? 0} highlight={(earnings?.openEscalations ?? 0) > 0} />
        <Metric label="Win rate" value={earnings?.conversionPct ?? 0} suffix="%" />
        <Metric label="Bids → won" value={`${earnings?.jobsWon ?? 0}/${earnings?.bidsSent ?? 0}`} />
        <Metric
          label="Avg response"
          value={earnings?.avgResponseMinutes ? formatMinutes(earnings.avgResponseMinutes) : "—"}
        />
      </div>

      {/* Escalations / needs-attention */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">Needs attention</h3>
        {escalations.length === 0 ? (
          <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
            Nothing needs your attention. The agent will alert you here (and via desktop/channels) if it gets stuck.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {escalations.map((e) => (
              <li key={e.id} className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <div className="flex items-start gap-2">
                  <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] uppercase ${e.severity === "blocker" ? "bg-red-500/20 text-red-600 dark:text-red-400" : "bg-amber-500/20 text-amber-700 dark:text-amber-400"}`}>
                    {e.severity}
                  </span>
                  <div className="flex-1">
                    <div className="font-medium">{e.reason}</div>
                    {e.detail && <div className="mt-0.5 text-muted-foreground">{e.detail}</div>}
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    {e.reason.startsWith("Ready to deliver") && e.jobId && (
                      <button
                        onClick={() => approveDelivery(e.jobId as string)}
                        className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:opacity-90"
                      >
                        Approve delivery
                      </button>
                    )}
                    <button onClick={() => resolve(e.id)} className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent">
                      Resolve
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Jobs */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">Jobs</h3>
        {jobs.length === 0 ? (
          <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">No jobs yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {jobs.map((j) => (
              <li key={j.id}>
                <button onClick={() => openTimeline(j.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{j.state}</span>
                  <span className="flex-1 truncate">{j.title || `Job ${j.id.slice(0, 8)}`}</span>
                  {j.earned > 0 && <span className="text-green-500">{currencySym}{j.earned}</span>}
                </button>
                {openJobId === j.id && (
                  <div className="border-t border-border bg-muted/30 px-3 py-2 text-xs">
                    {timeline.length === 0 ? (
                      <span className="text-muted-foreground">No activity recorded.</span>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {timeline.map((t, i) => (
                          <li key={i} className={t.outcome === "error" ? "text-red-500" : "text-muted-foreground"}>
                            <span className="font-mono">{new Date(t.createdAt).toLocaleTimeString()}</span> · <strong>{t.action}</strong>
                            {t.detail ? ` — ${t.detail}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  prefix,
  suffix,
  highlight,
}: {
  label: string;
  value: number | string;
  prefix?: string;
  suffix?: string;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-md border p-3 ${highlight ? "border-amber-500/50 bg-amber-500/10" : "border-border"}`}>
      <div className="text-xl font-semibold">{prefix}{value}{suffix}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}
