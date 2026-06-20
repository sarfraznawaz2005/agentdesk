/**
 * Device pairing orchestration (TASK-477 desktop / TASK-482 web).
 *
 * Ties together the relay registration, the QR payload, and the E2E key
 * exchange (src/shared/remote/e2e.ts):
 *
 *   1. Desktop calls the relay POST /register → roomId + role-scoped tokens,
 *      generates an ECDH keypair and a random pairing secret, and shows a QR
 *      carrying { relayWss, roomId, clientToken, desktopPublicKey, pairingSecret }.
 *      The desktopToken and the private key NEVER leave the desktop.
 *   2. The web client scans the QR, generates its own keypair, and derives the
 *      E2E session key from (its private key, the desktop's public key, the
 *      pairing secret). It sends its public key to the desktop (in the clear —
 *      it is public), which derives the SAME session key.
 *   3. The pairing secret travelled ONLY via the QR (out of band), so an
 *      attacker who can see relay traffic — but never the QR — cannot derive the
 *      session key even though both public keys cross the relay.
 *
 * Portable Web Crypto only → runs in Bun (desktop) and the browser (web).
 */

import { generateKeyPair, deriveSessionKey } from "./e2e";

export interface PairingPayload {
  v: 1;
  /** Relay WebSocket base URL, e.g. wss://relay.agentdesk.workers.dev */
  relayWss: string;
  roomId: string;
  /** Per-device pairing id — lets the desktop find this device's secret/session. */
  pairingId: string;
  /** Role-scoped `client` token (safe to put in the QR). */
  clientToken: string;
  /** Desktop's ECDH P-256 public key (base64url raw). */
  desktopPublicKeyB64: string;
  /** Out-of-band HKDF salt; binds the session to this QR. */
  pairingSecret: string;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomSecret(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function httpToWs(url: string): string {
  return url.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}

/** Encode the payload compactly for a QR code (base64url JSON). */
export function encodePairingPayload(p: PairingPayload): string {
  return b64url(new TextEncoder().encode(JSON.stringify(p)));
}

/** Decode + validate a scanned QR payload. */
export function decodePairingPayload(text: string): PairingPayload {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const p = JSON.parse(new TextDecoder().decode(bytes)) as PairingPayload;
  if (
    p.v !== 1 ||
    !p.relayWss ||
    !p.roomId ||
    !p.pairingId ||
    !p.clientToken ||
    !p.desktopPublicKeyB64 ||
    !p.pairingSecret
  ) {
    throw new Error("invalid pairing payload");
  }
  return p;
}

export interface DesktopPairing {
  payload: PairingPayload;
  /** base64url QR contents */
  qr: string;
  desktopKeyPair: CryptoKeyPair;
  desktopPublicKeyB64: string;
  roomId: string;
  pairingId: string;
  /** Kept PRIVATE by the desktop — never in the QR. */
  desktopToken: string;
  clientToken: string;
  pairingSecret: string;
  relayWss: string;
  /** Derive the E2E session key once the client's public key arrives. */
  deriveSession: (clientPublicKeyB64: string) => Promise<CryptoKey>;
}

/** Desktop side: register a room and prepare the pairing QR. */
export async function createDesktopPairing(relayHttpUrl: string): Promise<DesktopPairing> {
  const base = relayHttpUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/register`, { method: "POST" });
  if (!res.ok) throw new Error(`relay /register failed: ${res.status}`);
  const reg = (await res.json()) as { roomId: string; desktopToken: string; clientToken: string };

  const kp = await generateKeyPair();
  const pairingSecret = randomSecret();
  const pairingId = randomSecret(12);
  const relayWss = httpToWs(base);
  const payload: PairingPayload = {
    v: 1,
    relayWss,
    roomId: reg.roomId,
    pairingId,
    clientToken: reg.clientToken,
    desktopPublicKeyB64: kp.publicKeyB64,
    pairingSecret,
  };

  return {
    payload,
    qr: encodePairingPayload(payload),
    desktopKeyPair: kp.keyPair,
    desktopPublicKeyB64: kp.publicKeyB64,
    roomId: reg.roomId,
    pairingId,
    desktopToken: reg.desktopToken,
    clientToken: reg.clientToken,
    pairingSecret,
    relayWss,
    deriveSession: (clientPublicKeyB64: string) =>
      deriveSessionKey(kp.keyPair.privateKey, clientPublicKeyB64, pairingSecret),
  };
}

export interface ClientPairing {
  clientKeyPair: CryptoKeyPair;
  clientPublicKeyB64: string;
  relayWss: string;
  clientToken: string;
  roomId: string;
  pairingId: string;
  /** The derived E2E session key (identical to the desktop's). */
  sessionKey: CryptoKey;
}

/** Web side: complete pairing from a scanned QR (or decoded payload). */
export async function completeClientPairing(qrOrPayload: string | PairingPayload): Promise<ClientPairing> {
  const p = typeof qrOrPayload === "string" ? decodePairingPayload(qrOrPayload) : qrOrPayload;
  const kp = await generateKeyPair();
  const sessionKey = await deriveSessionKey(kp.keyPair.privateKey, p.desktopPublicKeyB64, p.pairingSecret);
  return {
    clientKeyPair: kp.keyPair,
    clientPublicKeyB64: kp.publicKeyB64,
    relayWss: p.relayWss,
    clientToken: p.clientToken,
    roomId: p.roomId,
    pairingId: p.pairingId,
    sessionKey,
  };
}
