/**
 * Web-side pairing persistence (TASK-482).
 *
 * After the user scans the desktop's QR, the web app must remember the pairing
 * across reloads. CryptoKeys aren't serializable, so we persist the client's
 * private key as a JWK plus the QR payload, and re-derive the E2E session key on
 * load. The pairing secret never leaves the device (localStorage only).
 *
 * Portable Web Crypto only; `storage` is injectable for tests.
 */

import { completeClientPairing, decodePairingPayload, type PairingPayload } from "./pairing";
import { deriveSessionKey } from "./e2e";

export const PAIRING_STORAGE_KEY = "agentdesk:remote-pairing";

interface StoredPairing {
  payload: PairingPayload;
  clientPrivateJwk: JsonWebKey;
  clientPublicKeyB64: string;
}

export interface ActivePairing {
  relayWss: string;
  clientToken: string;
  pairingId: string;
  clientPublicKeyB64: string;
  sessionKey: CryptoKey;
}

/** Complete pairing from a scanned QR and persist it (survives reloads). */
export async function completeAndStorePairing(qr: string, storage: Storage = localStorage): Promise<ActivePairing> {
  const payload = decodePairingPayload(qr);
  const result = await completeClientPairing(payload);
  const clientPrivateJwk = await crypto.subtle.exportKey("jwk", result.clientKeyPair.privateKey);
  const stored: StoredPairing = { payload, clientPrivateJwk, clientPublicKeyB64: result.clientPublicKeyB64 };
  storage.setItem(PAIRING_STORAGE_KEY, JSON.stringify(stored));
  return {
    relayWss: result.relayWss,
    clientToken: result.clientToken,
    pairingId: result.pairingId,
    clientPublicKeyB64: result.clientPublicKeyB64,
    sessionKey: result.sessionKey,
  };
}

/** Restore + re-derive the session from storage (null if not paired). */
export async function loadStoredPairing(storage: Storage = localStorage): Promise<ActivePairing | null> {
  const raw = storage.getItem(PAIRING_STORAGE_KEY);
  if (!raw) return null;
  let stored: StoredPairing;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!stored.payload || !stored.clientPrivateJwk) return null;

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    stored.clientPrivateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const sessionKey = await deriveSessionKey(privateKey, stored.payload.desktopPublicKeyB64, stored.payload.pairingSecret);
  return {
    relayWss: stored.payload.relayWss,
    clientToken: stored.payload.clientToken,
    pairingId: stored.payload.pairingId,
    clientPublicKeyB64: stored.clientPublicKeyB64,
    sessionKey,
  };
}

export function isPaired(storage: Storage = localStorage): boolean {
  return !!storage.getItem(PAIRING_STORAGE_KEY);
}

export function clearStoredPairing(storage: Storage = localStorage): void {
  storage.removeItem(PAIRING_STORAGE_KEY);
}
