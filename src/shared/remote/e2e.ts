/**
 * Portable end-to-end encryption for the remote channel.
 *
 * The relay forwards only ciphertext (see relay/src/index.ts) — confidentiality
 * and integrity live HERE, between the desktop (TASK-477) and the web client
 * (TASK-482). This module uses ONLY Web Crypto (`crypto.subtle`), so the exact
 * same code runs in Bun (desktop) and the browser (web app).
 *
 * Scheme: ECDH P-256 (universally supported) → HKDF-SHA256 → AES-256-GCM.
 *
 * Pairing binds the session to two independent secrets:
 *   • the ECDH shared secret (from each side's keypair), and
 *   • the out-of-band pairing secret (shared via the QR), used as the HKDF salt.
 * So an attacker with only relay access — who never saw the QR — cannot derive
 * the session key even if they obtain both public keys.
 */

const HKDF_INFO = "agentdesk-e2e-v1";
const IV_BYTES = 12;

const enc = new TextEncoder();

function toB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface E2EKeyPair {
  keyPair: CryptoKey | CryptoKeyPair;
  /** raw P-256 public key, base64url — put this in the QR / send to the peer */
  publicKeyB64: string;
}

/** Generate an ephemeral ECDH P-256 keypair and export the public key. */
export async function generateKeyPair(): Promise<{ keyPair: CryptoKeyPair; publicKeyB64: string }> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return { keyPair, publicKeyB64: toB64Url(raw) };
}

/**
 * Derive the shared AES-256-GCM session key from our private key, the peer's
 * public key, and the out-of-band pairing secret (HKDF salt). Both sides
 * compute the identical key.
 */
export async function deriveSessionKey(
  privateKey: CryptoKey,
  peerPublicKeyB64: string,
  pairingSecret: string,
): Promise<CryptoKey> {
  const peerPublic = await crypto.subtle.importKey(
    "raw",
    fromB64Url(peerPublicKeyB64) as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPublic }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(pairingSecret), info: enc.encode(HKDF_INFO) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a frame. Output = iv(12) || ciphertext+tag. */
export async function encryptFrame(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext as BufferSource));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

/** Decrypt a frame produced by {@link encryptFrame}. Throws on tamper/wrong key. */
export async function decryptFrame(key: CryptoKey, packet: Uint8Array): Promise<Uint8Array> {
  const iv = packet.slice(0, IV_BYTES);
  const ct = packet.slice(IV_BYTES);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource),
  );
}

/** Convenience helpers for JSON payloads. */
export async function encryptJson(key: CryptoKey, value: unknown): Promise<Uint8Array> {
  return encryptFrame(key, enc.encode(JSON.stringify(value)));
}
export async function decryptJson<T = unknown>(key: CryptoKey, packet: Uint8Array): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await decryptFrame(key, packet))) as T;
}

export const __testing = { toB64Url, fromB64Url };
