/**
 * CAPSTONE end-to-end test (TASK-477) against a local `wrangler dev` relay.
 * Proves the whole stack together: relay register → QR pairing → ECDH session →
 * E2E-encrypted frames forwarded opaquely by the relay → round-trip both ways,
 * and that a wrong pairing secret cannot decrypt.
 *
 *   (cd relay && npm run dev)   # in another shell
 *   bun src/shared/remote/pairing.itest.ts
 */

import { createDesktopPairing, completeClientPairing, decodePairingPayload } from "./pairing";
import { encryptJson, decryptJson, encryptFrame } from "./e2e";

const HTTP = "http://127.0.0.1:8787";
const WS = "ws://127.0.0.1:8787";

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

function openWs(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/?token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";
    const t = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    });
  });
}

function nextBinary(ws: WebSocket, ms = 3000): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    ws.addEventListener(
      "message",
      (ev: MessageEvent) => {
        clearTimeout(timer);
        resolve(ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : null);
      },
      { once: true },
    );
  });
}

const main = async () => {
  // 1. Desktop registers a room + builds the pairing QR.
  const desktop = await createDesktopPairing(HTTP);
  check("desktop pairing has a QR + tokens", !!desktop.qr && !!desktop.desktopToken && !!desktop.clientToken);
  check("QR decodes back to the same room", decodePairingPayload(desktop.qr).roomId === desktop.roomId);

  // 2. Client completes pairing from the QR (out-of-band secret).
  const client = await completeClientPairing(desktop.qr);

  // 3. Desktop derives the session from the client's public key.
  const desktopSession = await desktop.deriveSession(client.clientPublicKeyB64);

  // 4. Connect both to the relay (desktop role + client role).
  const desktopWs = await openWs(desktop.desktopToken);
  const clientWs = await openWs(client.clientToken);

  // 5. Client → desktop: E2E-encrypted RPC frame, forwarded opaquely.
  const reqRecv = nextBinary(desktopWs);
  const request = { rpc: "getProjects", id: "1", params: {} };
  clientWs.send(await encryptJson(client.sessionKey, request));
  const reqBytes = await reqRecv;
  const decodedReq = reqBytes ? await decryptJson<typeof request>(desktopSession, reqBytes) : null;
  check("client→desktop E2E RPC round-trips through the relay", JSON.stringify(decodedReq) === JSON.stringify(request));

  // 6. Desktop → client: E2E-encrypted response.
  const resRecv = nextBinary(clientWs);
  const response = { id: "1", result: [{ id: "p1", name: "Demo" }] };
  desktopWs.send(await encryptJson(desktopSession, response));
  const resBytes = await resRecv;
  const decodedRes = resBytes ? await decryptJson<typeof response>(client.sessionKey, resBytes) : null;
  check("desktop→client E2E response round-trips through the relay", JSON.stringify(decodedRes) === JSON.stringify(response));

  // 7. Relay never sees plaintext — the on-wire bytes are not the JSON.
  const sealed = await encryptFrame(client.sessionKey, new TextEncoder().encode(JSON.stringify(request)));
  const plain = new TextEncoder().encode(JSON.stringify(request));
  check("on-wire frame is ciphertext, not plaintext", sealed.length !== plain.length || !sealed.every((b, i) => b === plain[i]));

  // 8. Wrong pairing secret → different key → cannot decrypt the desktop's frame.
  const tampered = { ...desktop.payload, pairingSecret: "WRONG-secret-not-from-the-qr" };
  const evilClient = await completeClientPairing(tampered);
  let evilFailed = false;
  try {
    await decryptJson(evilClient.sessionKey, resBytes ?? new Uint8Array());
  } catch {
    evilFailed = true;
  }
  check("a client with the wrong pairing secret cannot decrypt", evilFailed);

  try {
    desktopWs.close();
    clientWs.close();
  } catch {
    /* ignore */
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) console.log("FAILURES:", failures.join(", "));
  process.exit(failures.length ? 1 : 0);
};

main().catch((e) => {
  console.error("pairing capstone error:", e);
  process.exit(1);
});
