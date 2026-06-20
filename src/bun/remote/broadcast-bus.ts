/**
 * Pure broadcast fan-out bus (TASK-475).
 *
 * No app/Electrobun imports — unit-testable in isolation. The engine-manager
 * remote sink calls `emitBroadcast()`; each registered target forwards the event
 * to a remote transport:
 *   • the local WS server (rpc-ws-server.broadcast), and
 *   • the E2E relay session, once a device is paired (TASK-477).
 *
 * A target failure is isolated and never affects the other targets or the
 * in-app webview path.
 *
 * Filtering note: payloads already carry conversationId / sessionId / projectId
 * (see src/shared/rpc/webview.ts), and the client filters by its active
 * conversation exactly as the in-app webview does — so forwarding is broadcast
 * and the client narrows. Per-target server-side filtering can be layered on a
 * target wrapper later if needed.
 */

export type BroadcastTarget = (method: string, payload: unknown) => void;

const targets = new Set<BroadcastTarget>();

/** Register a remote transport to receive forwarded broadcasts. Returns an off(). */
export function addBroadcastTarget(target: BroadcastTarget): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}

/** Fan a broadcast out to every registered target, isolating failures. */
export function emitBroadcast(method: string, payload: unknown): void {
  for (const target of targets) {
    try {
      target(method, payload);
    } catch {
      // Isolate target failures — one bad target must not starve the others.
    }
  }
}

export function broadcastTargetCount(): number {
  return targets.size;
}
