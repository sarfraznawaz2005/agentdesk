/**
 * Desktop relay session manager (TASK-477 / 475 over the relay).
 *
 * Ties the outbound relay client + per-device E2E + RPC dispatch + broadcast
 * forwarding together. The desktop serves RPC to paired web clients THROUGH the
 * relay, exactly like rpc-ws-server does for direct connections, but with each
 * client's traffic end-to-end encrypted and addressed by a plaintext connection
 * id (`cid`) so multiple devices can share the one relay room without any relay
 * changes.
 *
 * Wire frames (JSON text; relay forwards them opaquely):
 *   client → desktop  { k:"hello", cid, pairingId, pub }                 (plaintext handshake)
 *   desktop → client  { k:"ack",  cid }                                  (plaintext)
 *   client → desktop  { k:"rpc",  cid, d:<b64 ciphertext {id,method,params}> }
 *   desktop → client  { k:"res",  cid, d:<b64 ciphertext {id,result|error}> }
 *   desktop → client  { k:"bc",   cid, d:<b64 ciphertext {method,payload}> }
 *
 * The pairing secret (HKDF salt) only ever travelled via the QR, so even though
 * both public keys cross the relay, the session key cannot be derived by a
 * relay-only observer. A `rpc` frame that fails to decrypt is dropped — that is
 * also how a client that lacks the right secret is rejected.
 */

import { startRelayClient, type RelayClient, type RelayStatus } from "./relay-client";
import { deriveSessionKey, encryptFrame, decryptFrame } from "../../shared/remote/e2e";

/* eslint-disable @typescript-eslint/no-explicit-any */
type RpcRequestHandlers = Record<string, (params: any) => unknown | Promise<unknown>>;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface ClientSession {
  key: CryptoKey;
}

export interface RelaySessionOptions {
  relayWss: string;
  desktopToken: string;
  desktopPrivateKey: CryptoKey;
  /**
   * Resolve a pairingId to its secret given the connecting client's public key,
   * or null if unknown/revoked/claimed-by-another-device. The desktop binds the
   * first device's key to make the pairing single-use (TASK-477).
   */
  resolvePairingSecret: (pairingId: string, clientPublicKeyB64: string) => Promise<string | null> | string | null;
  requestHandlers: RpcRequestHandlers;
  onStatus?: (status: RelayStatus) => void;
}

export interface RelaySession {
  status: () => RelayStatus;
  sessionCount: () => number;
  /** Push a broadcast to every connected client session (E2E, cid-addressed). */
  broadcast: (method: string, payload: unknown) => void;
  close: () => void;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const td = new TextDecoder();
const te = new TextEncoder();

export function startRelaySession(options: RelaySessionOptions): RelaySession {
  const sessions = new Map<string, ClientSession>();
  // Forward declaration: handle() (below) closes over `client`, but `client` is
  // built from startRelayClient(...) whose options reference handle — a mutually
  // recursive setup, so it must be `let` assigned after handle is defined.
  // eslint-disable-next-line prefer-const
  let client: RelayClient;

  async function handle(data: string | ArrayBuffer): Promise<void> {
    const text = typeof data === "string" ? data : td.decode(data);
    let f: { k?: string; cid?: string; pairingId?: string; pub?: string; d?: string };
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    if (!f || typeof f.cid !== "string") return;

    // --- handshake -----------------------------------------------------------
    if (f.k === "hello" && typeof f.pairingId === "string" && typeof f.pub === "string") {
      const secret = await options.resolvePairingSecret(f.pairingId, f.pub);
      if (!secret) {
        // unknown / revoked / claimed by another device / expired. Tell the
        // client so it can clear its stale pairing and prompt a re-pair, instead
        // of hanging forever on "Connecting…".
        try {
          client.send(JSON.stringify({ k: "reject", cid: f.cid }));
        } catch {
          /* client already gone */
        }
        return;
      }
      try {
        const key = await deriveSessionKey(options.desktopPrivateKey, f.pub, secret);
        sessions.set(f.cid, { key });
        client.send(JSON.stringify({ k: "ack", cid: f.cid }));
      } catch {
        /* derivation failed — ignore */
      }
      return;
    }

    // --- RPC -----------------------------------------------------------------
    if (f.k === "rpc" && typeof f.d === "string") {
      const sess = sessions.get(f.cid);
      if (!sess) return;
      let req: { id?: string; method?: string; params?: unknown };
      try {
        req = JSON.parse(td.decode(await decryptFrame(sess.key, b64ToBytes(f.d))));
      } catch {
        return; // could not decrypt → not a valid session for this client
      }
      if (typeof req.method !== "string") return;

      const fn = options.requestHandlers[req.method];
      let resPayload: { id?: string; result?: unknown; error?: string };
      if (!fn) {
        resPayload = { id: req.id, error: `unknown method: ${req.method}` };
      } else {
        try {
          resPayload = { id: req.id, result: await fn(req.params) };
        } catch (err) {
          resPayload = { id: req.id, error: err instanceof Error ? err.message : String(err) };
        }
      }
      const ct = await encryptFrame(sess.key, te.encode(JSON.stringify(resPayload)));
      client.send(JSON.stringify({ k: "res", cid: f.cid, d: bytesToB64(ct) }));
      return;
    }
  }

  client = startRelayClient({
    url: options.relayWss,
    token: options.desktopToken,
    onStatus: options.onStatus,
    onMessage: (data) => {
      void handle(data);
    },
  });

  function broadcast(method: string, payload: unknown): void {
    const text = JSON.stringify({ method, payload });
    for (const [cid, sess] of sessions) {
      void encryptFrame(sess.key, te.encode(text)).then((ct) => {
        client.send(JSON.stringify({ k: "bc", cid, d: bytesToB64(ct) }));
      });
    }
  }

  return {
    status: () => client.status(),
    sessionCount: () => sessions.size,
    broadcast,
    close: () => client.close(),
  };
}
