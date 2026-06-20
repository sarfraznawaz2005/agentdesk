/**
 * Test the WS-RPC client (TASK-479 core) against the real WS server.
 *   bun src/shared/remote/ws-rpc-client.itest.ts
 */

import { createWsRpcClient } from "./ws-rpc-client";
import { startRemoteRpcServer } from "../../bun/remote/rpc-ws-server";

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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> {
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
    }, 30);
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const mock = {
  echo: (p: any) => p,
  add: (p: { a: number; b: number }) => p.a + p.b,
  boom: () => {
    throw new Error("kaboom");
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const main = async () => {
  const server = startRemoteRpcServer({ port: 0, requestHandlers: mock });
  const port = server.server.port;

  const broadcasts: Array<[string, { conversationId?: string }]> = [];
  const client = createWsRpcClient({
    url: `ws://127.0.0.1:${port}`,
    onBroadcast: (m, p) => broadcasts.push([m, p as { conversationId?: string }]),
    requestTimeoutMs: 4000,
  });

  check("client reaches online", await waitFor(() => client.status() === "online"));

  // request/response
  const r1 = await client.request("echo", { x: 1, arr: [1, 2] });
  check("echo round-trips", JSON.stringify(r1) === JSON.stringify({ x: 1, arr: [1, 2] }));
  const r2 = await client.request<number>("add", { a: 2, b: 5 });
  check("add returns 7", r2 === 7);

  // errors
  let boomErr = false;
  try {
    await client.request("boom");
  } catch (e) {
    boomErr = e instanceof Error && /kaboom/.test(e.message);
  }
  check("throwing handler rejects with the error", boomErr);

  let unkErr = false;
  try {
    await client.request("does_not_exist");
  } catch (e) {
    unkErr = e instanceof Error && /unknown method/.test(e.message);
  }
  check("unknown method rejects", unkErr);

  // subscription-filtered broadcasts
  client.subscribe(["conv-A"]);
  await wait(60);
  server.broadcast("streamToken", { conversationId: "conv-B", token: "no" });
  await wait(250);
  check("does NOT receive an unsubscribed conversation", !broadcasts.some(([, p]) => p?.conversationId === "conv-B"));

  server.broadcast("streamToken", { conversationId: "conv-A", token: "yes" });
  check("receives the subscribed conversation", await waitFor(() => broadcasts.some(([, p]) => p?.conversationId === "conv-A")));

  server.broadcast("conversationTitleChanged", { title: "t" });
  check("receives a global broadcast", await waitFor(() => broadcasts.some(([m]) => m === "conversationTitleChanged")));

  // close rejects in-flight + future requests
  client.close();
  let closedRejected = false;
  try {
    await client.request("echo", {});
  } catch {
    closedRejected = true;
  }
  check("request after close rejects", closedRejected);

  server.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) console.log("FAILURES:", failures.join(", "));
  process.exit(failures.length ? 1 : 0);
};

main().catch((e) => {
  console.error("ws-rpc-client test error:", e);
  process.exit(1);
});
