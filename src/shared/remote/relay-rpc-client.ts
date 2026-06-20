/**
 * Web client transport over the relay (TASK-482 core) — the mirror of the
 * desktop relay-session manager (src/bun/remote/relay-session.ts).
 *
 * Connects to the relay as the `client`, performs the pairing handshake, and
 * speaks the cid-addressed, end-to-end-encrypted RPC protocol so the web app can
 * call backend methods and receive broadcasts from the desktop. Exposes the same
 * `.request()` shape as the direct WS-RPC client, so the rpc.ts adapter can use
 * either transport.
 *
 * Portable Web Crypto + global WebSocket → runs in the browser (and in Bun for
 * tests).
 */

import { encryptFrame, decryptFrame } from "./e2e";

export type RelayRpcStatus = "connecting" | "online" | "offline";

export interface RelayRpcClientOptions {
  relayWss: string;
  clientToken: string;
  pairingId: string;
  clientPublicKeyB64: string;
  sessionKey: CryptoKey;
  onBroadcast?: (method: string, payload: unknown) => void;
  onStatus?: (status: RelayRpcStatus) => void;
  /**
   * The desktop rejected our pairing (revoked / unknown / claimed by another
   * device / expired). Reconnecting can never succeed, so we stop and let the
   * caller clear the stale pairing and prompt the user to re-pair.
   */
  onRejected?: () => void;
  reconnect?: boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
}

export interface RelayRpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  status(): RelayRpcStatus;
  close(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const te = new TextEncoder();
const td = new TextDecoder();
const toB64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const fromB64 = (s: string) => {
  const bin = atob(s);
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
};

export function createRelayRpcClient(options: RelayRpcClientOptions): RelayRpcClient {
  const minBackoff = options.minBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 15_000;
  const reconnectEnabled = options.reconnect !== false;
  const requestTimeoutMs = options.requestTimeoutMs ?? 0;
  const cid = `c${Math.floor((globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] ?? 0))}`;

  let ws: WebSocket | null = null;
  let status: RelayRpcStatus = "connecting";
  let backoff = minBackoff;
  let closedByUser = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Re-sends `hello` until the desktop acks. The relay drops a hello when no
  // desktop is in the room (e.g. it's restarting), and a single open-time hello
  // would otherwise leave us stuck "connecting" forever once the desktop returns.
  let helloTimer: ReturnType<typeof setInterval> | null = null;
  let seq = 0;
  const pending = new Map<string, Pending>();
  const outbox: string[] = [];

  /** How often to re-send an unacked hello while connecting. */
  const HELLO_RETRY_MS = 2500;

  function stopHelloRetry(): void {
    if (helloTimer) {
      clearInterval(helloTimer);
      helloTimer = null;
    }
  }

  function setStatus(next: RelayRpcStatus): void {
    if (next === status) return;
    status = next;
    try {
      options.onStatus?.(next);
    } catch {
      /* ignore */
    }
  }

  function sendRaw(text: string): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(text);
    else outbox.push(text);
  }

  function flushOutbox(): void {
    const queued = outbox.splice(0, outbox.length);
    for (const t of queued) sendRaw(t);
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
    let f: { k?: string; cid?: string; d?: string };
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    if (f.cid !== cid) return; // not addressed to us

    if (f.k === "ack") {
      stopHelloRetry();
      backoff = minBackoff;
      setStatus("online");
      flushOutbox();
      return;
    }
    if (f.k === "reject") {
      // The desktop refused this pairing — retrying is pointless. Stop the
      // reconnect loop and tell the caller to re-pair.
      closedByUser = true;
      stopHelloRetry();
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
      try {
        options.onRejected?.();
      } catch {
        /* ignore */
      }
      return;
    }
    if ((f.k === "res" || f.k === "bc") && typeof f.d === "string") {
      let obj: { id?: string; result?: unknown; error?: string; method?: string; payload?: unknown };
      try {
        obj = JSON.parse(td.decode(await decryptFrame(options.sessionKey, fromB64(f.d))));
      } catch {
        return;
      }
      if (f.k === "res" && obj.id) {
        const p = pending.get(obj.id);
        if (p) {
          pending.delete(obj.id);
          if (p.timer) clearTimeout(p.timer);
          if (obj.error) p.reject(new Error(obj.error));
          else p.resolve(obj.result);
        }
      } else if (f.k === "bc" && typeof obj.method === "string") {
        try {
          options.onBroadcast?.(obj.method, obj.payload);
        } catch {
          /* ignore */
        }
      }
    }
  }

  function connect(): void {
    if (closedByUser) return;
    setStatus("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${options.relayWss}/?token=${encodeURIComponent(options.clientToken)}`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      // Handshake: send our public key so the desktop can derive the session.
      const hello = JSON.stringify({ k: "hello", cid, pairingId: options.pairingId, pub: options.clientPublicKeyB64 });
      socket.send(hello);
      // Keep re-sending until we get an ack — covers the desktop joining the room
      // AFTER us (its hello-less window would otherwise strand us on "connecting").
      stopHelloRetry();
      helloTimer = setInterval(() => {
        if (ws === socket && socket.readyState === WebSocket.OPEN && status !== "online") {
          try { socket.send(hello); } catch { /* will retry or close */ }
        } else {
          stopHelloRetry();
        }
      }, HELLO_RETRY_MS);
    });
    socket.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data;
      void handleFrame(typeof data === "string" ? data : td.decode(data as ArrayBuffer));
    });
    socket.addEventListener("close", () => {
      if (ws === socket) ws = null;
      stopHelloRetry();
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
        void encryptFrame(options.sessionKey, te.encode(JSON.stringify({ id, method, params }))).then((ct) => {
          sendRaw(JSON.stringify({ k: "rpc", cid, d: toB64(ct) }));
        });
      });
    },
    status: () => status,
    close(): void {
      closedByUser = true;
      stopHelloRetry();
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
