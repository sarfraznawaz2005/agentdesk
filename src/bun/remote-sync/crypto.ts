// ---------------------------------------------------------------------------
// Remote Sync — credential encryption at rest
// ---------------------------------------------------------------------------
// Secrets (SFTP/FTP passwords, private keys, passphrases) are encrypted with
// AES-256-GCM before being written to the SQLite DB. The 32-byte master key is
// generated once and stored in a file under userData — SEPARATE from the DB —
// so a leak of agentdesk.db alone does not expose credentials.
//
// Note: this is not OS-keychain-backed (no native keychain binding is available
// on the Bun runtime). It raises the bar meaningfully over plaintext-in-DB; for
// stronger guarantees a future enhancement could integrate an OS secret store.
// ---------------------------------------------------------------------------

import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { Utils } from "electrobun/bun";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";

const KEY_FILE = join(Utils.paths.userData, "remote-sync.key");
const PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
	if (cachedKey) return cachedKey;

	if (existsSync(KEY_FILE)) {
		try {
			const hex = readFileSync(KEY_FILE, "utf8").trim();
			const buf = Buffer.from(hex, "hex");
			if (buf.length === 32) {
				cachedKey = buf;
				return buf;
			}
		} catch {
			/* fall through to regenerate */
		}
	}

	const key = randomBytes(32);
	if (!existsSync(Utils.paths.userData)) mkdirSync(Utils.paths.userData, { recursive: true });
	writeFileSync(KEY_FILE, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(KEY_FILE, 0o600);
	} catch {
		/* perms are advisory on Windows; the file already lives in the per-user profile */
	}
	cachedKey = key;
	return key;
}

/** True if a stored value is one of our AES-GCM blobs. */
export function isEncrypted(value: string | null | undefined): boolean {
	return !!value && value.startsWith(PREFIX);
}

/** Encrypt a UTF-8 secret. Returns "" for empty input (nothing to protect). */
export function encryptSecret(plain: string): string {
	if (!plain) return "";
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
	const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	// Layout: [12-byte IV][16-byte tag][ciphertext]
	return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/**
 * Decrypt a value produced by encryptSecret(). Values that are not in our
 * encrypted format are returned unchanged (tolerates manual/legacy plaintext).
 * Throws only if a value LOOKS encrypted but fails authentication.
 */
export function decryptSecret(stored: string | null | undefined): string {
	if (!stored) return "";
	if (!stored.startsWith(PREFIX)) return stored;
	const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
	const iv = raw.subarray(0, 12);
	const tag = raw.subarray(12, 28);
	const ciphertext = raw.subarray(28);
	const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
