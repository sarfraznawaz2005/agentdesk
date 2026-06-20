/**
 * End-to-end test for the desktop relay session manager (TASK-477) against a
 * local `wrangler dev` relay. An inline "web client" performs the real
 * handshake → E2E RPC → broadcast protocol over the relay.
 *
 *   (cd relay && npm run dev)   # in another shell
 *   bun src/bun/remote/relay-session.itest.ts
 */

import { startRelaySession } from "./relay-session";
import { createDesktopPairing, completeClientPairing } from "../../shared/remote/pairing";
import { encryptFrame, decryptFrame } from "../../shared/remote/e2e";

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

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string) => {
  const bin = atob(s);
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
function frameReader(ws: WebSocket) {
  const queue: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void; timer: any }> = [];
  ws.addEventListener("message", (ev: MessageEvent) => {
    let f: any;
    try {
      f = JSON.parse(typeof ev.data === "string" ? ev.data : td.decode(ev.data));
    } catch {
      return;
    }
    const i = waiters.findIndex((w) => w.pred(f));
    if (i >= 0) {
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(f);
    } else {
      queue.push(f);
    }
  });
  return {
    next(pred: (f: any) => boolean, ms = 3000): Promise<any | null> {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const j = waiters.findIndex((w) => w.timer === timer);
          if (j >= 0) waiters.splice(j, 1);
          resolve(null);
        }, ms);
        waiters.push({ pred, resolve, timer });
      });
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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

const main = async () => {
  const desktop = await createDesktopPairing(HTTP);

  // Desktop session manager: resolve only OUR pairingId; mock handlers.
  const session = startRelaySession({
    relayWss: WS,
    desktopToken: desktop.desktopToken,
    desktopPrivateKey: desktop.desktopKeyPair.privateKey,
    // Stateful claim, mirroring the manager: first device's key wins (one-time).
    resolvePairingSecret: (() => {
      let claimedPub: string | null = null;
      return (id: string, pub: string): string | null => {
        if (id !== desktop.pairingId) return null;
        if (!claimedPub) {
          claimedPub = pub;
          return desktop.pairingSecret;
        }
        return claimedPub === pub ? desktop.pairingSecret : null;
      };
    })(),
    requestHandlers: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      echo: (p: any) => p,
      add: (p: { a: number; b: number }) => p.a + p.b,
    },
  });
  await new Promise((r) => setTimeout(r, 400)); // let the desktop connect

  // Inline web client.
  const client = await completeClientPairing(desktop.qr);
  const ws = await openWs(client.clientToken);
  const reader = frameReader(ws);
  const cid = "c1";

  // 1. Handshake.
  ws.send(JSON.stringify({ k: "hello", cid, pairingId: client.pairingId, pub: client.clientPublicKeyB64 }));
  const ack = await reader.next((f) => f.k === "ack" && f.cid === cid);
  check("handshake is acknowledged", !!ack);
  check("desktop has one session", session.sessionCount() === 1);

  // 2. E2E RPC over the relay.
  const reqCt = await encryptFrame(client.sessionKey, te.encode(JSON.stringify({ id: "1", method: "add", params: { a: 2, b: 3 } })));
  ws.send(JSON.stringify({ k: "rpc", cid, d: b64(reqCt) }));
  const res = await reader.next((f) => f.k === "res" && f.cid === cid);
  const resObj = res ? JSON.parse(td.decode(await decryptFrame(client.sessionKey, unb64(res.d)))) : null;
  check("E2E RPC returns the correct result", resObj?.id === "1" && resObj?.result === 5);

  // 3. Unknown method → error.
  const badCt = await encryptFrame(client.sessionKey, te.encode(JSON.stringify({ id: "2", method: "nope", params: {} })));
  ws.send(JSON.stringify({ k: "rpc", cid, d: b64(badCt) }));
  const res2 = await reader.next((f) => f.k === "res" && f.cid === cid);
  const res2Obj = res2 ? JSON.parse(td.decode(await decryptFrame(client.sessionKey, unb64(res2.d)))) : null;
  check("unknown method returns an error", /unknown method/.test(res2Obj?.error ?? ""));

  // 4. Broadcast (E2E, cid-addressed).
  session.broadcast("streamToken", { conversationId: "x", token: "hi" });
  const bc = await reader.next((f) => f.k === "bc" && f.cid === cid);
  const bcObj = bc ? JSON.parse(td.decode(await decryptFrame(client.sessionKey, unb64(bc.d)))) : null;
  check("broadcast is delivered E2E to the client", bcObj?.method === "streamToken" && bcObj?.payload?.token === "hi");

  // 5. Revoked/unknown device: hello with a bad pairingId gets no ack.
  const ws2 = await openWs(client.clientToken);
  const reader2 = frameReader(ws2);
  ws2.send(JSON.stringify({ k: "hello", cid: "c2", pairingId: "bogus-pairing-id", pub: client.clientPublicKeyB64 }));
  const ack2 = await reader2.next((f) => f.k === "ack" && f.cid === "c2", 1200);
  check("unknown pairingId is not acknowledged", ack2 === null);

  // 6. One-time pairing: a SECOND device (new keypair) using the SAME code is
  //    rejected — the code is single-use per device.
  const client2 = await completeClientPairing(desktop.qr);
  const ws4 = await openWs(client2.clientToken);
  const reader4 = frameReader(ws4);
  ws4.send(JSON.stringify({ k: "hello", cid: "c4", pairingId: client2.pairingId, pub: client2.clientPublicKeyB64 }));
  const ack4 = await reader4.next((f) => f.k === "ack" && f.cid === "c4", 1200);
  check("a second device with the same code is rejected (one-time)", ack4 === null);

  try {
    ws.close();
    ws2.close();
    ws4.close();
    session.close();
  } catch {
    /* ignore */
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) console.log("FAILURES:", failures.join(", "));
  process.exit(failures.length ? 1 : 0);
};

main().catch((e) => {
  console.error("relay-session test error:", e);
  process.exit(1);
});
