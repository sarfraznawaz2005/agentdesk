import { create } from "zustand";

// Registry that backs the dashboard chat FAB. The launchers would otherwise
// render as a row of labelled pills (one per chat-enabled agent + the PM) that
// stack into many rows and bury the dashboard once a few agents are enabled.
// Instead each widget hides its own pill and *registers* itself here; a single
// floating FAB (chat-fab.tsx) lists every registered launcher by name + colour
// and re-opens the chosen one via `requestOpen`, on all screen sizes.
//
// The chat panels themselves still live inside each widget — this store only
// relays "which launcher should open" (FAB → widget) and "which launcher is
// currently open" (widget → FAB, so the FAB can step aside).

export interface LauncherEntry {
  id:          string;  // stable: "pm" or `agent:${agentName}`
  displayName: string;
  color:       string;  // CSS colour for the list dot (PM uses a fixed indigo)
  order:       number;  // 0 = PM (pinned first), 1 = custom agents (then A→Z)
  unread:      boolean;
}

interface LauncherStore {
  entries:       Record<string, LauncherEntry>;
  openRequestId: string | null; // FAB → widget: please open this launcher
  activeOpenId:  string | null; // widget → FAB: this launcher's panel is open

  register:         (entry: LauncherEntry) => void;
  unregister:       (id: string) => void;
  setUnread:        (id: string, unread: boolean) => void;
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

  requestOpen:      (id) => set({ openRequestId: id }),
  clearOpenRequest: () => set({ openRequestId: null }),
  setActiveOpen:    (id) => set({ activeOpenId: id }),
  clearActiveOpen:  (id) => set((s) => (s.activeOpenId === id ? { activeOpenId: null } : {})),
}));

// True once at least one custom agent (order !== 0, i.e. not the PM) is
// registered. The FAB only earns its place when there are multiple launchers to
// consolidate; with PM alone the dashboard shows the PM pill directly. Returns a
// boolean so subscribers only re-render when the condition flips.
export const selectHasCustomAgents = (s: LauncherStore) =>
  Object.values(s.entries).some((e) => e.order !== 0);
