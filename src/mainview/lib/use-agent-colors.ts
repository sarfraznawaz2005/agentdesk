import { useState, useEffect } from "react";
import { rpc } from "./rpc";

// Module-level cache — fetched once for the lifetime of the app session.
let cache: Map<string, string> | null = null;
let fetchPromise: Promise<void> | null = null;
const subscribers = new Set<(map: Map<string, string>) => void>();

function ensureFetched() {
  if (cache || fetchPromise) return;
  fetchPromise = rpc.getAgents().then((agents) => {
    cache = new Map(agents.map((a) => [a.name, a.color]));
    subscribers.forEach((cb) => cb(cache ?? new Map()));
    subscribers.clear();
  }).catch(() => {
    fetchPromise = null; // allow retry on next mount
  });
}

/**
 * Returns a stable `name → color` map for all agents.
 * The RPC call is made at most once per app session.
 */
export function useAgentColorMap(): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(cache ?? new Map());

  useEffect(() => {
    if (cache) {
      setMap(cache); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }
    subscribers.add(setMap);
    ensureFetched();
    return () => { subscribers.delete(setMap); };
  }, []);

  return map;
}
