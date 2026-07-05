/**
 * secret-crypto.test.ts
 *
 * src/bun/lib/secret-crypto.ts is the ONE encryption-at-rest implementation
 * shared by every credential AgentDesk stores in SQLite: Remote Sync
 * passwords, per-project GitHub tokens, issue-tracker API keys. If this
 * silently produced garbage, or accepted a tampered ciphertext, every one of
 * those secrets would be corrupted or spoofable — yet it had zero test
 * coverage anywhere in the suite. Pure AES-256-GCM logic, no DB involved, so
 * it's cheap to pin down exhaustively.
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";

const testUserData = mkdtempSync(join(tmpdir(), "agentdesk-secret-crypto-"));

mock.module("electrobun/bun", () => ({
	Utils: { paths: { userData: testUserData } },
}));

const { encryptSecret, decryptSecret, isEncrypted } = await import("../../src/bun/lib/secret-crypto");

afterAll(() => {
	rmSync(testUserData, { recursive: true, force: true });
});

describe("encryptSecret / decryptSecret", () => {
	it("round-trips a plaintext secret", () => {
		const cipher = encryptSecret("super-secret-token");
		expect(cipher).not.toBe("super-secret-token");
		expect(decryptSecret(cipher)).toBe("super-secret-token");
	});

	it("round-trips unicode and special characters", () => {
		const plain = "pässwörd 🔒 with \"quotes\" and \n newlines";
		const cipher = encryptSecret(plain);
		expect(decryptSecret(cipher)).toBe(plain);
	});

	it("produces a different ciphertext for the same plaintext each time (random IV)", () => {
		const a = encryptSecret("same-value");
		const b = encryptSecret("same-value");
		expect(a).not.toBe(b);
		expect(decryptSecret(a)).toBe("same-value");
		expect(decryptSecret(b)).toBe("same-value");
	});

	it("prefixes ciphertext with the version tag", () => {
		const cipher = encryptSecret("x");
		expect(cipher.startsWith("enc:v1:")).toBe(true);
	});

	it("returns empty string for empty input instead of encrypting nothing", () => {
		expect(encryptSecret("")).toBe("");
	});

	it("decryptSecret on empty/null/undefined returns empty string", () => {
		expect(decryptSecret("")).toBe("");
		expect(decryptSecret(null)).toBe("");
		expect(decryptSecret(undefined)).toBe("");
	});

	it("passes through legacy plaintext (no prefix) unchanged — back-compat for pre-encryption data", () => {
		expect(decryptSecret("plain-old-token")).toBe("plain-old-token");
	});

	it("throws on a tampered ciphertext (auth tag mismatch)", () => {
		const cipher = encryptSecret("do-not-tamper");
		// Flip a byte in the base64 payload without corrupting the prefix.
		const payload = cipher.slice("enc:v1:".length);
		const buf = Buffer.from(payload, "base64");
		buf[buf.length - 1] ^= 0xff; // corrupt the last ciphertext byte
		const tampered = "enc:v1:" + buf.toString("base64");
		expect(() => decryptSecret(tampered)).toThrow();
	});

	it("throws when the auth tag itself is corrupted", () => {
		const cipher = encryptSecret("another-secret");
		const payload = cipher.slice("enc:v1:".length);
		const buf = Buffer.from(payload, "base64");
		buf[15] ^= 0xff; // byte 15 is inside the 16-byte tag (offset 12..28)
		const tampered = "enc:v1:" + buf.toString("base64");
		expect(() => decryptSecret(tampered)).toThrow();
	});
});

describe("isEncrypted", () => {
	it("is true for a value produced by encryptSecret", () => {
		expect(isEncrypted(encryptSecret("hi"))).toBe(true);
	});

	it("is false for legacy plaintext, empty, null, and undefined", () => {
		expect(isEncrypted("plain-token")).toBe(false);
		expect(isEncrypted("")).toBe(false);
		expect(isEncrypted(null)).toBe(false);
		expect(isEncrypted(undefined)).toBe(false);
	});
});

describe("key persistence", () => {
	it("persists a 32-byte key to a 0600 file under userData, separate from the DB", () => {
		encryptSecret("trigger-key-creation"); // lazily creates the key file on first use
		const keyPath = join(testUserData, "remote-sync.key");
		expect(existsSync(keyPath)).toBe(true);
		const hex = readFileSync(keyPath, "utf8").trim();
		expect(Buffer.from(hex, "hex").length).toBe(32);
	});
});
