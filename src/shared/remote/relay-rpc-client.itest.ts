/**
 * FULL-LOOP capstone (TASK-477 + 482) against a local `wrangler dev` relay:
 *   web relay-rpc-client  ⇄  relay  ⇄  desktop relay-session manager
 * Both real transports, real E2E, real RPC dispatch + broadcast.
 *
 *   (cd relay && npm run dev)
 *   bun src/shared/remote/relay-rpc-client.itest.ts
 */

import { createRelayRpcClient } from "./relay-rpc-client";
import { createDesktopPairing, completeClientPairing } from "./pairing";
import { startRelaySession } from "../../bun/remote/relay-session";

const HTTP = process.env.RELAY_HTTP ?? "http://127.0.0.1:8787";
const WS = process.env.RELAY_WS ?? "ws://127.0.0.1:8787";

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
function waitFor(pred: () => boolean, ms = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (pred()) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - start > ms) {
        clearInterval(t);
        resolve(false);
      }
    }, 40);
  });
}

const main = async () => {
  // Desktop: pairing + session manager with mock handlers.
  const desktop = await createDesktopPairing(HTTP);
  const session = startRelaySession({
    relayWss: WS,
    desktopToken: desktop.desktopToken,
    desktopPrivateKey: desktop.desktopKeyPair.privateKey,
    resolvePairingSecret: (id) => (id === desktop.pairingId ? desktop.pairingSecret : null),
    requestHandlers: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      echo: (p: any) => p,
      add: (p: { a: number; b: number }) => p.a + p.b,
      boom: () => {
        throw new Error("kaboom");
      },
    },
  });
  await new Promise((r) => setTimeout(r, 400));

  // Web client: complete pairing + the real relay RPC transport.
  const client = await completeClientPairing(desktop.qr);
  const broadcasts: Array<[string, unknown]> = [];
  const rpc = createRelayRpcClient({
    relayWss: WS,
    clientToken: client.clientToken,
    pairingId: client.pairingId,
    clientPublicKeyB64: client.clientPublicKeyB64,
    sessionKey: client.sessionKey,
    onBroadcast: (m, p) => broadcasts.push([m, p]),
    requestTimeoutMs: 5000,
  });

  check("web client reaches online (handshake acked)", await waitFor(() => rpc.status() === "online"));

  const sum = await rpc.request<number>("add", { a: 20, b: 22 });
  check("RPC add returns 42 over the full loop", sum === 42);

  const echoed = await rpc.request("echo", { hi: [1, 2, 3] });
  check("RPC echo round-trips", JSON.stringify(echoed) === JSON.stringify({ hi: [1, 2, 3] }));

  let boomErr = false;
  try {
    await rpc.request("boom");
  } catch (e) {
    boomErr = e instanceof Error && /kaboom/.test(e.message);
  }
  check("throwing handler rejects with the error", boomErr);

  let unkErr = false;
  try {
    await rpc.request("nope");
  } catch (e) {
    unkErr = e instanceof Error && /unknown method/.test(e.message);
  }
  check("unknown method rejects", unkErr);

  session.broadcast("streamToken", { conversationId: "x", token: "live" });
  check("broadcast reaches the web client", await waitFor(() => broadcasts.some(([m]) => m === "streamToken")));

  rpc.close();
  session.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) console.log("FAILURES:", failures.join(", "));
  process.exit(failures.length ? 1 : 0);
};

main().catch((e) => {
  console.error("relay-rpc-client test error:", e);
  process.exit(1);
});
