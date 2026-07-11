import { useState, useEffect, useCallback } from "react";
import { Server, Plus, Trash2, Check, AlertCircle, RefreshCw } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type McpServerStatus = "connected" | "connecting" | "failed" | "disabled";

// ---------------------------------------------------------------------------
// Default MCP config template shown when config is empty
// ---------------------------------------------------------------------------
const DEFAULT_TEMPLATE = JSON.stringify(
  {
    mcpServers: {
      "example-server": {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        disabled: false,
      },
    },
  },
  null,
  2,
);

// Pretty-print valid JSON with 2-space indentation. Returns the text unchanged
// when it isn't parseable yet, so an in-progress edit is never clobbered.
function prettify(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Server list preview
// ---------------------------------------------------------------------------

function statusDot(status: McpServerStatus | undefined) {
  if (status === "connected") return "bg-green-500";
  if (status === "connecting") return "bg-yellow-400 animate-pulse";
  if (status === "failed") return "bg-red-500";
  return "bg-gray-300 dark:bg-gray-600";
}

function statusLabel(status: McpServerStatus | undefined, disabled?: boolean) {
  if (disabled) return "disabled";
  if (status === "connected") return "connected";
  if (status === "connecting") return "connecting…";
  if (status === "failed") return "failed";
  return "unknown";
}

function ServerList({
  servers,
  liveStatus,
  onReconnect,
}: {
  servers: Record<string, McpServer>;
  liveStatus: Record<string, McpServerStatus>;
  onReconnect: (name: string) => void;
}) {
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">No servers configured.</p>
    );
  }
  return (
    <ul className="space-y-3">
      {entries.map(([name, cfg]) => {
        const status = cfg.disabled ? "disabled" as McpServerStatus : liveStatus[name];
        const canReconnect = status === "failed" && !cfg.disabled;
        return (
          <li key={name} className="flex items-start gap-2">
            <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${statusDot(status)}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-none">{name}</p>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {cfg.command} {(cfg.args ?? []).join(" ")}
              </p>
              <p className={`text-xs mt-0.5 ${status === "failed" ? "text-red-500" : "text-muted-foreground"}`}>
                {statusLabel(status, cfg.disabled)}
              </p>
            </div>
            {canReconnect && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs shrink-0"
                onClick={() => onReconnect(name)}
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Retry
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function McpSettings() {
  const [raw, setRaw] = useState("");
  const [servers, setServers] = useState<Record<string, McpServer>>({});
  const [liveStatus, setLiveStatus] = useState<Record<string, McpServerStatus>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [parseError, setParseError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    rpc.getMcpStatus().then(setLiveStatus).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([rpc.getMcpConfig(), rpc.getMcpStatus()]).then(([result, status]) => {
      const text = result.raw === "{}" ? "" : result.raw;
      setRaw(prettify(typeof text === "string" ? text : ""));
      setServers(result.servers);
      setLiveStatus(status);
      setLoading(false);
    });
  }, []);

  // Poll status every 5s to reflect auto-reconnect progress
  useEffect(() => {
    const id = setInterval(refreshStatus, 5_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const handleReconnect = useCallback(async (name?: string) => {
    setReconnecting(name ?? "__all__");
    await rpc.reconnectMcpServer(name).catch(() => {});
    // Wait a moment then refresh status
    setTimeout(() => {
      refreshStatus();
      setReconnecting(null);
    }, 2_000);
  }, [refreshStatus]);

  const handleChange = (value: string) => {
    setRaw(value);
    setSaveState("idle");
    if (value.trim() === "") {
      setParseError(null);
      setServers({});
      return;
    }
    try {
      const parsed = JSON.parse(value);
      const s: Record<string, McpServer> = parsed.mcpServers ?? parsed ?? {};
      setServers(s);
      setParseError(null);
    } catch (e) {
      setParseError(String(e));
      setServers({});
    }
  };

  const handleSave = async () => {
    if (parseError) return;
    setSaveState("saving");
    const jsonToSave = raw.trim() === "" ? "{}" : prettify(raw);
    // Reflect the pretty-printed form back into the editor so it stays formatted.
    if (jsonToSave !== "{}" && jsonToSave !== raw) setRaw(jsonToSave);
    const result = await rpc.saveMcpConfig(jsonToSave);
    if (result.success) {
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } else {
      setSaveState("error");
    }
  };

  const handleLoadTemplate = () => {
    handleChange(DEFAULT_TEMPLATE);
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground p-4">Loading MCP configuration…</div>;
  }

  const serverCount = Object.keys(servers).length;
  const connectedCount = Object.values(liveStatus).filter((s) => s === "connected").length;
  const failedCount = Object.values(liveStatus).filter((s) => s === "failed").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Server className="w-5 h-5 text-muted-foreground" />
        <div>
          <h3 className="text-base font-semibold">MCP Servers</h3>
          <p className="text-sm text-muted-foreground">
            Configure Model Context Protocol servers that provide additional tools and context to agents.
          </p>
        </div>
      </div>

      {/* Status bar */}
      {serverCount > 0 && (
        <div className="flex items-center gap-3 text-sm">
          <span className="h-2 w-2 rounded-full bg-green-500" />
          <span>
            {connectedCount} of {serverCount} server{serverCount !== 1 ? "s" : ""} connected
          </span>
          {failedCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={reconnecting === "__all__"}
              onClick={() => handleReconnect()}
            >
              <RefreshCw className={`w-3 h-3 mr-1 ${reconnecting === "__all__" ? "animate-spin" : ""}`} />
              Reconnect {failedCount} failed
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* JSON editor */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Configuration JSON</CardTitle>
            <CardDescription className="text-xs">
              Paste your MCP server configuration. Supports Claude Desktop format (
              <code className="font-mono">mcpServers</code>) or flat object.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <textarea
                className={`w-full h-64 font-mono text-xs rounded-md border bg-muted/30 p-3 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                  parseError ? "border-red-400" : "border-border"
                }`}
                value={raw}
                onChange={(e) => handleChange(e.target.value)}
                onBlur={() => { const p = prettify(raw); if (p !== raw) setRaw(p); }}
                spellCheck={false}
                placeholder={DEFAULT_TEMPLATE}
              />
            </div>

            {parseError && (
              <div className="flex items-start gap-2 text-xs text-red-600">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{parseError}</span>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saveState === "saving" || !!parseError}
              >
                {saveState === "saving" ? "Saving…" : saveState === "saved" ? (
                  <span className="flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5" /> Saved
                  </span>
                ) : "Save"}
              </Button>
              {raw.trim() === "" && (
                <Button size="sm" variant="outline" onClick={handleLoadTemplate}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Load template
                </Button>
              )}
              {raw.trim() !== "" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => { handleChange(""); }}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Clear
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Server preview */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Configured Servers</CardTitle>
            <CardDescription className="text-xs">
              Live connection status. Failed servers retry automatically with backoff.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ServerList servers={servers} liveStatus={liveStatus} onReconnect={handleReconnect} />
            {serverCount === 0 && raw.trim() !== "" && !parseError && (
              <p className="text-xs text-amber-600 mt-2">
                No <code>mcpServers</code> key found — check your JSON structure.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Reference */}
      <div className="rounded-md border border-dashed p-4 space-y-1.5">
        <Label className="text-xs font-medium">Format reference</Label>
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
{`{
  "mcpServers": {
    "server-name": {
      "command": "npx",           // executable
      "args": ["-y", "pkg"],      // optional args
      "env": { "KEY": "value" },  // optional env vars
      "disabled": false           // true to skip on startup
    }
  }
}`}
        </pre>
      </div>
    </div>
  );
}
