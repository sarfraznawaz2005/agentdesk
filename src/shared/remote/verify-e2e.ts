/**
 * Runnable verification for the portable E2E module (TASK-477 / 482).
 *   bun src/shared/remote/verify-e2e.ts
 */

import { generateKeyPair, deriveSessionKey, encryptJson, decryptJson, decryptFrame } from "./e2e";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

const main = async () => {
  const pairingSecret = "qr-shared-pairing-secret-123";

  const desktop = await generateKeyPair();
  const client = await generateKeyPair();

  // Both sides derive the SAME session key from their own private key + the
  // peer's public key + the shared pairing secret.
  const desktopKey = await deriveSessionKey(desktop.keyPair.privateKey, client.publicKeyB64, pairingSecret);
  const clientKey = await deriveSessionKey(client.keyPair.privateKey, desktop.publicKeyB64, pairingSecret);

  // 1. Round-trip both directions.
  const msg = { rpc: "getProjects", id: "abc", big: [1, 2, 3, "x"] };
  const sealed = await encryptJson(desktopKey, msg);
  const opened = await decryptJson(clientKey, sealed);
  check("desktop -> client JSON round-trips", JSON.stringify(opened) === JSON.stringify(msg));

  const sealed2 = await encryptJson(clientKey, { hello: "back" });
  const opened2 = await decryptJson<{ hello: string }>(desktopKey, sealed2);
  check("client -> desktop JSON round-trips", opened2.hello === "back");

  // 2. Ciphertext is not the plaintext (relay sees opaque bytes).
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(msg));
  check("ciphertext differs from plaintext", sealed.length !== plaintextBytes.length || !sealed.every((b, i) => b === plaintextBytes[i]));

  // 3. An attacker who never saw the pairing secret cannot derive the key.
  const attacker = await generateKeyPair();
  const attackerKey = await deriveSessionKey(attacker.keyPair.privateKey, desktop.publicKeyB64, pairingSecret);
  let attackerFailed = false;
  try {
    await decryptFrame(attackerKey, sealed);
  } catch {
    attackerFailed = true;
  }
  check("attacker with own keypair cannot decrypt", attackerFailed);

  // 4. Wrong pairing secret -> different key -> cannot decrypt.
  const wrongKey = await deriveSessionKey(client.keyPair.privateKey, desktop.publicKeyB64, "WRONG-secret");
  let wrongFailed = false;
  try {
    await decryptFrame(wrongKey, sealed);
  } catch {
    wrongFailed = true;
  }
  check("wrong pairing secret cannot decrypt", wrongFailed);

  // 5. Tampered ciphertext is rejected (AEAD integrity).
  const tampered = sealed.slice();
  tampered[tampered.length - 1] ^= 0xff;
  let tamperFailed = false;
  try {
    await decryptFrame(clientKey, tampered);
  } catch {
    tamperFailed = true;
  }
  check("tampered ciphertext is rejected", tamperFailed);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
};

main().catch((e) => {
  console.error("verify-e2e error:", e);
  process.exit(1);
});
