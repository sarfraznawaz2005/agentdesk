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
  Link2,
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
import { QuickAttachBar } from "@/components/dashboard/quick-attach-bar";
import { AttachFileTextButton } from "@/components/chat/attach-file-text-button";
import { useVoiceInput } from "@/lib/use-voice-input";
import { VoiceInputButton } from "@/components/chat/voice-input-button";
import { usePlaygroundStore } from "@/stores/playground-store";
import { rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { IS_REMOTE } from "@/lib/remote-transport";

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

// Random pick helper for templates whose prompt should vary on each click.
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

// Ingredients for a randomized landing-page prompt — so clicking "Landing page"
// produces a fresh industry, color palette, and aesthetic every time instead of
// always defaulting to the same coffee-shop look.
const LANDING_INDUSTRIES = [
  "a personal finance & budgeting app",
  "an electric bike brand",
  "a meal-kit delivery service",
  "a meditation & sleep app",
  "a project management SaaS for remote teams",
  "an online language-learning platform",
  "a sustainable fashion label",
  "a home-fitness equipment brand",
  "a developer API & observability tool",
  "an indoor plants & gardening shop",
  "a travel-planning app",
  "a pet care & vet-booking service",
  "an online music-production course",
  "a smart-home security system",
  "a freelance design marketplace",
  "an AI writing assistant",
  "a boutique hotel chain",
  "a kids' STEM toys brand",
  "an EV charging network",
  "a cold-brew tea subscription",
] as const;

const LANDING_PALETTES = [
  "deep indigo and violet with an electric cyan accent",
  "warm terracotta, cream, and charcoal",
  "forest green and sand with a gold accent",
  "midnight navy with a vibrant coral accent",
  "soft pastel lavender and mint over white",
  "monochrome slate with a single neon-lime accent",
  "a sunset orange-to-pink gradient with deep plum",
  "crisp white and black with a bold electric-blue accent",
  "muted earthy olive and rust",
  "dark mode: near-black with teal and magenta neon accents",
  "warm peach and burgundy",
  "ocean teal and aqua with a sandy neutral",
] as const;

const LANDING_STYLES = [
  "minimalist with generous whitespace and large editorial typography",
  "modern glassmorphism with soft blurred cards",
  "bold and vibrant with large gradient shapes",
  "clean corporate with crisp cards and subtle shadows",
  "playful and rounded with friendly micro-interactions",
  "sleek dark-mode with glowing accents",
] as const;

function buildLandingPagePrompt(): string {
  const industry = pick(LANDING_INDUSTRIES);
  const palette = pick(LANDING_PALETTES);
  const style = pick(LANDING_STYLES);
  return (
    `Build a sleek, modern, professional landing page for ${industry} as a single self-contained index.html (all CSS and JS inline). ` +
    "Sections: a sticky nav bar; a hero with headline, subheadline, and a primary call-to-action button; a 3-column features section with inline-SVG icons; " +
    "a 3-tier pricing section with the middle plan highlighted; a short testimonial; and a footer. " +
    `Visual direction — aesthetic: ${style}; color palette: ${palette}. Commit fully to this palette across backgrounds, accents, and buttons (do not fall back to a generic blue). ` +
    "Write realistic copy specific to this product. Use strong typography, generous spacing, and subtle hover/scroll animations. " +
    "Do NOT reference external image or font files — use inline SVG, CSS gradients/shapes, or emoji. Ensure zero console errors and that it looks great on first load."
  );
}

// Ingredients for a randomized interactive-chart prompt.
const CHART_DATASETS = [
  "quarterly revenue (Q1–Q4) for a sample year",
  "monthly active users over the last 6 months",
  "website traffic by acquisition channel (Organic, Direct, Social, Referral, Email)",
  "app downloads by platform (iOS, Android, Web, Desktop)",
  "weekly sales for the last 8 weeks",
  "customer satisfaction (CSAT) by quarter",
  "support tickets by category",
  "marketing spend vs. conversions by month",
] as const;

const CHART_TYPES = ["bar chart", "line chart", "area chart", "horizontal bar chart"] as const;

const CHART_PALETTES = [
  "a single bold accent color on a clean light background",
  "a cool blue-to-teal palette",
  "a warm orange-and-amber palette",
  "a purple-and-pink palette",
  "a green-and-lime palette on a dark background",
  "a multi-hue categorical palette",
] as const;

function buildChartPrompt(): string {
  const dataset = pick(CHART_DATASETS);
  const type = pick(CHART_TYPES);
  const palette = pick(CHART_PALETTES);
  return (
    `Create a single self-contained index.html showing a responsive, interactive ${type} of ${dataset} (realistic sample data). ` +
    "Include a title, axis labels, value labels, gridlines, and a hover tooltip showing the exact value, plus a subtle grow/draw animation on load. " +
    `Use ${palette}. ` +
    "Render it with inline SVG or Canvas — do NOT depend on an external charting library/CDN — so it always renders. Clean modern styling, zero console errors."
  );
}

// Ingredients for a randomized analytics-dashboard prompt.
const DASHBOARD_DOMAINS = [
  "a SaaS product (signups, MRR, churn, active users)",
  "an e-commerce store (revenue, orders, conversion rate, average order value)",
  "a marketing team (traffic, leads, click-through rate, campaign ROI)",
  "a fitness app (workouts logged, active members, calories, retention)",
  "a fintech wallet (transactions, volume, new accounts, fraud alerts)",
  "a content platform (views, watch time, subscribers, engagement)",
  "a support team (tickets, response time, CSAT, backlog)",
  "a logistics operation (shipments, on-time rate, fleet usage, delays)",
] as const;

const DASHBOARD_THEMES = [
  "a dark-mode palette with a vivid accent",
  "a clean light palette with soft shadows",
  "a muted neutral palette with one bold accent color",
  "a colorful palette with gradient KPI cards",
] as const;

function buildDashboardPrompt(): string {
  const domain = pick(DASHBOARD_DOMAINS);
  const theme = pick(DASHBOARD_THEMES);
  return (
    `Design a modern analytics dashboard mockup for ${domain} as a single self-contained index.html. ` +
    "Include a top bar, a row of 4 KPI cards (label, large number, and an up/down delta), a line chart and a bar chart (inline SVG/Canvas with sample data — no external libraries), and a recent-activity table. " +
    `Use a responsive grid layout, ${theme}, subtle shadows and hover states, and placeholder data only. Inline assets only; ensure zero console errors.`
  );
}

// Ingredients for a randomized PDF-invoice prompt.
const INVOICE_BUSINESSES = [
  { company: "a web design studio", currency: "USD ($)" },
  { company: "a freelance photographer", currency: "EUR (€)" },
  { company: "a landscaping company", currency: "GBP (£)" },
  { company: "a software consultancy", currency: "USD ($)" },
  { company: "a catering service", currency: "CAD ($)" },
  { company: "a marketing agency", currency: "AUD ($)" },
  { company: "an interior design firm", currency: "EUR (€)" },
  { company: "a printing & signage shop", currency: "USD ($)" },
] as const;

const INVOICE_ACCENTS = [
  "a navy-and-slate accent",
  "a deep-green accent",
  "a burgundy accent",
  "a charcoal-and-gold accent",
  "a teal accent",
] as const;

function buildInvoicePrompt(): string {
  const biz = pick(INVOICE_BUSINESSES);
  const accent = pick(INVOICE_ACCENTS);
  return (
    `Generate a clean, professional one-page PDF invoice for ${biz.company} and preview it. ` +
    `Use ${biz.currency} for all amounts and ${accent} for headers and rules. ` +
    "Include: a company header area, an 'Invoice' title with invoice number and dates, bill-to and bill-from blocks, a line-items table (description, qty, unit price, amount), subtotal, tax, and total, plus payment terms and a thank-you note. " +
    "Use realistic sample data appropriate to the business. Use the pdf skill if helpful, save the .pdf into the workspace, and call playground_render_preview with type 'file' pointing at it."
  );
}

// Ingredients for a randomized mini paint-app prompt (pure Canvas).
const PAINT_THEMES = [
  "a clean light theme with an indigo accent",
  "a dark theme with a cyan accent",
  "a warm cream theme with a terracotta accent",
  "a minimal monochrome theme with a single lime accent",
] as const;

function buildPaintPrompt(): string {
  const theme = pick(PAINT_THEMES);
  return (
    "Build a polished mini paint / drawing app as a single self-contained index.html with Canvas and vanilla JS (no build step, no external files). " +
    "Features: smooth freehand brush drawing; an adjustable brush-size slider; a color picker plus a row of preset color swatches; an eraser; an undo button backed by a history stack; a clear-canvas button; and a 'Download PNG' button that exports the drawing. " +
    `Style it with ${theme}, a tidy toolbar, and a large drawing surface that fills the remaining space. ` +
    "Support both mouse and touch/pointer input, preserve the drawing on window resize (don't wipe the canvas), and ensure zero console errors."
  );
}

// Ingredients for a randomized interactive map prompt (Leaflet via CDN).
const MAP_LOCATIONS = [
  { place: "Tokyo, Japan", coords: "[35.6762, 139.6503]", zoom: 12, theme: "famous landmarks (e.g., Tokyo Tower, Senso-ji Temple, Shibuya Crossing)" },
  { place: "Paris, France", coords: "[48.8566, 2.3522]", zoom: 13, theme: "iconic sights (e.g., the Eiffel Tower, the Louvre, Notre-Dame)" },
  { place: "New York City, USA", coords: "[40.7128, -74.006]", zoom: 12, theme: "landmarks (e.g., Central Park, Times Square, the Statue of Liberty)" },
  { place: "London, UK", coords: "[51.5074, -0.1278]", zoom: 12, theme: "landmarks (e.g., Big Ben, Tower Bridge, the London Eye)" },
  { place: "San Francisco, USA", coords: "[37.7749, -122.4194]", zoom: 12, theme: "sights (e.g., the Golden Gate Bridge, Alcatraz, Fisherman's Wharf)" },
  { place: "Rome, Italy", coords: "[41.9028, 12.4964]", zoom: 13, theme: "ancient sights (e.g., the Colosseum, the Pantheon, the Trevi Fountain)" },
  { place: "Sydney, Australia", coords: "[-33.8688, 151.2093]", zoom: 12, theme: "sights (e.g., the Opera House, the Harbour Bridge, Bondi Beach)" },
] as const;

function buildMapPrompt(): string {
  const loc = pick(MAP_LOCATIONS);
  return (
    "Build an interactive map as a single self-contained index.html using Leaflet loaded from a pinned CDN " +
    "(CSS https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css and JS https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js) with OpenStreetMap tiles. " +
    `Center the map on ${loc.place} at ${loc.coords} (zoom ~${loc.zoom}) and add 5–6 markers for ${loc.theme}, ` +
    "each opening a styled popup with a title and a short description on click. Add a small title/legend overlay, make the map fill the viewport, " +
    "verify the L (Leaflet) global loaded before using it, handle resize, and ensure zero console errors."
  );
}

// Predefined message templates shown in the empty state (mirrors the main chat's
// quick-starts: a short label, with the full prompt sent on click). `prompt` may
// be a function so a template can produce a fresh, randomized prompt per click.
const PLAYGROUND_TEMPLATES: { label: string; prompt: string | (() => string) }[] = [
  {
    label: "Landing page",
    prompt: buildLandingPagePrompt,
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
    label: "Paint app",
    prompt: buildPaintPrompt,
  },
  {
    label: "Interactive chart",
    prompt: buildChartPrompt,
  },
  {
    label: "Interactive map",
    prompt: buildMapPrompt,
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
    prompt: buildDashboardPrompt,
  },
  {
    label: "PDF invoice",
    prompt: buildInvoicePrompt,
  },
];

export function PlaygroundPage() {
  const navigate = useNavigate();
  const store = usePlaygroundStore();

  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Declared early — handleSend's useCallback dependency array references `voice`,
  // and deps arrays evaluate immediately every render (unlike a callback body), so
  // `voice` must already be initialized by the time that array is evaluated.
  const voice = useVoiceInput(input, setInput, () => requestAnimationFrame(() => textareaRef.current?.focus()));
  const [confirmNew, setConfirmNew] = useState(false);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceFiles, setSourceFiles] = useState<{ path: string; content: string }[]>([]);
  const [previewDevice, setPreviewDevice] = useState<"mobile" | "tablet" | "desktop">("desktop");
  const [devServers, setDevServers] = useState<PlaygroundServerDto[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
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
    const onPartsRemoved = (e: Event) => {
      const d = (e as CustomEvent).detail as { partIds: string[] };
      if (d?.partIds?.length) s.onPartsRemoved(d.partIds);
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
      const st = usePlaygroundStore.getState();
      st.onRunComplete();
      rpc.getPlaygroundDevServers().then((r) => setDevServers(r.servers)).catch(() => {});
      // No completion toast — the spinner on the Chat tab signals working/done. Failures
      // still surface inline in the chat (error block / rejection card), and a hard
      // provider error additionally toasts via onRunError.
    };
    const onRunError = (e: Event) => {
      const d = (e as CustomEvent).detail as { error: string };
      const msg = d?.error || "The AI provider returned an error.";
      // Inline red error + Retry stays in the Chat tab (matches the dashboard PM chat widget).
      // Also toast it so the failure is visible when the user is waiting on the Preview tab.
      usePlaygroundStore.getState().onRunError(msg);
      toast("error", msg);
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
    window.addEventListener("agentdesk:playground-parts-removed", onPartsRemoved);
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
      window.removeEventListener("agentdesk:playground-parts-removed", onPartsRemoved);
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
    voice.stop();
    const text = input;
    setInput("");
    sendMessage(text);
  }, [input, store.running, sendMessage, voice]);

  const handleStop = useCallback(() => {
    rpc.playgroundStop().catch(() => {});
  }, []);

  const insertText = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev}\n\n${text}` : text));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // Apply a user-edited preview URL: reload the iframe immediately (store) and
  // persist the change to preview.json so it survives a restart.
  const applyPreviewUrl = useCallback(() => {
    const url = urlDraft.trim();
    if (!url) return;
    usePlaygroundStore.getState().setPreviewUrl(url);
    setEditingUrl(false);
    rpc.setPlaygroundPreviewUrl(url).then((res) => {
      if (!res.success) toast("error", res.error || "Could not save the preview URL");
    }).catch(() => {});
  }, [urlDraft]);

  // Exit URL-edit mode whenever the active preview changes (e.g. a new render or
  // switching history snapshots) so a stale draft never lingers.
  useEffect(() => { setEditingUrl(false); }, [store.preview?.url]);

  // Send a predefined template prompt immediately (mirrors the main chat quick-starts).
  const runPrompt = useCallback((text: string) => { sendMessage(text); }, [sendMessage]);

  // Retry the last message after a provider error (re-sends; run-started clears the error).
  const handleRetry = useCallback(() => {
    const msg = usePlaygroundStore.getState().lastUserMessage;
    if (msg) runPrompt(msg);
  }, [runPrompt]);

  // Wipe the playground + reset the page. `force` first kills any dev servers
  // still holding file locks (the wipe legitimately fails otherwise on Windows).
  // Failure is surfaced as a toast — never an unlogged unhandled rejection — and
  // the UI is only reset when the wipe actually succeeded.
  const resetPlayground = useCallback(async (force: boolean) => {
    const res = await rpc.newPlayground(force).catch((err) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "Could not clear the playground.",
    }));
    if (!res.ok) {
      // First (non-forced) failure offers one-click escalation: stop the locking
      // dev servers and retry. A forced attempt that still fails just reports —
      // no infinite retry loop.
      toast(
        "error",
        res.error || "Could not clear the playground.",
        force
          ? undefined
          : { label: "Stop servers & retry", onClick: () => void resetPlayground(true) },
      );
      return;
    }
    usePlaygroundStore.getState().reset();
    setPreviewDevice("desktop");
    setDevServers([]);
    toast("success", "Started a fresh playground");
  }, []);

  const doNewPlayground = useCallback(() => {
    setConfirmNew(false);
    void resetPlayground(false);
  }, [resetPlayground]);

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
        {/* The "working" state is shown by the spinner on the Chat tab — no header badge. */}
        <Tip content="Clear all files and start a fresh playground" side="bottom">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmNew(true)}
            className="border-green-600 bg-green-600 text-white hover:bg-green-700 hover:text-white dark:border-green-500 dark:bg-green-600 dark:hover:bg-green-700 max-md:px-2"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span className="max-md:hidden">New Playground</span>
          </Button>
        </Tip>
        <Tip content="Save this playground as a real project in your workspace" side="bottom">
          <Button
            variant="default"
            size="sm"
            disabled={creating || store.running || !store.hasFiles}
            onClick={() => setConfirmCreate(true)}
            className="max-md:px-2"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> : <FolderPlus className="h-3.5 w-3.5 shrink-0" />}
            <span className="max-md:hidden">Create Project</span>
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

  // Running dev servers are what hold the file locks that can make a wipe fail —
  // surface the count in the New Playground confirm so the user can stop them
  // proactively instead of discovering the lock only after the wipe errors.
  const runningDevServerCount = devServers.filter((s) => s.status === "running").length;

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
            {store.running && <Loader2 className="h-3 w-3 animate-spin" />}
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
            {editingUrl ? (
              <form
                className="ml-1 flex items-center gap-1"
                onSubmit={(e) => { e.preventDefault(); applyPreviewUrl(); }}
              >
                <input
                  autoFocus
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") setEditingUrl(false); }}
                  placeholder="http://localhost:3000"
                  spellCheck={false}
                  className="w-80 rounded border border-input bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
                <Tip content="Apply URL & reload" side="bottom">
                  <Button type="submit" variant="ghost" size="sm" disabled={!urlDraft.trim()}>
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                </Tip>
                <Tip content="Cancel" side="bottom">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingUrl(false)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </Tip>
              </form>
            ) : (
              <>
                <Tip content={preview.title} side="bottom">
                  <span className="ml-1 max-w-[280px] truncate text-xs font-medium text-foreground">
                    {preview.title}
                  </span>
                </Tip>
                <Tip content={`Edit preview URL — ${preview.url}`} side="bottom">
                  <Button variant="ghost" size="sm" onClick={() => { setUrlDraft(preview.url); setEditingUrl(true); }}>
                    <Link2 className="h-3.5 w-3.5" />
                  </Button>
                </Tip>
              </>
            )}
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
            {/* preview.url is the desktop's own localhost dev server — opening it
                in a remote user's own browser would resolve to their machine,
                not the desktop's, so hide this action in web mode. */}
            {!IS_REMOTE && (
              <Tip content="Open in browser" side="bottom">
                <Button variant="ghost" size="sm" onClick={() => rpc.openExternalUrl(preview.url)}>
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </Tip>
            )}
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

      </div>

      {/* Snapshot history strip */}
      {store.history.length > 1 && showPreviewPane && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border bg-muted/30 px-4 py-1.5 shrink-0">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/70">History</span>
          {store.history.map((h, i) => (
            <Tip key={h.url + i} content={h.title} side="bottom">
              <button
                onClick={() => store.selectPreview(h)}
                className={cn(
                  "shrink-0 rounded border px-2 py-0.5 text-[11px] transition-colors",
                  store.preview?.url === h.url
                    ? "border-primary bg-primary/10 font-medium text-foreground"
                    : "border-border text-foreground/80 hover:border-foreground/30 hover:text-foreground",
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
              {IS_REMOTE ? (
                // preview.url is a localhost dev server running on the DESKTOP —
                // unreachable from a remote browser tab, which has its own
                // localhost. View source / download zip still work (RPC-based).
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                  <p className="text-sm font-medium">Live preview isn't available over Remote Access</p>
                  <p className="text-xs">Open this project on the desktop to see the live preview, or use View source / Download as zip here.</p>
                </div>
              ) : (
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
              )}
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
            <div className="flex flex-1 items-center gap-0.5 rounded-lg border border-input bg-background pl-1 pr-2 py-1 focus-within:ring-1 focus-within:ring-ring">
              <AttachFileTextButton onInsertText={insertText} disabled={store.running} />
              <QuickAttachBar onInsertText={insertText} disabled={store.running} />
              <textarea
                ref={textareaRef}
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
                className="max-h-40 min-h-[38px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
              />
              {voice.supported && (
                <VoiceInputButton listening={voice.listening} error={voice.error} onClick={voice.toggle} disabled={store.running} />
              )}
            </div>
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
          {runningDevServerCount > 0 && (
            <div className="rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              {runningDevServerCount} dev server{runningDevServerCount === 1 ? "" : "s"} still running — {runningDevServerCount === 1 ? "it" : "they"}&rsquo;ll be stopped automatically.
              On Windows a held file can occasionally block the wipe; if that happens, use the{" "}
              <span className="font-medium">&ldquo;Stop servers &amp; retry&rdquo;</span> action on the error.
            </div>
          )}
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
            onClick={() => onSend(typeof t.prompt === "function" ? t.prompt() : t.prompt)}
            className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
