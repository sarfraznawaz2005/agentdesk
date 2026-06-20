/**
 * Desktop outbound relay client (TASK-476).
 *
 * The desktop DIALS OUT to the relay (wss://relay.agentdesk.workers.dev) and
 * registers as the `desktop` for its pairing room. Because the connection is
 * OUTBOUND, it traverses home NAT/CGNAT/firewalls with no port-forwarding.
 *
 * This module owns only the transport concerns — dial, status, auto-reconnect
 * with exponential backoff, and raw frame send/receive. The end-to-end
 * encryption (src/shared/remote/e2e.ts) and RPC dispatch (rpc-ws-server's
 * request handlers) are layered on top by the pairing/session wiring
 * (TASK-477) and broadcast forwarding (TASK-475).
 *
 * Uses the global `WebSocket` (available in Bun and the browser), so the same
 * approach is mirrored by the web client (TASK-482).
 */

export type RelayStatus = "connecting" | "online" | "offline";

export interface RelayClient {
  /** Send a raw frame. Returns false if not currently connected. */
  send: (data: string | ArrayBufferLike | ArrayBufferView) => boolean;
  status: () => RelayStatus;
  /** Permanently close — stops reconnecting. */
  close: () => void;
}

export interface RelayClientOptions {
  /** Relay base URL, e.g. wss://relay.agentdesk.workers.dev */
  url: string;
  /** The desktop's signed token (role=desktop), from relay POST /register. */
  token: string;
  onMessage?: (data: string | ArrayBuffer) => void;
  onStatus?: (status: RelayStatus) => void;
  /** Default true. */
  reconnect?: boolean;
  /** Initial reconnect delay (ms). Default 500. */
  minBackoffMs?: number;
  /** Max reconnect delay (ms). Default 15000. */
  maxBackoffMs?: number;
}

export function startRelayClient(options: RelayClientOptions): RelayClient {
  const minBackoff = options.minBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 15_000;
  const reconnectEnabled = options.reconnect !== false;

  let ws: WebSocket | null = null;
  let status: RelayStatus = "connecting";
  let backoff = minBackoff;
  let closedByUser = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(next: RelayStatus): void {
    if (next === status) return;
    status = next;
    try {
      options.onStatus?.(next);
    } catch {
      /* listener errors must not break the client */
    }
  }

  function scheduleReconnect(): void {
    if (closedByUser || !reconnectEnabled || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoff);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closedByUser) return;
    setStatus("connecting");
    const url = `${options.url}?token=${encodeURIComponent(options.token)}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      backoff = minBackoff; // reset on a successful connect
      setStatus("online");
    });
    socket.addEventListener("message", (ev: MessageEvent) => {
      try {
        options.onMessage?.(ev.data as string | ArrayBuffer);
      } catch {
        /* swallow handler errors */
      }
    });
    socket.addEventListener("close", () => {
      if (ws === socket) ws = null;
      setStatus("offline");
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // Surface as a close → triggers reconnect.
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    });
  }

  connect();

  return {
    send(data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data as string);
        return true;
      }
      return false;
    },
    status: () => status,
    close() {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      setStatus("offline");
    },
  };
}
