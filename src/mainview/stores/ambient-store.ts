import { create } from "zustand";

interface AmbientState {
  open: boolean;
  /** True when Ambient Mode was entered via the idle timer rather than a direct user gesture — requestFullscreen() is expected to be refused by the browser in this case (no user gesture), so the overlay should not treat that as an error. */
  triggeredByIdle: boolean;
  activate: (opts?: { idle?: boolean }) => void;
  dismiss: () => void;
}

export const useAmbientStore = create<AmbientState>((set) => ({
  open: false,
  triggeredByIdle: false,
  activate: (opts) => set({ open: true, triggeredByIdle: opts?.idle ?? false }),
  dismiss: () => set({ open: false, triggeredByIdle: false }),
}));
