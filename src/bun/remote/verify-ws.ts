/**
 * Runnable verification for the remote WebSocket RPC transport (TASK-474).
 *
 *   bun src/bun/remote/verify-ws.ts
 *
 * Proves the WS dispatch is FAITHFUL: for sample methods the result delivered
 * over the WebSocket equals the result of calling the same handler directly
 * (the by-construction guarantee that production wires in the real shared
 * `requestHandlers` map means identical results for every method). Also checks
 * error propagation and unknown-method handling.
 *
 * Uses a mock handler map so the transport can be exercised without the
 * Electrobun runtime / DB.
 */

import { startRemoteRpcServer } from "./rpc-ws-server";

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

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockHandlers = {
  echo: (p: any) => p,
  add: (p: { a: number; b: number }) => p.a + p.b,
  getInfo: () => ({ name: "agentdesk", version: 1, nested: { ok: true } }),
  boom: () => {
    throw new Error("kaboom");
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const rpc = startRemoteRpcServer({ port: 0, requestHandlers: mockHandlers });
const port = rpc.server.port;

function call(ws: WebSocket, method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; message?: string }> {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => reject(new Error("rpc timeout")), 3000);
    function onMsg(ev: MessageEvent) {
      const m = JSON.parse(ev.data as string);
      if (m.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve(m.t === "res" ? { ok: true, result: m.result } : { ok: false, message: m.message });
    }
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ t: "req", id, method, params }));
  });
}

const main = async () => {
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  check("health endpoint ok", health.ok === true);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws open error")));
  });

  const samples: Array<[keyof typeof mockHandlers, unknown]> = [
    ["echo", { hello: "world", arr: [1, 2, 3] }],
    ["add", { a: 2, b: 40 }],
    ["getInfo", undefined],
  ];
  for (const [method, params] of samples) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const direct = await (mockHandlers[method] as any)(params);
    const viaWs = await call(ws, method, params);
    check(
      `${method}: WS result equals direct handler result`,
      viaWs.ok === true && JSON.stringify(viaWs.result) === JSON.stringify(direct),
    );
  }

  const err = await call(ws, "boom");
  check("throwing handler returns an err frame", err.ok === false && /kaboom/.test(err.message ?? ""));

  const unknown = await call(ws, "does_not_exist");
  check("unknown method returns an err frame", unknown.ok === false && /unknown method/.test(unknown.message ?? ""));

  check("connectionCount reflects the open socket", rpc.connectionCount() === 1);

  ws.close();
  rpc.stop();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("FAILURES:", failures.join(", "));
    process.exit(1);
  }
  process.exit(0);
};

main().catch((e) => {
  console.error("verify harness error:", e);
  rpc.stop();
  process.exit(1);
});
