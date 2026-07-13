import { create } from "zustand";

// Registry that backs the persistent chat launcher footer. The launchers would
// otherwise render as a row of labelled pills (one per chat-enabled agent + the
// PM) that stack into many rows and bury the page once a few agents are
// enabled. Instead each widget hides its own pill and *registers* itself here;
// a single footer bar (chat-launcher-footer.tsx), available on every page,
// lists every registered launcher by name + colour and toggles the chosen one
// open/closed via `requestOpen`.
//
// The chat panels themselves still live inside each widget — this store only
// relays "please open/close this launcher" (footer → widget) and "which
// launcher is currently open" (widget → footer, so it can highlight it).

export interface LauncherEntry {
  id:          string;  // stable: "pm" or `agent:${agentName}`
  displayName: string;
  color:       string;  // CSS colour for the list dot (PM uses a fixed indigo)
  order:       number;  // 0 = PM (pinned first), 1 = custom agents (then A→Z)
  unread:      boolean;
  streaming:   boolean; // the agent is actively generating a reply right now
}

interface LauncherStore {
  entries:       Record<string, LauncherEntry>;
  openRequestId: string | null; // footer → widget: please toggle this launcher open/closed
  activeOpenId:  string | null; // widget → footer: this launcher's panel is open

  register:         (entry: LauncherEntry) => void;
  unregister:       (id: string) => void;
  setUnread:        (id: string, unread: boolean) => void;
  setStreaming:     (id: string, streaming: boolean) => void;
  requestOpen:      (id: string) => void;
  clearOpenRequest: () => void;
  setActiveOpen:    (id: string) => void;
  clearActiveOpen:  (id: string) => void; // no-op unless `id` is the active one
}

export const useDashboardLauncherStore = create<LauncherStore>((set) => ({
  entries:       {},
  openRequestId: null,
  activeOpenId:  null,

  register: (entry) =>
    set((s) => ({ entries: { ...s.entries, [entry.id]: entry } })),

  unregister: (id) =>
    set((s) => {
      if (!s.entries[id]) return {};
      const { [id]: _removed, ...rest } = s.entries;
      return { entries: rest };
    }),

  setUnread: (id, unread) =>
    set((s) => {
      const cur = s.entries[id];
      if (!cur || cur.unread === unread) return {};
      return { entries: { ...s.entries, [id]: { ...cur, unread } } };
    }),

  setStreaming: (id, streaming) =>
    set((s) => {
      const cur = s.entries[id];
      if (!cur || cur.streaming === streaming) return {};
      return { entries: { ...s.entries, [id]: { ...cur, streaming } } };
    }),

  requestOpen:      (id) => set({ openRequestId: id }),
  clearOpenRequest: () => set({ openRequestId: null }),
  setActiveOpen:    (id) => set({ activeOpenId: id }),
  clearActiveOpen:  (id) => set((s) => (s.activeOpenId === id ? { activeOpenId: null } : {})),
}));
