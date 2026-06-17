import { useEffect } from "react";
import { useNetworkStore } from "@/stores/network-store";
import { rpc } from "@/lib/rpc";

const POLL_WHEN_ONLINE_MS = 30_000;
const POLL_WHEN_OFFLINE_MS = 10_000;

// Probe via Bun backend — avoids WebView2 CORS/SSL restrictions on bare IP fetches.
async function probe(): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    const result = await rpc.checkInternet();
    return result.online;
  } catch {
    return navigator.onLine;
  }
}

/**
 * Mount once in AppShell. Writes real internet connectivity into useNetworkStore.
 *
 * Strategy:
 *  - Browser `offline` event → instant false (adapter disconnected, no probe needed)
 *  - Browser `online` event → probe via Bun (adapter up ≠ real internet)
 *  - Periodic background poll (30s online / 10s offline)
 */
export function useOnlineStatus(): void {
  const setOnline = useNetworkStore((s) => s.setOnline);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (online: boolean) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(runProbe, online ? POLL_WHEN_ONLINE_MS : POLL_WHEN_OFFLINE_MS);
    };

    const runProbe = async () => {
      const result = await probe();
      setOnline(result);
      schedule(result);
    };

    const onOffline = () => {
      setOnline(false);
      schedule(false);
    };

    const onOnline = () => {
      if (timer) clearTimeout(timer);
      void runProbe();
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    // Initial probe on mount.
    void runProbe();

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [setOnline]);
}
