/**
 * Runnable verification for broadcast forwarding (TASK-475).
 *   bun src/bun/remote/verify-broadcast.ts
 *
 * Covers the pure fan-out bus (delivery, error isolation, unregister) and the
 * full bus -> WS server -> connected client delivery path. The one remaining
 * link (broadcastToWebview -> emitBroadcast, an additive sink in engine-manager)
 * is a trivial loop verified on app run.
 */

import { startRemoteRpcServer } from "./rpc-ws-server";
import { addBroadcastTarget, emitBroadcast, broadcastTargetCount } from "./broadcast-bus";

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

function nextMessage(ws: WebSocket, ms = 2000): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    ws.addEventListener(
      "message",
      (ev: MessageEvent) => {
        clearTimeout(timer);
        resolve(JSON.parse(ev.data as string));
      },
      { once: true },
    );
  });
}

const main = async () => {
  // 1. Pure fan-out + error isolation + unregister.
  const aCalls: Array<[string, unknown]> = [];
  const bCalls: Array<[string, unknown]> = [];
  const offA = addBroadcastTarget((m, p) => aCalls.push([m, p]));
  const offB = addBroadcastTarget((m, p) => {
    if (m === "boom") throw new Error("target B failed");
    bCalls.push([m, p]);
  });
  emitBroadcast("streamToken", { token: "hi" });
  emitBroadcast("boom", {}); // B throws; A must still receive it
  check("all targets receive a normal event", aCalls.length === 2 && bCalls.length === 1);
  check("a throwing target does not starve others", aCalls.some(([m]) => m === "boom"));
  offA();
  offB();
  check("unregister removes targets", broadcastTargetCount() === 0);

  // 2. Full path: bus -> WS server -> connected client.
  const server = startRemoteRpcServer({ port: 0, requestHandlers: {} });
  const off = addBroadcastTarget((m, p) => server.broadcast(m, p));
  const ws = new WebSocket(`ws://127.0.0.1:${server.server.port}`);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws open error")));
  });

  const recv = nextMessage(ws);
  emitBroadcast("dashboardAgentChunk", { sessionId: "s1", token: "hello-remote" });
  const frame = (await recv) as { t?: string; method?: string; payload?: { token?: string } } | null;
  check(
    "a broadcast (dashboardAgentChunk) reaches the connected WS client",
    !!frame && frame.t === "broadcast" && frame.method === "dashboardAgentChunk" && frame.payload?.token === "hello-remote",
  );

  // streamToken too (named in the AC).
  const recv2 = nextMessage(ws);
  emitBroadcast("streamToken", { conversationId: "c1", token: "tok" });
  const frame2 = (await recv2) as { method?: string } | null;
  check("a streamToken broadcast reaches the connected WS client", !!frame2 && frame2.method === "streamToken");

  // 3. Server-side subscription filtering — a client only gets its routing ids.
  ws.send(JSON.stringify({ t: "sub", ids: ["conv-A"] }));
  await new Promise((r) => setTimeout(r, 60)); // let the subscription register

  const notForMe = nextMessage(ws, 700);
  emitBroadcast("streamToken", { conversationId: "conv-B", token: "other" });
  check("subscribed client does NOT receive another conversation", (await notForMe) === null);

  const forMe = nextMessage(ws, 1500);
  emitBroadcast("streamToken", { conversationId: "conv-A", token: "mine" });
  const mineFrame = (await forMe) as { payload?: { token?: string } } | null;
  check("subscribed client receives its own conversation", mineFrame?.payload?.token === "mine");

  const globalMsg = nextMessage(ws, 1500);
  emitBroadcast("conversationTitleChanged", { title: "x" }); // no routing id → global
  check("subscribed client still receives global broadcasts", (await globalMsg) !== null);

  off();
  ws.close();
  server.stop();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) console.log("FAILURES:", failures.join(", "));
  process.exit(failures.length ? 1 : 0);
};

main().catch((e) => {
  console.error("verify-broadcast error:", e);
  process.exit(1);
});
