import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  Send,
  Square,
  Plus,
  FolderPlus,
  RefreshCw,
  ExternalLink,
  Download,
  Terminal,
  FlaskConical,
  Loader2,
  MessageSquare,
  Eye,
  Code2,
  AlertTriangle,
  Smartphone,
  Tablet,
  Monitor,
  Server,
  X,
  Pencil,
  Check,
  Globe,
  Copy,
  Play,
} from "lucide-react";
import type { PlaygroundServerDto } from "../../shared/rpc/playground";
import { useHeaderActions } from "@/lib/header-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { Tip } from "@/components/ui/tooltip";
import { MessageParts, type MessagePartData } from "@/components/chat/message-parts";
import { CodeBlock } from "@/components/chat/code-block";
import { usePlaygroundStore } from "@/stores/playground-store";
import { rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";

// Map a broadcast part payload to the MessagePartData shape MessageParts renders.
function toPartData(p: {
  id: string;
  type: string;
  content: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  toolState?: string;
  sortOrder: number;
  agentName?: string;
  timeStart?: string;
  timeEnd?: string;
}): MessagePartData {
  return {
    id: p.id,
    messageId: "playground",
    type: p.type,
    content: p.content,
    toolName: p.toolName ?? null,
    toolInput: p.toolInput ?? null,
    toolOutput: p.toolOutput ?? null,
    toolState: p.toolState ?? null,
    sortOrder: p.sortOrder,
    timeStart: p.timeStart ?? null,
    timeEnd: p.timeEnd ?? null,
    createdAt: new Date().toISOString(),
    agentName: p.agentName,
  };
}

// Predefined message templates shown in the empty state (mirrors the main chat's
// quick-starts: a short label, with the full prompt sent on click).
const PLAYGROUND_TEMPLATES: { label: string; prompt: string }[] = [
  {
    label: "Landing page",
    prompt:
      "Build a sleek, modern landing page for a coffee subscription startup as a single self-contained index.html (all CSS and JS inline). " +
      "Sections: a sticky nav bar; a hero with headline, subheadline, and a primary call-to-action button; a 3-column features section with inline-SVG icons; " +
      "a 3-tier pricing section with the middle plan highlighted; a short testimonial; and a footer. " +
      "Use a refined color palette, strong typography, generous spacing, and subtle hover/scroll animations. " +
      "Do NOT reference external image or font files — use inline SVG, CSS gradients/shapes, or emoji. Ensure zero console errors and that it looks great on first load.",
  },
  {
    label: "Interactive to-do app",
    prompt:
      "Build an interactive to-do app as a single self-contained index.html with vanilla JS (no build step). " +
      "Features: add a task (Enter key or button), toggle complete (checkbox with strikethrough), delete a task, and filter All / Active / Completed; " +
      "show a count of remaining tasks and a 'Clear completed' button. Persist tasks to localStorage and restore them on load — wrap all localStorage access in try/catch. " +
      "Clean modern styling, a friendly empty state, and keyboard accessibility. Attach event listeners after the DOM is ready and ensure zero console errors.",
  },
  {
    label: "Animated drawing",
    prompt:
      "Create a single self-contained index.html with a smoothly animated solar-system scene: the sun at the center and several planets orbiting at different speeds and radii, each a distinct color with a subtle glow, over a dark starfield. " +
      "Use inline SVG or Canvas with requestAnimationFrame for the animation, make it responsive to the window size, and use only inline assets (no external files). Ensure zero console errors.",
  },
  {
    label: "Interactive chart",
    prompt:
      "Create a single self-contained index.html showing a responsive, interactive bar chart of quarterly revenue for 2024 (realistic sample data for Q1–Q4). " +
      "Include a title, axis labels, value labels, gridlines, and a hover tooltip showing the exact value, plus a subtle bar-grow animation on load. " +
      "Render it with inline SVG or Canvas — do NOT depend on an external charting library/CDN — so it always renders. Clean modern styling, zero console errors.",
  },
  {
    label: "Music visualizer",
    prompt:
      "Build a stunning real-time music visualizer as a single self-contained index.html using only the Web Audio API and Canvas — no external libraries. " +
      "Architecture: create an AudioContext with an AnalyserNode (fftSize 256). Drive it with a purely synthetic source: " +
      "layer 3–4 OscillatorNodes (a bass sub ~60 Hz, a mid ~220 Hz, a high ~880 Hz, and a slow LFO modulating the gain) " +
      "connected through GainNodes so the sound is musical and dynamic rather than a flat drone. Add a BiquadFilterNode for warmth. " +
      "Start the AudioContext only on the first user click (required by browsers). " +
      "Visualization: fill the full viewport canvas. Draw two layers simultaneously: " +
      "(1) a radial frequency ring — 128 bars radiating outward from the center, length proportional to frequency amplitude, " +
      "colored with a smooth hue rotation (hsl based on bar index + time) so the ring pulses with shifting rainbow colors; " +
      "(2) an oscilloscope waveform line drawn as a glowing stroke through the center of the canvas. " +
      "Add a soft particle system: spawn 2–3 small glowing circles per frame at random angles on the ring perimeter, " +
      "drift them outward and fade them out over ~60 frames. " +
      "Background: deep black with a subtle radial gradient vignette. " +
      "Show a centered 'Click to start' overlay before the first interaction, then hide it. " +
      "Add a Play/Pause toggle button (bottom center, semi-transparent). " +
      "Animate with requestAnimationFrame. Handle window resize. Ensure zero console errors on first load.",
  },
  {
    label: "Mermaid diagram",
    prompt:
      "Create a single self-contained index.html that renders a Mermaid flowchart of a typical user sign-up flow (landing → sign up → email verification → onboarding → dashboard) with a couple of decision branches (e.g. \"email verified?\"). " +
      "Load Mermaid from a CDN (https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js), put the diagram SOURCE inside a <pre class=\"mermaid\"> element, then call mermaid.initialize({ startOnLoad: true }) so Mermaid renders it IN PLACE. " +
      "Do NOT call mermaid.render() and insert the SVG yourself, and NEVER set textContent/innerText to the SVG string (that shows raw markup instead of the diagram). " +
      "Verify the mermaid global loaded before using it, center the diagram on a clean background, and ensure zero console errors.",
  },
  {
    label: "Analytics dashboard",
    prompt:
      "Design a modern analytics dashboard mockup as a single self-contained index.html. " +
      "Include a top bar, a row of 4 KPI cards (label, large number, and an up/down delta), a line chart and a bar chart (inline SVG/Canvas with sample data — no external libraries), and a recent-activity table. " +
      "Use a responsive grid layout, a dark-mode-friendly palette, subtle shadows and hover states, and placeholder data only. Inline assets only; ensure zero console errors.",
  },
  {
    label: "PDF invoice",
    prompt:
      "Generate a clean, professional one-page PDF invoice file and preview it. " +
      "Include: a company header area, an 'Invoice' title with invoice number and dates, bill-to and bill-from blocks, a line-items table (description, qty, unit price, amount), subtotal, tax, and total, plus payment terms and a thank-you note. " +
      "Use realistic sample data. Use the pdf skill if helpful, save the .pdf into the workspace, and call playground_render_preview with type 'file' pointing at it.",
  },
];

export function PlaygroundPage() {
  const navigate = useNavigate();
  const store = usePlaygroundStore();

  const [input, setInput] = useState("");
  const [confirmNew, setConfirmNew] = useState(false);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceFiles, setSourceFiles] = useState<{ path: string; content: string }[]>([]);
  const [previewDevice, setPreviewDevice] = useState<"mobile" | "tablet" | "desktop">("desktop");
  const [devServers, setDevServers] = useState<PlaygroundServerDto[]>([]);
  const [deploying, setDeploying] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ---- event wiring -------------------------------------------------------
  useEffect(() => {
    const s = usePlaygroundStore.getState();

    const onRunStarted = (e: Event) => s.onRunStarted((e as CustomEvent).detail?.message ?? "");
    const onPart = (e: Event) => {
      const d = (e as CustomEvent).detail as { part: Parameters<typeof toPartData>[0] };
      if (d?.part) s.onPart(toPartData(d.part));
    };
    const onPartUpdated = (e: Event) => {
      const d = (e as CustomEvent).detail as { partId: string; updates: Partial<MessagePartData> };
      if (d?.partId) {
        const clean: Partial<MessagePartData> = {};
        for (const [k, v] of Object.entries(d.updates ?? {})) {
          if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
        }
        s.onPartUpdated(d.partId, clean);
      }
    };
    const onAgentComplete = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        status: string;
        summary: string;
        tokensUsed: { prompt: number; completion: number; contextLimit?: number };
      };
      s.onAgentComplete(d.status, d.summary, d.tokensUsed);
    };
    const onRunComplete = () => {
      usePlaygroundStore.getState().onRunComplete();
      rpc.getPlaygroundDevServers().then((r) => setDevServers(r.servers)).catch(() => {});
    };
    const onRunError = (e: Event) => {
      const d = (e as CustomEvent).detail as { error: string };
      // Inline red error + Retry (matches the dashboard PM chat widget) — no transient toast.
      usePlaygroundStore.getState().onRunError(d?.error || "The AI provider returned an error.");
    };
    const onPreviewReady = (e: Event) => {
      const d = (e as CustomEvent).detail as Parameters<typeof s.showPreview>[0];
      s.showPreview(d);
    };
    const onRejected = (e: Event) => {
      const d = (e as CustomEvent).detail as { reason: string; guidance: string };
      s.onRejected({ reason: d.reason, guidance: d.guidance });
    };
    const onReset = () => {
      usePlaygroundStore.getState().reset();
      setDevServers([]);
    };

    // Auto-reload the preview when the agent edits files after the initial render.
    const onFilesChanged = () => {
      const st = usePlaygroundStore.getState();
      if (st.preview && st.mainView === "preview") st.bumpReload();
    };

    // Console messages forwarded from the preview iframe via postMessage.
    const onMessage = (e: MessageEvent) => {
      const data = e.data;
      if (data && typeof data === "object" && data.__agentdeskPlaygroundConsole) {
        usePlaygroundStore.getState().pushConsole({ level: data.level, message: String(data.message) });
      }
    };

    window.addEventListener("agentdesk:playground-run-started", onRunStarted);
    window.addEventListener("agentdesk:playground-part", onPart);
    window.addEventListener("agentdesk:playground-part-updated", onPartUpdated);
    window.addEventListener("agentdesk:playground-agent-complete", onAgentComplete);
    window.addEventListener("agentdesk:playground-run-complete", onRunComplete);
    window.addEventListener("agentdesk:playground-run-error", onRunError);
    window.addEventListener("agentdesk:playground-preview-ready", onPreviewReady);
    window.addEventListener("agentdesk:playground-rejected", onRejected);
    window.addEventListener("agentdesk:playground-reset", onReset);
    window.addEventListener("agentdesk:playground-files-changed", onFilesChanged);
    window.addEventListener("message", onMessage);

    // Restore state on mount (preview/running/activity survive navigation away & back).
    rpc
      .getPlaygroundState()
      .then((st) => s.hydrate({ ...st, parts: st.parts.map(toPartData) }))
      .catch(() => {});

    return () => {
      window.removeEventListener("agentdesk:playground-run-started", onRunStarted);
      window.removeEventListener("agentdesk:playground-part", onPart);
      window.removeEventListener("agentdesk:playground-part-updated", onPartUpdated);
      window.removeEventListener("agentdesk:playground-agent-complete", onAgentComplete);
      window.removeEventListener("agentdesk:playground-run-complete", onRunComplete);
      window.removeEventListener("agentdesk:playground-run-error", onRunError);
      window.removeEventListener("agentdesk:playground-preview-ready", onPreviewReady);
      window.removeEventListener("agentdesk:playground-rejected", onRejected);
      window.removeEventListener("agentdesk:playground-reset", onReset);
      window.removeEventListener("agentdesk:playground-files-changed", onFilesChanged);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  // Refresh dev server list on mount so the strip is correct after navigation.
  useEffect(() => {
    rpc.getPlaygroundDevServers().then((r) => setDevServers(r.servers)).catch(() => {});
  }, []);

  // Auto-scroll the activity log as parts stream in.
  useEffect(() => {
    if (store.mainView === "activity" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [store.parts, store.mainView]);

  // ---- actions ------------------------------------------------------------

  // Single send path — always forwards captured preview console messages so the agent can
  // fix runtime errors automatically.
  const sendMessage = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || store.running) return;
    const errs = usePlaygroundStore.getState().consoleErrors;
    const consoleLines = errs.length ? errs.map((c) => `[${c.level}] ${c.message}`) : undefined;
    const res = await rpc.playgroundSend(message, consoleLines);
    if (!res.ok) toast("error", res.error || "Could not start playground run");
  }, [store.running]);

  const handleSend = useCallback(() => {
    if (!input.trim() || store.running) return;
    const text = input;
    setInput("");
    sendMessage(text);
  }, [input, store.running, sendMessage]);

  const handleStop = useCallback(() => {
    rpc.playgroundStop().catch(() => {});
  }, []);

  // Send a predefined template prompt immediately (mirrors the main chat quick-starts).
  const runPrompt = useCallback((text: string) => { sendMessage(text); }, [sendMessage]);

  // Retry the last message after a provider error (re-sends; run-started clears the error).
  const handleRetry = useCallback(() => {
    const msg = usePlaygroundStore.getState().lastUserMessage;
    if (msg) runPrompt(msg);
  }, [runPrompt]);

  const doNewPlayground = useCallback(async () => {
    setConfirmNew(false);
    await rpc.newPlayground();
    usePlaygroundStore.getState().reset();
    setPreviewDevice("desktop");
    setDevServers([]);
    toast("success", "Started a fresh playground");
  }, []);

  const doCreateProject = useCallback(async () => {
    setConfirmCreate(false);
    setCreating(true);
    try {
      const res = await rpc.createProjectFromPlayground();
      if (res.success && res.id) {
        toast("success", `Project "${res.name}" created`);
        navigate({ to: "/project/$projectId", params: { projectId: res.id } });
      } else {
        toast("error", res.error || "Could not create project");
      }
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Could not create project");
    } finally {
      setCreating(false);
    }
  }, [navigate]);

  const handleDownloadZip = useCallback(async () => {
    const res = await rpc.exportPlaygroundZip();
    if (res.success) toast("success", `Zip saved: ${res.path}`);
    else toast("error", res.error || "Could not export zip");
  }, []);

  const handleDeploy = useCallback(async () => {
    setDeploying(true);
    const res = await rpc.deployPlayground();
    setDeploying(false);
    if (res.success && res.url) {
      usePlaygroundStore.getState().setDeployedUrl(res.url);
      toast("success", `Deployed! ${res.url}`);
    } else {
      toast("error", res.error || "Deploy failed");
    }
  }, []);

  const stopServer = useCallback(async (jobId: string) => {
    await rpc.stopPlaygroundDevServer(jobId);
    rpc.getPlaygroundDevServers().then((r) => setDevServers(r.servers)).catch(() => {});
  }, []);

  const startServer = useCallback(async (command: string) => {
    const res = await rpc.startPlaygroundDevServer(command);
    rpc.getPlaygroundDevServers().then((r) => setDevServers(r.servers)).catch(() => {});
    if (res.ok) {
      toast("success", "Server restarted");
      // The preview iframe was pointing at a dead port — reload it now that it's live.
      if (usePlaygroundStore.getState().preview?.kind === "devserver") usePlaygroundStore.getState().bumpReload();
    } else {
      toast("error", res.error || "Could not restart the server");
    }
  }, []);

  const handleFileSaved = useCallback((idx: number, newContent: string) => {
    setSourceFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, content: newContent } : f)));
  }, []);

  const handleViewSource = useCallback(async () => {
    try {
      const res = await rpc.getPlaygroundSource();
      if (!res.files.length) { toast("info", "No source files to show yet."); return; }
      setSourceFiles(res.files);
      setSourceOpen(true);
    } catch {
      toast("error", "Could not load source.");
    }
  }, []);

  // ---- header actions -----------------------------------------------------
  useHeaderActions(
    () => (
      <>
        <Tip content="Clear all files and start a fresh playground" side="bottom">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmNew(true)}
            className="border-green-600 bg-green-600 text-white hover:bg-green-700 hover:text-white dark:border-green-500 dark:bg-green-600 dark:hover:bg-green-700"
          >
            <Plus className="h-3.5 w-3.5" />
            New Playground
          </Button>
        </Tip>
        <Tip content="Save this playground as a real project in your workspace" side="bottom">
          <Button
            variant="default"
            size="sm"
            disabled={creating || store.running || !store.hasFiles}
            onClick={() => setConfirmCreate(true)}
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
            Create Project
          </Button>
        </Tip>
      </>
    ),
    [creating, store.running, store.hasFiles],
  );

  const preview = store.preview;
  const deployedUrl = store.deployedUrl;
  const hasPreview = !!preview;
  const showPreviewPane = store.mainView === "preview" && hasPreview && !store.rejection;

  // A devserver preview whose backing server is NOT currently running (e.g. after an app
  // restart killed it). The iframe may still show a stale cached page, so flag it and offer
  // a one-click restart. Matched by port when possible, else any tracked server.
  const stoppedDevserver = (() => {
    if (!preview || preview.kind !== "devserver") return null;
    const port = preview.url.match(/:(\d+)/)?.[1];
    const matches = (cmd: string) => (port ? cmd.includes(port) : true);
    const running = devServers.some((s) => s.status === "running" && matches(s.command));
    if (running) return null;
    const stopped =
      devServers.find((s) => s.status === "stopped" && matches(s.command)) ??
      devServers.find((s) => s.status === "stopped");
    return { command: stopped?.command ?? null };
  })();

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* View toggle + preview toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 shrink-0">
        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5">
          <button
            onClick={() => store.setMainView("activity")}
            className={cn(
              "flex items-center gap-1.5 rounded px-6 py-2.5 text-xs font-medium transition-colors",
              store.mainView === "activity" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </button>
          <button
            onClick={() => hasPreview && store.setMainView("preview")}
            disabled={!hasPreview}
            className={cn(
              "flex items-center gap-1.5 rounded px-6 py-2.5 text-xs font-medium transition-colors disabled:opacity-40",
              showPreviewPane ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Eye className="h-3.5 w-3.5" />
            Preview
          </button>
        </div>

        {showPreviewPane && preview && (
          <>
            <Tip content={preview.title} side="bottom">
              <span className="ml-1 truncate text-xs font-medium text-foreground">
                {preview.title}
              </span>
            </Tip>
            <span className="flex-1" />
            {/* Device width switcher */}
            <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
              <Tip content="Mobile (390px)" side="bottom">
                <button
                  onClick={() => setPreviewDevice("mobile")}
                  className={cn(
                    "rounded p-1 transition-colors",
                    previewDevice === "mobile" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Smartphone className="h-3.5 w-3.5" />
                </button>
              </Tip>
              <Tip content="Tablet (768px)" side="bottom">
                <button
                  onClick={() => setPreviewDevice("tablet")}
                  className={cn(
                    "rounded p-1 transition-colors",
                    previewDevice === "tablet" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Tablet className="h-3.5 w-3.5" />
                </button>
              </Tip>
              <Tip content="Desktop (full width)" side="bottom">
                <button
                  onClick={() => setPreviewDevice("desktop")}
                  className={cn(
                    "rounded p-1 transition-colors",
                    previewDevice === "desktop" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Monitor className="h-3.5 w-3.5" />
                </button>
              </Tip>
            </div>
            {store.consoleErrors.length > 0 && (
              <Tip content="View captured console messages" side="bottom">
                <button
                  onClick={() => setShowConsole((v) => !v)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40"
                >
                  <Terminal className="h-3.5 w-3.5" />
                  {store.consoleErrors.length}
                </button>
              </Tip>
            )}
            <Tip content="View source code" side="bottom">
              <Button variant="ghost" size="sm" onClick={handleViewSource}>
                <Code2 className="h-3.5 w-3.5" />
              </Button>
            </Tip>
            <Tip content="Reload preview" side="bottom">
              <Button variant="ghost" size="sm" onClick={() => store.bumpReload()}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </Tip>
            <Tip content="Open in browser" side="bottom">
              <Button variant="ghost" size="sm" onClick={() => rpc.openExternalUrl(preview.url)}>
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </Tip>
            <Tip content="Download as zip" side="bottom">
              <Button variant="ghost" size="sm" onClick={handleDownloadZip}>
                <Download className="h-3.5 w-3.5" />
              </Button>
            </Tip>
            {preview.kind === "static" && (
              deployedUrl ? (
                <div className="flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-0.5">
                  <Globe className="h-3 w-3 shrink-0 text-green-600 dark:text-green-400" />
                  <button
                    onClick={() => rpc.openExternalUrl(deployedUrl)}
                    className="max-w-[150px] truncate text-xs text-foreground hover:underline"
                  >
                    {deployedUrl.replace("https://", "")}
                  </button>
                  <Tip content="Copy URL" side="bottom">
                    <button
                      onClick={() => { navigator.clipboard.writeText(deployedUrl); toast("success", "URL copied"); }}
                      className="ml-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </Tip>
                </div>
              ) : (
                <Tip content="Deploy to web via surge.sh" side="bottom">
                  <Button variant="ghost" size="sm" onClick={handleDeploy} disabled={deploying}>
                    {deploying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
                  </Button>
                </Tip>
              )
            )}
          </>
        )}

        {/* Token usage — only on the Chat view, pinned far right, bold, in thousands (k). */}
        {!showPreviewPane && store.tokens && (
          <>
            <span className="flex-1" />
            <Tip content="Tokens used this run" side="bottom">
              <span className="text-sm font-bold text-muted-foreground">
                {((store.tokens.prompt + store.tokens.completion) / 1000).toFixed(1)}k tokens
              </span>
            </Tip>
          </>
        )}
      </div>

      {/* Snapshot history strip */}
      {store.history.length > 1 && showPreviewPane && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border bg-muted/30 px-4 py-1.5 shrink-0">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">History</span>
          {store.history.map((h, i) => (
            <Tip key={h.url + i} content={h.title} side="bottom">
              <button
                onClick={() => store.showPreview(h)}
                className={cn(
                  "shrink-0 rounded border px-2 py-0.5 text-[11px] transition-colors",
                  store.preview?.url === h.url
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {h.title.length > 22 ? h.title.slice(0, 22) + "…" : h.title}
              </button>
            </Tip>
          ))}
        </div>
      )}

      {/* Dev servers strip */}
      {devServers.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto border-b border-border bg-muted/20 px-4 py-1.5 shrink-0">
          <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">Servers</span>
          {devServers.map((s) => (
            <div key={s.command} className="flex items-center gap-1.5 rounded border border-border bg-background px-2 py-0.5 text-xs shrink-0">
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  s.status === "running" ? "bg-green-500" : "bg-muted-foreground/40",
                )}
              />
              <span className="max-w-[200px] truncate font-medium text-foreground">{s.label}</span>
              <span className="text-muted-foreground">
                {s.status === "running" ? s.elapsedHuman : "stopped"}
              </span>
              {s.status === "running" ? (
                <Tip content="Stop this server" side="bottom">
                  <button
                    onClick={() => stopServer(s.id)}
                    className="ml-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Tip>
              ) : (
                <Tip content="Start this server" side="bottom">
                  <button
                    onClick={() => startServer(s.command)}
                    className="ml-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-green-500/10 hover:text-green-600 dark:hover:text-green-400"
                  >
                    <Play className="h-3 w-3" />
                  </button>
                </Tip>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Main area */}
      <div className="relative min-h-0 flex-1">
        {/* Preview pane */}
        {showPreviewPane && preview && (
          <div className="relative flex h-full flex-col">
            {stoppedDevserver && (
              <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-300 bg-amber-50/95 px-3 py-1.5 text-xs text-amber-900 shadow-md dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-200">
                <span>Dev server stopped — showing the last cached view, not live.</span>
                {stoppedDevserver.command && (
                  <button
                    onClick={() => startServer(stoppedDevserver.command as string)}
                    className="inline-flex items-center gap-1 rounded-full bg-amber-600 px-2 py-0.5 font-medium text-white transition-colors hover:bg-amber-700"
                  >
                    <Play className="h-3 w-3" />
                    Start
                  </button>
                )}
              </div>
            )}
            <div
              className={cn(
                "min-h-0 flex-1 flex",
                previewDevice !== "desktop" && "justify-center overflow-x-hidden bg-muted/20",
              )}
            >
              <iframe
                key={store.reloadNonce}
                src={preview.url + (preview.url.includes("?") ? "&" : "?") + "_r=" + store.reloadNonce}
                title="Playground preview"
                className={cn(
                  "h-full border-0 bg-white",
                  previewDevice === "desktop" && "w-full",
                  previewDevice === "tablet" && "w-[768px] shrink-0 border-x border-border shadow-sm",
                  previewDevice === "mobile" && "w-[390px] shrink-0 border-x border-border shadow-md",
                )}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"
              />
            </div>
            {showConsole && store.consoleErrors.length > 0 && (
              <div className="max-h-40 shrink-0 overflow-y-auto border-t border-border bg-zinc-950 p-2 font-mono text-[11px] text-zinc-200">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-zinc-400">Console ({store.consoleErrors.length})</span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => runPrompt("Fix the console errors/warnings the live preview is reporting.")}
                      disabled={store.running}
                      className="font-medium text-amber-300 hover:text-amber-200 disabled:opacity-50"
                    >
                      Fix with agent
                    </button>
                    <button onClick={() => store.clearConsole()} className="text-zinc-400 hover:text-zinc-200">
                      clear
                    </button>
                  </div>
                </div>
                {store.consoleErrors.map((c, i) => (
                  <div key={i} className={cn("whitespace-pre-wrap break-words", c.level === "error" ? "text-red-400" : "text-amber-300")}>
                    {c.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Activity / rejection / empty */}
        {!showPreviewPane && (
          <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-4">
            {store.rejection ? (
              <RejectionCard reason={store.rejection.reason} guidance={store.rejection.guidance} />
            ) : store.parts.length > 0 || store.error ? (
              <div className="mx-auto max-w-5xl">
                {store.parts.length > 0 && (
                  <MessageParts parts={store.parts} hasRunningAgents={store.running} onStopAgent={handleStop} />
                )}
                {store.running && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Playground Agent is working…
                  </div>
                )}
                {store.error && !store.running && (
                  <ErrorBlock message={store.error} onRetry={handleRetry} canRetry={!!store.lastUserMessage} />
                )}
              </div>
            ) : store.transcript.length > 0 ? (
              // No live run this session (e.g. after an app restart) — show the saved conversation.
              <div className="mx-auto max-w-5xl">
                <Transcript turns={store.transcript} />
                {store.running && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Playground Agent is working…
                  </div>
                )}
              </div>
            ) : (
              <EmptyState running={store.running} onSend={runPrompt} />
            )}
          </div>
        )}
      </div>

      {/* Chat input — only on the Chat tab, hidden while the Preview pane is showing */}
      {!showPreviewPane && (
        <div className="border-t border-border bg-background p-3 shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={1}
              placeholder={store.running ? "Playground Agent is working…" : "Describe what you want to build…"}
              disabled={store.running}
              className="max-h-40 min-h-[44px] flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring disabled:opacity-60"
            />
            {store.running ? (
              <Button variant="destructive" size="lg" onClick={handleStop} className="h-11">
                <Square className="h-4 w-4 fill-current" />
                Stop
              </Button>
            ) : (
              <Button size="lg" onClick={handleSend} disabled={!input.trim()} className="h-11">
                <Send className="h-4 w-4" />
                Send
              </Button>
            )}
          </div>
        </div>
      )}

      {/* New Playground confirm */}
      <Dialog open={confirmNew} onOpenChange={setConfirmNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a new playground?</DialogTitle>
            <DialogDescription className="text-foreground/80">
              This deletes all files from the current playground and stops any running preview servers. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmNew(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={doNewPlayground}>
              Delete &amp; start fresh
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Project confirm */}
      <Dialog open={confirmCreate} onOpenChange={setConfirmCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a project from this playground?</DialogTitle>
            <DialogDescription className="text-foreground/80">
              A new project will be created in your workspace with an AI-generated name, and all playground files
              (excluding node_modules and build output) will be copied into it. Requires a workspace path set in
              Settings → General.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCreate(false)}>
              Cancel
            </Button>
            <Button onClick={doCreateProject}>Create project</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View source — keyed by file set so state resets cleanly on each open */}
      <SourceDialog
        key={sourceFiles.map((f) => f.path).join("|") || "empty"}
        open={sourceOpen}
        onOpenChange={setSourceOpen}
        files={sourceFiles}
        onFileSaved={handleFileSaved}
      />
    </div>
  );
}

function ErrorBlock({ message, onRetry, canRetry }: { message: string; onRetry: () => void; canRetry: boolean }) {
  return (
    <div className="mt-3 w-full overflow-hidden rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm leading-relaxed text-destructive">
      <div className="break-words">Error: {message}</div>
      {canRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  );
}

// Compact markdown renderer for the saved-conversation transcript.
const TRANSCRIPT_MD = {
  p: ({ children }: { children?: ReactNode }) => <p className="mb-1.5 leading-relaxed last:mb-0">{children}</p>,
  ul: ({ children }: { children?: ReactNode }) => <ul className="mb-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="mb-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }: { children?: ReactNode }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => <strong className="font-semibold">{children}</strong>,
  h1: ({ children }: { children?: ReactNode }) => <h1 className="mb-1 mt-2 text-base font-semibold">{children}</h1>,
  h2: ({ children }: { children?: ReactNode }) => <h2 className="mb-1 mt-2 text-sm font-semibold">{children}</h2>,
  h3: ({ children }: { children?: ReactNode }) => <h3 className="mb-1 mt-1.5 text-sm font-semibold">{children}</h3>,
  code: ({ children }: { children?: ReactNode }) => <code className="rounded bg-background/60 px-1 py-0.5 text-xs">{children}</code>,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      className="text-blue-600 underline dark:text-blue-400"
      onClick={(e) => { e.preventDefault(); if (href) rpc.openExternalUrl(href).catch(() => {}); }}
    >
      {children}
    </a>
  ),
};

function Transcript({ turns }: { turns: { role: "user" | "assistant"; content: string }[] }) {
  return (
    <div className="space-y-3">
      <p className="mb-1 text-center text-[11px] uppercase tracking-wide text-muted-foreground">Previous conversation</p>
      {turns.map((t, i) =>
        t.role === "user" ? (
          <div key={i} className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-2 text-sm text-white">
              {t.content}
            </div>
          </div>
        ) : (
          <div key={i} className="flex justify-start">
            <div className="max-w-[90%] break-words rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-foreground">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={TRANSCRIPT_MD as never}>
                {t.content}
              </ReactMarkdown>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

// Derive a Shiki language id from a filename (covers the formats the playground produces).
function getSourceLang(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less",
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
    json: "json", jsonc: "json", md: "markdown", markdown: "markdown", txt: "plaintext",
    svg: "xml", xml: "xml", yaml: "yaml", yml: "yaml", toml: "toml", csv: "plaintext",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", php: "php", sh: "bash",
    graphql: "graphql", gql: "graphql", vue: "vue", svelte: "svelte",
  };
  return map[ext] ?? "plaintext";
}

function SourceDialog({
  open,
  onOpenChange,
  files,
  onFileSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  files: { path: string; content: string }[];
  onFileSaved?: (idx: number, content: string) => void;
}) {
  // File selection
  const [currentIdx, setCurrentIdx] = useState(() => {
    const i = files.findIndex((f) => /(^|\/)index\.html$/i.test(f.path));
    return i >= 0 ? i : 0;
  });
  // Edit state — tracked as "which idx is being edited" so switching files auto-exits edit mode
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);

  const isEditing = editingIdx === currentIdx;
  const currentFile = files[currentIdx] ?? null;

  const startEdit = () => {
    setEditContent(currentFile?.content ?? "");
    setSaveOk(false);
    setEditingIdx(currentIdx);
  };

  const cancelEdit = () => {
    setEditingIdx(null);
    setSaveOk(false);
  };

  const handleSave = async () => {
    if (!currentFile) return;
    setSaving(true);
    const res = await rpc.savePlaygroundFile(currentFile.path, editContent);
    setSaving(false);
    if (res.success) {
      onFileSaved?.(currentIdx, editContent);
      setSaveOk(true);
      setEditingIdx(null);
      setTimeout(() => setSaveOk(false), 2500);
    } else {
      toast("error", res.error || "Could not save file");
    }
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) { setEditingIdx(null); setSaveOk(false); }
    onOpenChange(v);
  };

  const btnClass = "rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-30";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="!flex h-[82vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader className="flex-row items-center space-y-0">
          <DialogTitle>Source code</DialogTitle>
          {/* Edit controls — inline after the title with a clear gap */}
          <div className="ml-4 flex items-center gap-1.5">
            {saveOk && (
              <span className="text-xs text-green-600 dark:text-green-400">Saved</span>
            )}
            {isEditing ? (
              <>
                <Tip content="Cancel editing" side="bottom">
                  <button onClick={cancelEdit} disabled={saving} className={btnClass}>
                    <X className="h-4 w-4" />
                    <span className="sr-only">Cancel edit</span>
                  </button>
                </Tip>
                <Tip content="Save file — preview reloads instantly" side="bottom">
                  <button onClick={handleSave} disabled={saving} className={btnClass}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    <span className="sr-only">Save</span>
                  </button>
                </Tip>
              </>
            ) : (
              <Tip content="Edit this file — save triggers instant preview reload" side="bottom">
                <button onClick={startEdit} disabled={!currentFile} className={btnClass}>
                  <Pencil className="h-4 w-4" />
                  <span className="sr-only">Edit file</span>
                </button>
              </Tip>
            )}
          </div>
        </DialogHeader>

        <SourceViewer
          files={files}
          currentIdx={currentIdx}
          onIdxChange={setCurrentIdx}
          isEditing={isEditing}
          editContent={editContent}
          onEditContentChange={setEditContent}
        />
      </DialogContent>
    </Dialog>
  );
}

function SourceViewer({
  files,
  currentIdx,
  onIdxChange,
  isEditing,
  editContent,
  onEditContentChange,
}: {
  files: { path: string; content: string }[];
  currentIdx: number;
  onIdxChange: (idx: number) => void;
  isEditing: boolean;
  editContent: string;
  onEditContentChange: (content: string) => void;
}) {
  const theme: "dark" | "light" =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
  const file = files[currentIdx] ?? null;

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      {files.length > 1 && (
        <div className="w-48 shrink-0 space-y-0.5 overflow-y-auto border-r border-border pr-2">
          {files.map((f, i) => (
            <button
              key={f.path}
              onClick={() => onIdxChange(i)}
              title={f.path}
              className={cn(
                "block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors",
                i === currentIdx ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {f.path}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {file ? (
          isEditing ? (
            <textarea
              value={editContent}
              onChange={(e) => onEditContentChange(e.target.value)}
              spellCheck={false}
              className="h-full w-full resize-none rounded border border-input bg-muted/30 p-3 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <CodeBlock
              key={file.path}
              language={getSourceLang(file.path)}
              code={file.content}
              theme={theme}
              lineCount={file.content.split("\n").length}
            />
          )
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No source files.</p>
        )}
      </div>
    </div>
  );
}

function RejectionCard({ reason, guidance }: { reason: string; guidance: string }) {
  return (
    <div className="mx-auto mt-8 max-w-xl rounded-xl border border-amber-300 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-950/30">
      <div className="mb-3 flex items-center gap-2 text-amber-700 dark:text-amber-300">
        <AlertTriangle className="h-5 w-5" />
        <h3 className="text-base font-semibold">Can&apos;t render this in the Playground</h3>
      </div>
      <p className="mb-4 text-sm leading-relaxed text-amber-900 dark:text-amber-200">{reason}</p>
      <div className="rounded-lg border border-amber-200 bg-white/60 p-3 dark:border-amber-900 dark:bg-amber-950/40">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">What you can do</p>
        <p className="mt-1 text-sm leading-relaxed text-amber-900 dark:text-amber-200">{guidance}</p>
      </div>
    </div>
  );
}

function EmptyState({ running, onSend }: { running: boolean; onSend: (prompt: string) => void }) {
  if (running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <p className="text-sm">Playground Agent is starting…</p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-100 text-violet-600 dark:bg-violet-950/50 dark:text-violet-400">
        <FlaskConical className="h-7 w-7" />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-foreground">Playground</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a template to start, or type your own message below — a web page, an interactive demo, a drawing, a
          chart, or a document — and watch it render live.
        </p>
      </div>
      <div className="grid w-full grid-cols-2 gap-2">
        {PLAYGROUND_TEMPLATES.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => onSend(t.prompt)}
            className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
