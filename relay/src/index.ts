/**
 * AgentDesk Relay — Cloudflare Worker + SQLite-backed Durable Object.
 *
 * The relay is a BLIND, STATELESS forwarder. Each user's desktop dials OUT and
 * registers under a pairing room; remote clients (the web app) connect to the
 * same room and are routed ONLY to that room's desktop. Frames are end-to-end
 * encrypted by the endpoints and forwarded OPAQUELY — the relay never decrypts
 * payloads. That keeps it cheap (no payload compute) and private (no user data
 * ever lives here).
 *
 * ─── Security model (v1 — REVIEW THIS) ──────────────────────────────────────
 * The deployment is zero-signup: there are no per-user accounts on the relay.
 * Trust is therefore split into two independent layers:
 *
 *   1. Relay admittance (this file). A connection must present a token signed
 *      with PAIRING_SIGNING_KEY (HMAC-SHA256). Tokens are minted by POST
 *      /register and are ROLE-SCOPED: a `desktop` token (kept private by the
 *      desktop) and a `client` token (shared to devices via the pairing QR).
 *      The role + room come from the SIGNED payload, never a query param, so a
 *      client-token holder cannot impersonate the desktop or hop rooms. Each
 *      token carries a unique `jti` and can be REVOKED (desktop-authenticated
 *      POST /revoke), which both blocks future connects and kicks any live
 *      socket. This stops the relay being an open public forwarder.
 *
 *   2. Confidentiality + per-device identity (endpoints, TASK-477/482). The
 *      desktop and client establish an end-to-end key out-of-band via the QR;
 *      the relay only sees ciphertext. The desktop is authoritative over which
 *      client public keys are allowed and can revoke them (paired_devices).
 *
 * So even a leaked `client` token only grants the ability to reach a room until
 * revoked; it cannot read or forge traffic without the E2E key the desktop
 * controls.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Scope: TASK-470 (scaffold) + TASK-472 (pairing handshake / token mint, verify,
 * revoke) + TASK-471 (authenticated identity routing, one-desktop-per-room,
 * lifecycle, cross-tenant isolation).
 */

import { DurableObject } from "cloudflare:workers";

export interface Env {
  RELAY: DurableObjectNamespace<RelayDurableObject>;
  /** Per-IP rate limiter for the open /register endpoint (TASK-492). */
  RATELIMIT: DurableObjectNamespace<RateLimiterDurableObject>;
  /**
   * HMAC key for signing/verifying pairing tokens. In production set via
   * `wrangler secret put PAIRING_SIGNING_KEY` (TASK-473). For local dev it is
   * read from relay/.dev.vars. Never committed; never sent to any client.
   */
  PAIRING_SIGNING_KEY?: string;
}

/** Per-key sliding-window rate limiter (one DO instance per IP). */
const REGISTER_LIMIT = 60; // registrations
const REGISTER_WINDOW_MS = 60 * 60 * 1000; // per IP per hour

type Role = "desktop" | "client";

interface TokenPayload {
  /** room id */
  r: string;
  /** role */
  role: Role;
  /** unique token id (for revocation) */
  jti: string;
  /** issued-at (epoch seconds) */
  iat: number;
  /** expiry (epoch seconds); omitted = no expiry */
  e?: number;
}

/** Close codes the relay uses (4xxx = application-defined). */
const CLOSE_DESKTOP_OFFLINE = 4001;
const CLOSE_DESKTOP_REPLACED = 4002;
const CLOSE_TOKEN_REVOKED = 4003;

// ─── token helpers (Web Crypto HMAC-SHA256) ─────────────────────────────────

const enc = new TextEncoder();

