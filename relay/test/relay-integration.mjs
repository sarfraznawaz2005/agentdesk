/**
 * Integration test for the AgentDesk relay (TASK-471 + TASK-472).
 *
 * Run against a local `wrangler dev` on 127.0.0.1:8787 (uses Node 21+ global
 * `fetch` and `WebSocket`). Exits non-zero on any failed assertion.
 *
 *   node relay/test/relay.test.mjs
 *
 * This is an INTEGRATION script (needs a live relay), not a `bun test` unit
 * test. The guard at the bottom runs main() only when the file is the direct
 * entry point, so the repo-root `bun test` (which imports every *.test.* file)
 * does NOT fire the network calls and abort collection.
 */

import { pathToFileURL } from "node:url";

const HTTP = process.env.RELAY_HTTP ?? "http://127.0.0.1:8787";
const WS = process.env.RELAY_WS ?? "ws://127.0.0.1:8787";

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

function openSocket(token) {
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

/** Resolves with the next message received, or null on timeout/close. */
function nextMessage(ws, ms = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      resolve(null);
    }, ms);
    function onMsg(ev) {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve(ev.data);
    }
    ws.addEventListener("message", onMsg);
  });
}

/** Resolves with the close code, or null on timeout. */
function nextClose(ws, ms = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      resolve(ev.code);
    });
  });
}

const main = async () => {
  // 1. Health.
  const health = await (await fetch(`${HTTP}/health`)).json();
  check("health endpoint returns ok", health.ok === true);

  // 2. Register a room → role-scoped tokens.
  const reg = await (await fetch(`${HTTP}/register`, { method: "POST" })).json();
  check("register returns a roomId", typeof reg.roomId === "string" && reg.roomId.length > 0);
  check("register returns a desktopToken", typeof reg.desktopToken === "string");
  check("register returns a clientToken", typeof reg.clientToken === "string");
  check("desktop and client tokens differ", reg.desktopToken !== reg.clientToken);

  // 3. A tampered token is rejected (cannot open the socket).
  let rejected = false;
  try {
    await openSocket(reg.clientToken.slice(0, -2) + "xx");
  } catch {
    rejected = true;
  }
  check("tampered token is rejected", rejected);

  // 4. Connect desktop + client and forward opaquely both ways.
  const desktop = await openSocket(reg.desktopToken);
  const client = await openSocket(reg.clientToken);

  const fromClient = nextMessage(desktop);
  client.send("ping-from-client");
  const got1 = await fromClient;
  check("client -> desktop frame is forwarded", got1 === "ping-from-client");

  const fromDesktop = nextMessage(client);
  desktop.send("pong-from-desktop");
  const got2 = await fromDesktop;
  check("desktop -> client frame is forwarded", got2 === "pong-from-desktop");

  // 5. Binary frame is forwarded opaquely (relay never inspects).
  const binFromClient = nextMessage(desktop);
  client.send(new Uint8Array([1, 2, 3, 4]).buffer);
  const bin = await binFromClient;
  const binOk = bin instanceof ArrayBuffer && new Uint8Array(bin).length === 4 && new Uint8Array(bin)[3] === 4;
  check("binary frame is forwarded opaquely", binOk);

  // 6. Reconnecting the desktop replaces the old one (one-desktop-per-room).
  const oldDesktopClose = nextClose(desktop);
  const desktop2 = await openSocket(reg.desktopToken);
  const code = await oldDesktopClose;
  check("a second desktop replaces the first (close 4002)", code === 4002);

  // 7. When the desktop closes, the client is told it's offline (close 4001).
  const clientClose = nextClose(client);
  desktop2.close(1000, "bye");
  const clientCode = await clientClose;
  check("client is closed with 4001 when desktop drops", clientCode === 4001);

  // 8. Cross-tenant isolation: a client in room B can NEVER reach room A's
  //    desktop. The room is bound inside the signed token, so a client cannot
  //    address another room's desktop.
  const regB = await (await fetch(`${HTTP}/register`, { method: "POST" })).json();
  const desktopA = await openSocket(reg.desktopToken); // room A
  const clientB = await openSocket(regB.clientToken); // room B
  const leak = nextMessage(desktopA, 1500);
  clientB.send("cross-tenant-should-not-arrive");
  const leaked = await leak;
  check("cross-tenant isolation: room B client cannot reach room A desktop", leaked === null);
  try {
    desktopA.close();
    clientB.close();
  } catch {
    /* ignore */
  }

  // 9. Revocation: /revoke requires desktop auth and blocks the client token.
  const regC = await (await fetch(`${HTTP}/register`, { method: "POST" })).json();

  const badRevoke = await fetch(`${HTTP}/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${regC.clientToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: regC.clientToken }),
  });
  check("revoke rejects non-desktop auth (401)", badRevoke.status === 401);

  const revoke = await fetch(`${HTTP}/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${regC.desktopToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token: regC.clientToken }),
  });
  check("desktop-authenticated revoke succeeds", revoke.ok);

  let revokedRejected = false;
  try {
    await openSocket(regC.clientToken);
  } catch {
    revokedRejected = true;
  }
  check("a revoked client token cannot connect", revokedRejected);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("FAILURES:", failures.join(", "));
    process.exit(1);
  }
  process.exit(0);
};

// Run only when executed directly (e.g. `node relay/test/relay.test.mjs`), not
// when imported by a test runner collecting *.test.* files.
const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error("test harness error:", err);
    process.exit(1);
  });
}
