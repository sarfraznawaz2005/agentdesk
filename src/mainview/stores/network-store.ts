import { create } from "zustand";

interface NetworkState {
  /** null = initial probe not yet complete */
  isOnline: boolean | null;
  setOnline: (v: boolean) => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
  isOnline: null,
  setOnline: (v) => set({ isOnline: v }),
}));
