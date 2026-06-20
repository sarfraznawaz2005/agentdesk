/**
 * Remote-access manager (TASK-477).
 *
 * Owns the desktop's relay pairing identity + the live relay session, and backs
 * the remote-access RPCs (create pairing / list / rename / revoke / enable).
 *
 *   • Identity (relay room, desktop token, ECDH keypair) is created once via the
 *     relay POST /register and persisted ENCRYPTED in `remote_identity`.
 *   • Each paired device is a row in `remote_devices` with its pairing secret
 *     encrypted at rest; revoke = set `revoked = 1` (desktop-enforced — the relay
 *     session stops admitting that pairingId).
 *   • When enabled, a RelaySession serves RPC over the relay to paired clients,
 *     end-to-end encrypted, dispatching into the real `requestHandlers`.
 *
 * App-wired (verified on app run): depends on the DB + engine-manager broadcast
 * hook, so it runs under the Electrobun host, not headless.
 */

import { sqlite } from "../db/connection";
import { encryptSecret, decryptSecret } from "../lib/secret-crypto";
import { generateKeyPair } from "../../shared/remote/e2e";
import { encodePairingPayload, type PairingPayload } from "../../shared/remote/pairing";
import { startRelaySession, type RelaySession } from "./relay-session";
import { addBroadcastTarget } from "./broadcast-bus";
import { ensureRemoteBroadcastHook } from "./broadcast-hook";
import { RELAY_HTTP, RELAY_WSS, WEB_URL, RELAY_CONFIGURED } from "./config";
import type { RemoteDeviceDto, RemoteAccessStatusDto, DevicePairingDto } from "../../shared/rpc/remote-access";

/* eslint-disable @typescript-eslint/no-explicit-any */
type RpcRequestHandlers = Record<string, (params: any) => unknown | Promise<unknown>>;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface Identity {
  roomId: string;
  desktopToken: string;
  clientToken: string;
  privateKey: CryptoKey;
  publicKeyB64: string;
}

let injectedHandlers: RpcRequestHandlers | null = null;
let cachedIdentity: Identity | null = null;
let session: RelaySession | null = null;
let removeBroadcastTarget: (() => void) | null = null;

function randomToken(bytes = 32): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- identity persistence ----------------------------------------------------

async function exportIdentitySecret(keyPair: CryptoKeyPair, publicKeyB64: string): Promise<string> {
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return JSON.stringify({ privateJwk, publicKeyB64 });
}

async function importIdentitySecret(json: string): Promise<{ privateKey: CryptoKey; publicKeyB64: string }> {
  const { privateJwk, publicKeyB64 } = JSON.parse(json) as { privateJwk: JsonWebKey; publicKeyB64: string };
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  return { privateKey, publicKeyB64 };
}

async function ensureIdentity(): Promise<Identity> {
  if (cachedIdentity) return cachedIdentity;

  const row = sqlite.prepare("SELECT * FROM remote_identity WHERE id = 1").get() as
    | { room_id: string; desktop_token_enc: string; client_token: string; keypair_enc: string }
    | undefined;

  if (row && row.room_id) {
    const { privateKey, publicKeyB64 } = await importIdentitySecret(decryptSecret(row.keypair_enc));
    cachedIdentity = {
      roomId: row.room_id,
      desktopToken: decryptSecret(row.desktop_token_enc),
      clientToken: row.client_token,
      privateKey,
      publicKeyB64,
    };
    return cachedIdentity;
  }

  // First-time: register a relay room + generate our keypair.
  const res = await fetch(`${RELAY_HTTP.replace(/\/$/, "")}/register`, { method: "POST" });
  if (!res.ok) throw new Error(`relay /register failed: ${res.status}`);
  const reg = (await res.json()) as { roomId: string; desktopToken: string; clientToken: string };
  const kp = await generateKeyPair();
  const keypairEnc = encryptSecret(await exportIdentitySecret(kp.keyPair, kp.publicKeyB64));

  sqlite
    .prepare(
      `INSERT INTO remote_identity (id, enabled, room_id, desktop_token_enc, client_token, keypair_enc)
       VALUES (1, COALESCE((SELECT enabled FROM remote_identity WHERE id = 1), 0), ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, desktop_token_enc = excluded.desktop_token_enc,
         client_token = excluded.client_token, keypair_enc = excluded.keypair_enc`,
    )
    .run(reg.roomId, encryptSecret(reg.desktopToken), reg.clientToken, keypairEnc);

  cachedIdentity = {
    roomId: reg.roomId,
    desktopToken: reg.desktopToken,
    clientToken: reg.clientToken,
    privateKey: kp.keyPair.privateKey,
    publicKeyB64: kp.publicKeyB64,
  };
  return cachedIdentity;
}

