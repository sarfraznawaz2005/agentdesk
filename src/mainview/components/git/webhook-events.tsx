import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Plus, Trash2, Webhook, Activity } from "lucide-react";
import { rpc } from "../../lib/rpc";
import { Tip } from "@/components/ui/tooltip";

type WebhookConfig = Awaited<ReturnType<typeof rpc.getWebhookConfigs>>[number];
type WebhookEvent = Awaited<ReturnType<typeof rpc.getWebhookEvents>>[number];

interface WebhookEventsProps {
  projectId: string;
}

const EVENT_TYPES = ["push", "pull_request", "issues", "release"];

function eventIcon(type: string) {
  const icons: Record<string, string> = {
    push: "↑",
    pull_request: "⤴",
    issues: "○",
    release: "▲",
    workflow_run: "▷",
  };
  return icons[type] ?? "•";
}

function eventColor(type: string) {
  const colors: Record<string, string> = {
    push: "text-blue-600 dark:text-blue-400",
    pull_request: "text-purple-600 dark:text-purple-400",
    issues: "text-green-700 dark:text-green-400",
    release: "text-orange-600 dark:text-orange-400",
    workflow_run: "text-cyan-700 dark:text-cyan-400",
  };
  return colors[type] ?? "text-muted-foreground";
}

// ── Config form ───────────────────────────────────────────────────────────────

function ConfigForm({
  projectId,
  onSaved,
  onCancel,
}: {
  projectId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("My GitHub Watcher");
  const [events, setEvents] = useState<string[]>(["push", "pull_request"]);
  const [saving, setSaving] = useState(false);

  const toggle = (evt: string) => {
    setEvents((prev) =>
      prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt],
    );
  };

  const handleSave = async () => {
    if (!name.trim() || events.length === 0) return;
    setSaving(true);
    try {
      await rpc.saveWebhookConfig({ projectId, name: name.trim(), events });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border rounded-lg p-4 bg-muted/10 space-y-3">
      <h3 className="text-sm font-semibold">New Webhook Config</h3>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Config name"
        className="w-full text-sm px-3 py-2 rounded border bg-background"
      />
      <div>
        <label className="text-xs text-muted-foreground block mb-2">Events to watch</label>
        <div className="flex flex-wrap gap-2">
          {EVENT_TYPES.map((evt) => (
            <label key={evt} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={events.includes(evt)}
                onChange={() => toggle(evt)}
                className="w-3.5 h-3.5"
              />
              <span className="text-sm">{evt}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !name.trim() || events.length === 0}
          className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded border text-sm hover:bg-muted">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function WebhookEvents({ projectId }: WebhookEventsProps) {
  const [configs, setConfigs] = useState<WebhookConfig[]>([]);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [activeTab, setActiveTab] = useState<"events" | "configs">("events");
  const [pollResult, setPollResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cfgs, evts] = await Promise.all([
        rpc.getWebhookConfigs(projectId),
        rpc.getWebhookEvents(projectId, undefined, 30),
      ]);
      setConfigs(cfgs);
      setEvents(evts);
    } catch { /* empty */ } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handlePoll = async () => {
    setPolling(true);
    setPollResult(null);
    try {
      const res = await rpc.pollGithubEvents(projectId);
      if (res.error) {
        setPollResult(`Error: ${res.error}`);
      } else {
        setPollResult(`Fetched ${res.fetched} new event${res.fetched !== 1 ? "s" : ""}`);
        await refresh();
      }
    } finally {
      setPolling(false);
    }
  };

  const handleDeleteConfig = async (id: string) => {
    await rpc.deleteWebhookConfig(id);
    setConfigs((prev) => prev.filter((c) => c.id !== id));
  };

  return (
    <div className="space-y-3">
      {/* Tab switcher */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 border rounded p-0.5">
          <button
            onClick={() => setActiveTab("events")}
            className={`text-xs px-2 py-0.5 rounded ${activeTab === "events" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            Event Log
          </button>
          <button
            onClick={() => setActiveTab("configs")}
            className={`text-xs px-2 py-0.5 rounded ${activeTab === "configs" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            Configs
          </button>
        </div>
        <div className="flex items-center gap-1">
          <Tip content="Refresh webhook events">
            <button onClick={refresh} disabled={loading} className="p-1 rounded hover:bg-muted disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </Tip>
          <button
            onClick={handlePoll}
            disabled={polling}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-50"
          >
            <Activity className={`w-3 h-3 ${polling ? "animate-pulse" : ""}`} />
            {polling ? "Polling…" : "Poll GitHub"}
          </button>
        </div>
      </div>

      {pollResult && (
        <p className={`text-xs px-3 py-1.5 rounded border ${pollResult.startsWith("Error") ? "border-red-500/30 text-red-600 dark:text-red-400 bg-red-500/10" : "border-green-500/30 text-foreground bg-green-500/10"}`}>
          {pollResult}
        </p>
      )}

      {/* Event Log */}
      {activeTab === "events" && (
        <div className="space-y-1.5">
          {events.length === 0 ? (
            <div className="text-center py-6 text-sm text-muted-foreground">
              <Webhook className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No events yet. Click "Poll GitHub" to fetch recent activity.</p>
            </div>
          ) : (
            events.map((evt) => (
              <div key={evt.id} className="border rounded-lg px-3 py-2 flex items-start gap-3">
                <span className={`text-base font-mono shrink-0 ${eventColor(evt.eventType)}`}>
                  {eventIcon(evt.eventType)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium ${eventColor(evt.eventType)}`}>{evt.eventType}</span>
                    <span className="text-xs text-muted-foreground truncate">{evt.title}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{new Date(evt.createdAt).toLocaleString()}</p>
                </div>
                <span className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${evt.status === "processed" ? "border-green-500/30 text-green-700 dark:text-green-300 bg-green-500/10" : "border-yellow-500/30 text-yellow-700 dark:text-yellow-300 bg-yellow-500/10"}`}>
                  {evt.status}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Configs */}
      {activeTab === "configs" && (
        <div className="space-y-3">
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded border hover:bg-muted"
          >
            <Plus className="w-3.5 h-3.5" /> Add config
          </button>

          {showCreate && (
            <ConfigForm
              projectId={projectId}
              onSaved={() => { setShowCreate(false); refresh(); }}
              onCancel={() => setShowCreate(false)}
            />
          )}

          {configs.length === 0 && !showCreate && (
            <p className="text-xs text-muted-foreground">
              No webhook configs yet. Add one to define which GitHub events to monitor.
            </p>
          )}

          {configs.map((cfg) => (
            <div key={cfg.id} className="border rounded-lg p-3 flex items-start gap-3">
              <Webhook className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{cfg.name}</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {cfg.events.map((e) => (
                    <span key={e} className={`text-xs px-1.5 py-0.5 rounded bg-muted ${eventColor(e)}`}>{e}</span>
                  ))}
                </div>
                {cfg.lastPollAt && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last polled: {new Date(cfg.lastPollAt).toLocaleString()}
                  </p>
                )}
              </div>
              <button
                onClick={() => handleDeleteConfig(cfg.id)}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
