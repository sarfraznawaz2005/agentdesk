/**
 * End-to-end test for the desktop relay client (TASK-476) against a local
 * `wrangler dev` relay on 127.0.0.1:8787.
 *
 *   (cd relay && npm run dev)   # in another shell
 *   bun src/bun/remote/relay-client.itest.ts
 */

import { startRelayClient, type RelayStatus } from "./relay-client";

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
    }, 50);
  });
}

function openWs(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/?token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    });
  });
}

const main = async () => {
  const reg = await (await fetch(`${HTTP}/register`, { method: "POST" })).json();

  const statuses: RelayStatus[] = [];
  let lastMessage: unknown = null;
  const client = startRelayClient({
    url: WS,
    token: reg.desktopToken,
    onStatus: (s) => statuses.push(s),
    onMessage: (d) => {
      lastMessage = d;
    },
    minBackoffMs: 200,
    maxBackoffMs: 1000,
  });

  // 1. Outbound dial reaches online.
  check("relay client reaches online", await waitFor(() => client.status() === "online"));

  // 2. A frame from a web client reaches the desktop relay client.
  const web = await openWs(reg.clientToken);
  lastMessage = null;
  web.send("hello-desktop");
  check("frame from web client reaches the desktop relay client", await waitFor(() => lastMessage === "hello-desktop"));

  // 3. Auto-reconnect: a second desktop (same token) makes the relay kick our
  //    client (close 4002); it should go offline then reconnect to online.
  statuses.length = 0;
  const intruder = await openWs(reg.desktopToken);
  check("relay client detects the disconnect (offline)", await waitFor(() => statuses.includes("offline")));
  check("relay client auto-reconnects (online)", await waitFor(() => client.status() === "online", 8000));
  try {
    intruder.close();
  } catch {
    /* ignore */
  }

  // 4. Forwarding still works after the reconnect.
  const web2 = await openWs(reg.clientToken);
  lastMessage = null;
  web2.send("after-reconnect");
  check("forwarding works after reconnect", await waitFor(() => lastMessage === "after-reconnect"));

  // 5. close() stops the client and it stays offline (no reconnect).
  client.close();
  const stoppedOffline = await waitFor(() => client.status() === "offline");
  // give any erroneous reconnect a moment to (not) happen
  await new Promise((r) => setTimeout(r, 600));
  check("close() stops the client (stays offline)", stoppedOffline && client.status() === "offline");

  try {
    web.close();
    web2.close();
  } catch {
    /* ignore */
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) console.log("FAILURES:", failures.join(", "));
  process.exit(failures.length ? 1 : 0);
};

main().catch((e) => {
  console.error("relay-client test error:", e);
  process.exit(1);
});