function isEnabled(): boolean {
  const row = sqlite.prepare("SELECT enabled FROM remote_identity WHERE id = 1").get() as
    | { enabled: number }
    | undefined;
  return !!row && row.enabled === 1;
}

function setEnabledFlag(enabled: boolean): void {
  sqlite
    .prepare(
      `INSERT INTO remote_identity (id, enabled) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
    )
    .run(enabled ? 1 : 0);
}

// --- per-device secret resolution (used by the relay session) ----------------

/**
 * Security: a freshly-created pairing QR must be claimed within this window
 * (TASK-492). It bounds how long an intercepted or stale code is useful — after
 * it elapses the QR is dead and the user must generate a new one. Generous
 * enough to never surprise a user scanning the code they just generated.
 */
const PAIRING_CLAIM_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Security: a claimed device that hasn't connected in this long is treated as
 * EXPIRED → its secret no longer resolves → the user must re-pair (TASK-492,
 * "expired session forces re-auth"). UX-safe: every successful connect refreshes
 * `last_seen_at`, so an actively-used device never expires.
 */
const DEVICE_INACTIVITY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Parse a SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) to epoch ms. */
function parseSqliteTs(ts: string | null): number {
  if (!ts) return 0;
  const t = Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  return Number.isNaN(t) ? 0 : t;
}

function resolvePairingSecret(pairingId: string, clientPublicKeyB64: string): string | null {
  const row = sqlite
    .prepare("SELECT pairing_secret_enc, public_key, revoked, created_at, last_seen_at FROM remote_devices WHERE id = ?")
    .get(pairingId) as
    | { pairing_secret_enc: string; public_key: string; revoked: number; created_at: string; last_seen_at: string | null }
    | undefined;
  if (!row || row.revoked === 1) return null;

  const now = Date.now();

  // Single-use per device (TASK-477): the FIRST client to pair binds its public
  // key to the row; a different key afterward is rejected, so a leaked/reused
  // code cannot pair a second device. The same device reconnecting is allowed.
  if (!row.public_key) {
    // Unclaimed: enforce the short claim window (TASK-492) so a stale/intercepted
    // code can't be redeemed long after it was shown.
    if (now - parseSqliteTs(row.created_at) > PAIRING_CLAIM_WINDOW_MS) return null;
    sqlite
      .prepare("UPDATE remote_devices SET public_key = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(clientPublicKeyB64, pairingId);
  } else if (row.public_key !== clientPublicKeyB64) {
    return null; // code already claimed by another device
  } else {
    // Claimed device: enforce inactivity expiry (TASK-492). Fall back to
    // created_at if last_seen_at is somehow null.
    const lastSeen = parseSqliteTs(row.last_seen_at) || parseSqliteTs(row.created_at);
    if (lastSeen && now - lastSeen > DEVICE_INACTIVITY_MS) return null;
    sqlite.prepare("UPDATE remote_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(pairingId);
  }
  return decryptSecret(row.pairing_secret_enc);
}

// --- session lifecycle -------------------------------------------------------

async function startSession(): Promise<void> {
  if (session) return;
  if (!injectedHandlers) {
    console.warn("[remote] request handlers not injected yet — cannot start session");
    return;
  }
  const id = await ensureIdentity();
  session = startRelaySession({
    relayWss: RELAY_WSS,
    desktopToken: id.desktopToken,
    desktopPrivateKey: id.privateKey,
    resolvePairingSecret,
    requestHandlers: injectedHandlers,
  });
  ensureRemoteBroadcastHook();
  removeBroadcastTarget = addBroadcastTarget((method, payload) => session?.broadcast(method, payload));
}

function stopSession(): void {
  removeBroadcastTarget?.();
  removeBroadcastTarget = null;
  session?.close();
  session = null;
}

// --- public API (startup + RPC handlers) -------------------------------------

/** Called once at app startup with the real handler map; starts if enabled. */
export function initRemoteAccess(handlers: RpcRequestHandlers): void {
  injectedHandlers = handlers;
  if (isEnabled()) {
    void startSession().catch((err) => console.error("[remote] start failed:", err));
  }
}

export function shutdownRemoteAccess(): void {
  stopSession();
}

export function getRemoteAccessStatus(): RemoteAccessStatusDto {
  const count = sqlite.prepare("SELECT COUNT(*) AS n FROM remote_devices WHERE revoked = 0").get() as { n: number };
  return {
    enabled: isEnabled(),
    connected: session?.status() === "online",
    relayConfigured: RELAY_CONFIGURED,
    deviceCount: count?.n ?? 0,
  };
}

export async function setRemoteAccessEnabled(enabled: boolean): Promise<RemoteAccessStatusDto> {
  setEnabledFlag(enabled);
  if (enabled) await startSession();
  else stopSession();
  return getRemoteAccessStatus();
}

export async function createDevicePairing(name?: string): Promise<DevicePairingDto> {
  const id = await ensureIdentity();
  const pairingId = randomToken(12);
  const pairingSecret = randomToken(32);

  sqlite
    .prepare(
      "INSERT INTO remote_devices (id, name, pairing_secret_enc, client_token) VALUES (?, ?, ?, ?)",
    )
    .run(pairingId, name?.trim() || "New device", encryptSecret(pairingSecret), id.clientToken);

  // Ensure the session is live so the device can connect after scanning.
  if (isEnabled() && !session) await startSession();

  const payload: PairingPayload = {
    v: 1,
    relayWss: RELAY_WSS,
    roomId: id.roomId,
    pairingId,
    clientToken: id.clientToken,
    desktopPublicKeyB64: id.publicKeyB64,
    pairingSecret,
  };
  return { qr: encodePairingPayload(payload), pairingId, webUrl: WEB_URL };
}

export function listPairedDevices(): RemoteDeviceDto[] {
  const rows = sqlite
    .prepare("SELECT id, name, revoked, created_at, last_seen_at FROM remote_devices ORDER BY created_at DESC")
    .all() as Array<{ id: string; name: string; revoked: number; created_at: string; last_seen_at: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    revoked: r.revoked === 1,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  }));
}

export function renameDevice(id: string, name: string): { ok: boolean } {
  sqlite.prepare("UPDATE remote_devices SET name = ? WHERE id = ?").run(name.trim() || "Device", id);
  return { ok: true };
}

export function revokeDevice(id: string): { ok: boolean } {
  sqlite.prepare("UPDATE remote_devices SET revoked = 1 WHERE id = ?").run(id);
  return { ok: true };
}

/**
 * Permanently remove a device from the list. Revoke first (so a still-connected
 * client is cut off — its secret stops resolving and a deleted row means future
 * hellos are rejected), then delete the row so it no longer clutters the UI.
 */
export function deleteDevice(id: string): { ok: boolean } {
  sqlite.prepare("UPDATE remote_devices SET revoked = 1 WHERE id = ?").run(id);
  sqlite.prepare("DELETE FROM remote_devices WHERE id = ?").run(id);
  return { ok: true };
}