function b64urlFromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomId(bytes = 16): string {
  return b64urlFromBytes(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function signToken(key: CryptoKey, payload: TokenPayload): Promise<string> {
  const payloadB64 = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return `${payloadB64}.${b64urlFromBytes(sig)}`;
}

async function verifyToken(key: CryptoKey, token: string): Promise<TokenPayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let sig: Uint8Array;
  try {
    sig = bytesFromB64url(sigB64);
  } catch {
    return null;
  }
  // crypto.subtle.verify is constant-time for the comparison.
  const ok = await crypto.subtle.verify("HMAC", key, sig, enc.encode(payloadB64));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(payloadB64))) as TokenPayload;
    if (payload.role !== "desktop" && payload.role !== "client") return null;
    if (typeof payload.r !== "string" || payload.r.length === 0) return null;
    if (typeof payload.jti !== "string" || payload.jti.length === 0) return null;
    if (typeof payload.e === "number" && payload.e < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function getSigningSecret(env: Env): string | null {
  return env.PAIRING_SIGNING_KEY && env.PAIRING_SIGNING_KEY.length > 0 ? env.PAIRING_SIGNING_KEY : null;
}

// ─── Durable Object: one instance per pairing room ──────────────────────────

export class RelayDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS paired_devices (
          device_id   TEXT PRIMARY KEY,
          public_key  TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          revoked     INTEGER NOT NULL DEFAULT 0
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS revoked_tokens (
          jti        TEXT PRIMARY KEY,
          revoked_at INTEGER NOT NULL
        )
      `);
    });
  }

  private isRevoked(jti: string): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM revoked_tokens WHERE jti = ?", jti).toArray().length > 0;
  }

  /**
   * RPC: revoke a token id. Blocks future connects and kicks any live socket
   * bearing that jti. Called by the Worker after it has authenticated the
   * requester as this room's desktop.
   */
  async revokeToken(jti: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO revoked_tokens (jti, revoked_at) VALUES (?, ?)",
      jti,
      Math.floor(Date.now() / 1000),
    );
    for (const ws of this.ctx.getWebSockets(jti)) {
      try {
        ws.close(CLOSE_TOKEN_REVOKED, "token revoked");
      } catch {
        /* already closing */
      }
    }
  }

  /**
   * The Worker has already VERIFIED the token and rewritten the URL so that
   * `?role=` and `?jti=` here are trustworthy (DOs are only reachable via the
   * Worker).
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const params = new URL(request.url).searchParams;
    const role = params.get("role");
    const jti = params.get("jti") ?? "";
    if (role !== "desktop" && role !== "client") {
      return new Response("Bad role", { status: 400 });
    }
    if (jti && this.isRevoked(jti)) {
      return new Response("token revoked", { status: 403 });
    }

    // One desktop per room: a new desktop connection replaces any stale one
    // (handles reconnect after a network blip).
    if (role === "desktop") {
      for (const old of this.ctx.getWebSockets("desktop")) {
        try {
          old.close(CLOSE_DESKTOP_REPLACED, "replaced by a newer desktop connection");
        } catch {
          /* already closing */
        }
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation API + tags: role drives routing, jti enables targeted revoke.
    this.ctx.acceptWebSocket(server, jti ? [role, jti] : [role]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Forward opaque frames: desktop -> all clients, client -> the desktop. */
  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    const senderRole: Role = (this.ctx.getTags(ws)[0] as Role) ?? "client";
    const targetRole: Role = senderRole === "desktop" ? "client" : "desktop";
    for (const peer of this.ctx.getWebSockets(targetRole)) {
      try {
        peer.send(message);
      } catch {
        /* peer gone; cleanup in webSocketClose */
      }
    }
  }

  /** If the desktop drops, tell every client the desktop is offline. */
  webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): void {
    const role = this.ctx.getTags(ws)[0] as Role | undefined;
    if (role === "desktop") {
      for (const c of this.ctx.getWebSockets("client")) {
        try {
          c.close(CLOSE_DESKTOP_OFFLINE, "desktop offline");
        } catch {
          /* already closing */
        }
      }
    }
    try {
      ws.close(code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    /* transport error; sockets are cleaned up via webSocketClose */
  }
}

// ─── Rate limiter Durable Object (one instance per IP) ──────────────────────

export class RateLimiterDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS hits (ts INTEGER NOT NULL)`);
    });
  }

  /** Returns true if allowed (and records the hit); false if over the limit. */
  async check(limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM hits WHERE ts < ?", now - windowMs);
    const count = (this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM hits").one() as { n: number }).n;
    if (count >= limit) return false;
    this.ctx.storage.sql.exec("INSERT INTO hits (ts) VALUES (?)", now);
    return true;
  }
}

// ─── Worker entry: registration + revoke + authenticated WS routing ─────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health probe (smoke test for TASK-473).
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "agentdesk-relay" });
    }

    const secret = getSigningSecret(env);

    // --- Room registration: mint role-scoped tokens for a new pairing room. --
    if (url.pathname === "/register" && request.method === "POST") {
      if (!secret) return new Response("relay not configured", { status: 503 });
      // Rate-limit by client IP (TASK-492). cf-connecting-ip is absent in local
      // dev, so the test suites are unaffected; enforced only in production.
      const ip = request.headers.get("cf-connecting-ip");
      if (ip) {
        const allowed = await env.RATELIMIT.getByName(`reg:${ip}`).check(REGISTER_LIMIT, REGISTER_WINDOW_MS);
        if (!allowed) return new Response("rate limited", { status: 429 });
      }
      const key = await importKey(secret);
      const roomId = randomId(32);
      const iat = Math.floor(Date.now() / 1000);
      const [desktopToken, clientToken] = await Promise.all([
        signToken(key, { r: roomId, role: "desktop", jti: randomId(), iat }),
        signToken(key, { r: roomId, role: "client", jti: randomId(), iat }),
      ]);
      return Response.json({ roomId, desktopToken, clientToken });
    }

    // --- Revoke a token. Authenticated by a valid `desktop` token for the ----
    // same room. Body: { token: "<token-to-revoke>" }.
    if (url.pathname === "/revoke" && request.method === "POST") {
      if (!secret) return new Response("relay not configured", { status: 503 });
      const key = await importKey(secret);
      const authToken = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const auth = await verifyToken(key, authToken);
      if (!auth || auth.role !== "desktop") return new Response("unauthorized", { status: 401 });
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      const target = body?.token ? await verifyToken(key, body.token) : null;
      if (!target) return new Response("bad target token", { status: 400 });
      if (target.r !== auth.r) return new Response("room mismatch", { status: 403 });
      await env.RELAY.getByName(auth.r).revokeToken(target.jti);
      return Response.json({ revoked: true });
    }

    // --- Authenticated WebSocket routing. ------------------------------------
    if (request.headers.get("Upgrade") === "websocket") {
      if (!secret) return new Response("relay not configured", { status: 503 });
      const token = url.searchParams.get("token");
      if (!token) return new Response("missing token", { status: 401 });

      const key = await importKey(secret);
      const payload = await verifyToken(key, token);
      if (!payload) return new Response("invalid token", { status: 401 });

      // Rewrite the URL with the VERIFIED role + jti; route to the room's DO.
      // The signed payload wins over anything the client supplied.
      const doUrl = new URL(request.url);
      doUrl.searchParams.set("role", payload.role);
      doUrl.searchParams.set("jti", payload.jti);
      return env.RELAY.getByName(payload.r).fetch(new Request(doUrl, request));
    }

    return new Response("AgentDesk relay — https://agentdesk.pages.dev", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
