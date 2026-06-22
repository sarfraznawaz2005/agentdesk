import { create } from "zustand";
import { rpc } from "@/lib/rpc";
import { createCoalescer } from "@/lib/coalesce";

// Per-project unread agent-activity, persisted server-side in the project_activity
// table. Entries are flat keys `${projectId}::${location}` — e.g.
// "abc123::chat" or "abc123::issue-fixer:history". Components subscribe with a
// selector that derives a boolean (so they only re-render when the dot flips):
//   useUnreadStore((s) => s.entries.some((k) => k === `${projectId}::chat`))
//   useUnreadStore((s) => s.entries.some((k) => k.startsWith(`${projectId}::issue-fixer`)))

const key = (projectId: string, location: string) => `${projectId}::${location}`;

// Pseudo-location for the per-project card acknowledgment (mirrors the backend).
const CARD_LOCATION = "__card__";

interface UnreadStore {
	entries: string[]; // leaf keys `${projectId}::${location}`
	cards: string[];   // projectIds whose dashboard card dot should show
	load: () => Promise<void>;
	/** Mark a leaf location read (optimistic) and persist it. */
	markSeen: (projectId: string, location: string) => void;
	/** Acknowledge a project's card dot (on project open) without touching leaf dots. */
	markCardSeen: (projectId: string) => void;
}

export const useUnreadStore = create<UnreadStore>((set, get) => ({
	entries: [],
	cards: [],

	load: async () => {
		try {
			const res = await rpc.getUnreadActivity();
			set({
				entries: res.entries.map((e) => key(e.projectId, e.location)),
				cards: res.cards,
			});
		} catch {
			/* ignore */
		}
	},

	markSeen: (projectId, location) => {
		const k = key(projectId, location);
		if (get().entries.includes(k)) {
			set((s) => ({ entries: s.entries.filter((e) => e !== k) }));
		}
		rpc.markActivitySeen(projectId, location).catch(() => {});
	},

	markCardSeen: (projectId) => {
		if (get().cards.includes(projectId)) {
			set((s) => ({ cards: s.cards.filter((p) => p !== projectId) }));
		}
		rpc.markActivitySeen(projectId, CARD_LOCATION).catch(() => {});
	},
}));

// ---- selector helpers (keep call sites terse + consistent) -----------------

export const hasUnread = (projectId: string, location: string) => (s: UnreadStore) =>
	s.entries.includes(key(projectId, location));

export const hasUnreadPrefix = (projectId: string, prefix: string) => (s: UnreadStore) =>
	s.entries.some((e) => e.startsWith(`${projectId}::${prefix}`));

// Card-level: shows only for activity newer than the last card acknowledgment.
export const hasAnyUnread = (projectId: string) => (s: UnreadStore) =>
	s.cards.includes(projectId);

// ---- module-load wiring (mirrors issue-fixer-store) ------------------------

let attached = false;
function initUnreadListeners(): void {
	if (attached || typeof window === "undefined") return;
	attached = true;
	// Any record/mark on the backend re-broadcasts activity-updated — including the
	// echo from our OWN optimistic markSeen. Coalesce a burst (that echo plus any
	// concurrent agent activity) into a single trailing reload, so the optimistic
	// local update isn't immediately re-fetched once per event. Live updates still
	// arrive (~250ms trailing).
	const reload = createCoalescer(() => void useUnreadStore.getState().load(), { windowMs: 250 });
	window.addEventListener("agentdesk:activity-updated", reload);
	void useUnreadStore.getState().load();
}

initUnreadListeners();
