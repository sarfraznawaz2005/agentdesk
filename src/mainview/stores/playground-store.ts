import { create } from "zustand";
import type { MessagePartData } from "@/components/chat/message-parts";
import type { PlaygroundPreviewDto } from "../../shared/rpc/playground";

export interface PlaygroundRejection {
  reason: string;
  guidance: string;
}

export interface PlaygroundTokens {
  prompt: number;
  completion: number;
  contextLimit?: number;
}

export interface PlaygroundConsoleEntry {
  level: string;
  message: string;
}

export interface PlaygroundTurn {
  role: "user" | "assistant";
  content: string;
}

interface PlaygroundState {
  running: boolean;
  parts: MessagePartData[];
  preview: PlaygroundPreviewDto | null;
  history: PlaygroundPreviewDto[];
  rejection: PlaygroundRejection | null;
  mainView: "activity" | "preview";
  lastSummary: string | null;
  lastStatus: string | null;
  tokens: PlaygroundTokens | null;
  consoleErrors: PlaygroundConsoleEntry[];
  reloadNonce: number;
  hasFiles: boolean;
  error: string | null;
  lastUserMessage: string | null;
  /** Persisted conversation turns shown in the Activity pane when there's no live run. */
  transcript: PlaygroundTurn[];
  /** Last successfully deployed surge.sh URL — persisted across navigation and restarts. */
  deployedUrl: string | null;

  // actions
  setMainView: (v: "activity" | "preview") => void;
  setDeployedUrl: (url: string | null) => void;
  showPreview: (p: PlaygroundPreviewDto) => void;
  selectPreview: (p: PlaygroundPreviewDto) => void;
  setPreviewUrl: (url: string) => void;
  bumpReload: () => void;
  pushConsole: (e: PlaygroundConsoleEntry) => void;
  clearConsole: () => void;
  hydrate: (s: {
    running: boolean;
    hasFiles: boolean;
    preview: PlaygroundPreviewDto | null;
    parts?: MessagePartData[];
    tokens?: PlaygroundTokens | null;
    lastSummary?: string | null;
    lastStatus?: string | null;
    error?: string | null;
    lastUserMessage?: string | null;
    history?: PlaygroundTurn[];
    deployedUrl?: string | null;
  }) => void;
  reset: () => void;

  // event ingestion
  onRunStarted: (message: string) => void;
  onPart: (part: MessagePartData) => void;
  onPartUpdated: (partId: string, updates: Partial<MessagePartData>) => void;
  onPartsRemoved: (partIds: string[]) => void;
  onAgentComplete: (status: string, summary: string, tokens: PlaygroundTokens) => void;
  onRunComplete: () => void;
  onRunError: (error: string) => void;
  onRejected: (r: PlaygroundRejection) => void;
}

const MAX_HISTORY = 8;
const MAX_CONSOLE = 50;

const initialState = {
  running: false,
  parts: [] as MessagePartData[],
  preview: null as PlaygroundPreviewDto | null,
  history: [] as PlaygroundPreviewDto[],
  rejection: null as PlaygroundRejection | null,
  mainView: "activity" as const,
  lastSummary: null as string | null,
  lastStatus: null as string | null,
  tokens: null as PlaygroundTokens | null,
  consoleErrors: [] as PlaygroundConsoleEntry[],
  reloadNonce: 0,
  hasFiles: false,
  error: null as string | null,
  lastUserMessage: null as string | null,
  transcript: [] as PlaygroundTurn[],
  deployedUrl: null as string | null,
};

export const usePlaygroundStore = create<PlaygroundState>((set) => ({
  ...initialState,

  setMainView: (mainView) => set({ mainView }),
  setDeployedUrl: (deployedUrl) => set({ deployedUrl }),

  showPreview: (preview) =>
    set((s) => {
      const history = [preview, ...s.history.filter((p) => p.url !== preview.url)].slice(0, MAX_HISTORY);
      // New render → reset captured console so the count reflects this render only.
      return { preview, history, mainView: "preview", reloadNonce: s.reloadNonce + 1, rejection: null, consoleErrors: [] };
    }),

  // Select an existing history snapshot WITHOUT reordering history — clicking a
  // tab should just activate it in place, not move it to the front (which would
  // make the highlight jump to a different position than the one clicked).
  selectPreview: (preview) =>
    set((s) => ({ preview, mainView: "preview", reloadNonce: s.reloadNonce + 1, rejection: null, consoleErrors: [] })),

  // Point the active preview at a new URL (user-editable address bar). Updates the
  // matching history entry in place so the active highlight keeps matching, and
  // reloads the iframe. The new URL is persisted to disk separately via RPC.
  setPreviewUrl: (url) =>
    set((s) => {
      if (!s.preview) return {};
      const prevUrl = s.preview.url;
      const updated = { ...s.preview, url };
      return {
        preview: updated,
        history: s.history.map((h) => (h.url === prevUrl ? updated : h)),
        reloadNonce: s.reloadNonce + 1,
        consoleErrors: [],
      };
    }),

  bumpReload: () => set((s) => ({ reloadNonce: s.reloadNonce + 1, consoleErrors: [] })),

  pushConsole: (e) =>
    set((s) => ({ consoleErrors: [...s.consoleErrors, e].slice(-MAX_CONSOLE) })),

  clearConsole: () => set({ consoleErrors: [] }),

  hydrate: ({ running, hasFiles, preview, parts, tokens, lastSummary, lastStatus, error, lastUserMessage, history, deployedUrl }) =>
    set((s) => ({
      running,
      hasFiles,
      preview: preview ?? s.preview,
      history: preview && !s.history.some((p) => p.url === preview.url) ? [preview, ...s.history].slice(0, MAX_HISTORY) : s.history,
      mainView: preview ? "preview" : s.mainView,
      parts: parts && parts.length ? parts : s.parts,
      tokens: tokens ?? s.tokens,
      lastSummary: lastSummary ?? s.lastSummary,
      lastStatus: lastStatus ?? s.lastStatus,
      error: error !== undefined ? error : s.error,
      lastUserMessage: lastUserMessage ?? s.lastUserMessage,
      transcript: history ?? s.transcript,
      deployedUrl: deployedUrl ?? s.deployedUrl,
      consoleErrors: [],
    })),

  reset: () => set({ ...initialState }),

  // ---- event ingestion ----------------------------------------------------

  onRunStarted: (message) =>
    set({ running: true, parts: [], rejection: null, mainView: "activity", consoleErrors: [], lastSummary: null, lastStatus: null, error: null, lastUserMessage: message }),

  onPart: (part) =>
    set((s) => {
      const idx = s.parts.findIndex((p) => p.id === part.id);
      if (idx >= 0) {
        const next = s.parts.slice();
        next[idx] = part;
        return { parts: next };
      }
      return { parts: [...s.parts, part], hasFiles: true };
    }),

  onPartUpdated: (partId, updates) =>
    set((s) => ({
      parts: s.parts.map((p) => (p.id === partId ? { ...p, ...updates } : p)),
    })),

  onPartsRemoved: (partIds) =>
    set((s) => ({
      parts: s.parts.filter((p) => !partIds.includes(p.id)),
    })),

  onAgentComplete: (status, summary, tokens) =>
    set({ lastStatus: status, lastSummary: summary, tokens }),

  onRunComplete: () => set({ running: false }),

  onRunError: (error) => set({ error, running: false }),

  onRejected: (rejection) => set({ rejection, mainView: "activity" }),
}));
