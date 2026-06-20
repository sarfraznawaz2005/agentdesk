/**
 * Transport-agnostic WebSocket RPC client (TASK-479 core, reused by TASK-482).
 *
 * Speaks the same envelope as src/bun/remote/rpc-ws-server.ts:
 *   request  → { t:"req", id, method, params }   ← { t:"res"|"err", id, ... }
 *   subscribe→ { t:"sub", ids:[...] }
 *   inbound  ← { t:"broadcast", method, payload }
 *
 * Uses the global `WebSocket`, so it runs in the browser (web app) and in Bun
 * (tests). The frontend adapter (src/mainview/lib/rpc.ts) wraps this in a Proxy
 * so `rpc.request.<method>(params)` and `rpc.send.<method>(payload)` map onto
 * `request()` — and re-emits broadcasts as the existing `agentdesk:*` DOM events
 * — when running in a plain browser instead of under Electrobun.
 *
 * Confidentiality is layered on by passing an optional `codec` (the E2E
 * encrypt/decrypt from src/shared/remote/e2e.ts) once a device is paired
 * (TASK-482). Without a codec it speaks plaintext frames (direct/LAN/dev).
 */

export type WsRpcStatus = "connecting" | "online" | "offline";

export interface WsRpcCodec {
  encode: (text: string) => Promise<ArrayBufferLike> | ArrayBufferLike;
  decode: (data: ArrayBuffer) => Promise<string> | string;
}

export interface WsRpcClientOptions {
  url: string;
  onBroadcast?: (method: string, payload: unknown) => void;
  onStatus?: (status: WsRpcStatus) => void;
  reconnect?: boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** 0 = no timeout (agent ops can run for minutes). Default 0. */
  requestTimeoutMs?: number;
  /** Optional E2E codec; omit for plaintext frames. */
  codec?: WsRpcCodec;
}

export interface WsRpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Narrow which broadcast routing ids are received (null = all). */
  subscribe(ids: string[] | null): void;
  status(): WsRpcStatus;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createWsRpcClient(options: WsRpcClientOptions): WsRpcClient {
  const minBackoff = options.minBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 15_000;
  const reconnectEnabled = options.reconnect !== false;
  const requestTimeoutMs = options.requestTimeoutMs ?? 0;

  let ws: WebSocket | null = null;
  let status: WsRpcStatus = "connecting";
  let backoff = minBackoff;
  let closedByUser = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  const pending = new Map<string, Pending>();
  const outbox: string[] = [];
  let currentSub: string[] | null = null;

  function setStatus(next: WsRpcStatus): void {
    if (next === status) return;
    status = next;
    try {
      options.onStatus?.(next);
    } catch {
      /* ignore listener errors */
    }
  }

  async function rawSend(text: string): Promise<void> {
    const payload = options.codec ? await options.codec.encode(text) : text;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload as string);
    } else {
      // Queue the *plaintext*; it is re-encoded at flush so a new session key
      // (after reconnect) is honored.
      outbox.push(text);
    }
  }

  function flushOutbox(): void {
    const queued = outbox.splice(0, outbox.length);
    for (const text of queued) void rawSend(text);
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

  async function handleFrame(text: string): Promise<void> {
    let msg: { t?: string; id?: string; result?: unknown; message?: string; method?: string; payload?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === "res" && msg.id) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        p.resolve(msg.result);
      }
    } else if (msg.t === "err" && msg.id) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(msg.message ?? "rpc error"));
      }
    } else if (msg.t === "broadcast" && typeof msg.method === "string") {
      try {
        options.onBroadcast?.(msg.method, msg.payload);
      } catch {
        /* ignore handler errors */
      }
    }
  }

  function connect(): void {
    if (closedByUser) return;
    setStatus("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(options.url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      backoff = minBackoff;
      setStatus("online");
      if (currentSub !== null) void rawSend(JSON.stringify({ t: "sub", ids: currentSub }));
      flushOutbox();
    });
    socket.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data;
      if (typeof data === "string") {
        void handleFrame(data);
      } else if (options.codec && data instanceof ArrayBuffer) {
        void Promise.resolve(options.codec.decode(data)).then(handleFrame);
      } else if (data instanceof ArrayBuffer) {
        void handleFrame(new TextDecoder().decode(data));
      }
    });
    socket.addEventListener("close", () => {
      if (ws === socket) ws = null;
      setStatus("offline");
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    });
  }

  connect();

  return {
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      const id = `r${++seq}`;
      return new Promise<T>((resolve, reject) => {
        const timer =
          requestTimeoutMs > 0
            ? setTimeout(() => {
                pending.delete(id);
                reject(new Error(`rpc timeout: ${method}`));
              }, requestTimeoutMs)
            : null;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        void rawSend(JSON.stringify({ t: "req", id, method, params }));
      });
    },
    subscribe(ids: string[] | null): void {
      currentSub = ids;
      void rawSend(JSON.stringify({ t: "sub", ids: ids ?? [] }));
    },
    status: () => status,
    close(): void {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      for (const [, p] of pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error("client closed"));
      }
      pending.clear();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      setStatus("offline");
    },
  };
}
