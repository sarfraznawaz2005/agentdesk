import { useEffect } from "react";
import { useNetworkStore } from "@/stores/network-store";

// Cloudflare's anycast IP — no DNS lookup, always up, lightweight HEAD.
const PROBE_URL = "https://1.1.1.1";
const PROBE_TIMEOUT_MS = 4_000;
const POLL_WHEN_ONLINE_MS = 30_000;
const POLL_WHEN_OFFLINE_MS = 10_000;

async function probe(): Promise<boolean> {
  // Fast-path: adapter is already known offline — skip the fetch entirely.
  if (!navigator.onLine) return false;
  try {
    const res = await fetch(PROBE_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Mount once in AppShell. Writes real internet connectivity into useNetworkStore.
 *
 * Strategy:
 *  - Browser `offline` event → instant false (adapter disconnected, no probe needed)
 *  - Browser `online` event → probe (adapter up ≠ real internet, e.g. captive portal)
 *  - Periodic background poll (30s online / 10s offline) — catches ISP-level drops
 *    that don't fire browser events
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
      // Adapter came back — verify real internet before marking online.
      if (timer) clearTimeout(timer);
      void runProbe();
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    // Initial probe on mount — don't wait for first poll interval.
    void runProbe();

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [setOnline]);
}
