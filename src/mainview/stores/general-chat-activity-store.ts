import { create } from "zustand";

// Session-local General Chat activity, for the sidebar nav item only. Unlike the
// per-project unread-store (server-backed project_activity), General Chat isn't a
// project and its turns don't survive an app restart, so an ephemeral client-side
// flag is enough: it drives a "working" spinner while a turn is in flight and a
// red "new activity" dot when a turn finishes while the user isn't on the page.
//
// Fed entirely by the global window events rpc.ts already dispatches
// (agentdesk:general-chat-run-started / -complete / -run-error), each carrying a
// conversationId — so it works even while the General Chat page is unmounted.

interface GeneralChatActivityStore {
	/** conversationIds with an in-flight turn — non-empty ⇒ show the working spinner. */
	runningIds: string[];
	/** A turn finished — show the red dot until the user visits General Chat. */
	hasUnread: boolean;
	markStarted: (conversationId: string) => void;
	markFinished: (conversationId: string) => void;
	clearUnread: () => void;
}

export const useGeneralChatActivityStore = create<GeneralChatActivityStore>((set) => ({
	runningIds: [],
	hasUnread: false,
	markStarted: (conversationId) =>
		set((s) => (s.runningIds.includes(conversationId) ? s : { runningIds: [...s.runningIds, conversationId] })),
	markFinished: (conversationId) =>
		set((s) => ({ runningIds: s.runningIds.filter((c) => c !== conversationId), hasUnread: true })),
	clearUnread: () => set({ hasUnread: false }),
}));

// ---- module-load wiring (mirrors unread-store) ----------------------------

let attached = false;
function initGeneralChatActivityListeners(): void {
	if (attached || typeof window === "undefined") return;
	attached = true;
	const store = useGeneralChatActivityStore;
	window.addEventListener("agentdesk:general-chat-run-started", (e) => {
		const { conversationId } = (e as CustomEvent).detail;
		if (conversationId) store.getState().markStarted(conversationId);
	});
	const onFinish = (e: Event) => {
		const { conversationId } = (e as CustomEvent).detail;
		if (conversationId) store.getState().markFinished(conversationId);
	};
	window.addEventListener("agentdesk:general-chat-complete", onFinish);
	window.addEventListener("agentdesk:general-chat-run-error", onFinish);
}

initGeneralChatActivityListeners();
