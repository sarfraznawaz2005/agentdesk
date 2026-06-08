// ---------------------------------------------------------------------------
// Auto-Earn — engine ↔ view bridge store
//
// The Auto-Earn engine (InboxTab: webview sync, interceptor, full-auto send loop)
// must run regardless of which page the user is on — like the auto-shortlist
// engine. To achieve that, <InboxTab/> is mounted ONCE at the app shell (via
// <AlwaysMountedInbox/>) and never unmounts; it is PORTALED into the freelance
// Inbox tab's slot when the user is viewing it, and into a hidden holder otherwise.
//
// This store is the bridge: `slot` is the DOM node the freelance Inbox tab
// registers as the portal target (null when the user is elsewhere → engine runs
// hidden). InboxTab also reads `slot` to decide foreground vs. background, so the
// native webview is only ever shown while the Inbox tab is actually on screen.
// ---------------------------------------------------------------------------

import { create } from "zustand";

interface FreelanceEngineState {
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
}

export const useFreelanceEngineStore = create<FreelanceEngineState>((set) => ({
  slot: null,
  setSlot: (el) => set({ slot: el }),
}));
