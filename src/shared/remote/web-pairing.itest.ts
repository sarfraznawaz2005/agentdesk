/**
 * Headless test for web pairing persistence (TASK-482). No relay needed.
 *   bun src/shared/remote/web-pairing.itest.ts
 */

import { completeAndStorePairing, loadStoredPairing, clearStoredPairing, isPaired } from "./web-pairing";
import { encodePairingPayload, type PairingPayload } from "./pairing";
import { generateKeyPair, deriveSessionKey, encryptJson, decryptJson } from "./e2e";

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

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => {
      m.delete(k);
    },
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  } as Storage;
}

const main = async () => {
  // A desktop keypair + a manually-built QR (no relay needed for this test).
  const desktopKp = await generateKeyPair();
  const payload: PairingPayload = {
    v: 1,
    relayWss: "wss://relay.example",
    roomId: "room-1",
    pairingId: "pid-1",
    clientToken: "client-token-1",
    desktopPublicKeyB64: desktopKp.publicKeyB64,
    pairingSecret: "secret-from-the-qr",
  };
  const qr = encodePairingPayload(payload);
  const storage = memStorage();

  check("not paired initially", !isPaired(storage));

  const active1 = await completeAndStorePairing(qr, storage);
  check("paired after completeAndStorePairing", isPaired(storage));

  // The desktop derives its session from the client's public key.
  const desktopSession = await deriveSessionKey(desktopKp.keyPair.privateKey, active1.clientPublicKeyB64, payload.pairingSecret);

  const sealed = await encryptJson(active1.sessionKey, { hello: "world" });
  const opened = await decryptJson(desktopSession, sealed);
  check("initial session E2E works with the desktop", JSON.stringify(opened) === JSON.stringify({ hello: "world" }));

  // Reload: restore from storage must re-derive the SAME working key.
  const active2 = await loadStoredPairing(storage);
  check("restore returns a pairing", !!active2);
  if (!active2) throw new Error("expected a restored pairing");
  const sealed2 = await encryptJson(active2.sessionKey, { restored: true });
  const opened2 = await decryptJson(desktopSession, sealed2);
  check("restored session re-derives the same working key", JSON.stringify(opened2) === JSON.stringify({ restored: true }));
  check(
    "restored metadata matches",
    active2.pairingId === "pid-1" && active2.clientToken === "client-token-1" && active2.relayWss === "wss://relay.example",
  );

  clearStoredPairing(storage);
  check("cleared → not paired", !isPaired(storage));
  check("load after clear returns null", (await loadStoredPairing(storage)) === null);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) console.log("FAILURES:", failures.join(", "));
  process.exit(failures.length ? 1 : 0);
};

main().catch((e) => {
  console.error("web-pairing test error:", e);
  process.exit(1);
});
