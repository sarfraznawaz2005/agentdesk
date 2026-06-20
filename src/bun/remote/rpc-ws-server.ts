/**
 * Remote RPC over WebSocket — a `Bun.serve` endpoint that re-dispatches RPC
 * calls into the SAME backend handler map the Electrobun bridge uses
 * (`requestHandlers` from ./rpc-handlers), so results are identical across
 * transports. (TASK-474)
 *
 * Handlers are passed in (dependency injection) rather than imported here, so:
 *   • production wires in the real `requestHandlers` map, and
 *   • the transport can be verified in isolation with a mock map (no app/DB).
 *
 * Wire protocol (JSON text frames):
 *   client → server  { "t": "req", "id": <string>, "method": <string>, "params": <any> }
 *   server → client  { "t": "res", "id": <string>, "result": <any> }
 *                    { "t": "err", "id": <string>, "message": <string> }
 *   server → client  { "t": "broadcast", "method": <string>, "payload": <any> }   // TASK-475 feeds this
 *
 * Auth (device-token pairing) and relay transport are layered on later
 * (TASK-477/482/492). This module is the dumb, faithful dispatcher.
 */

import type { Server, ServerWebSocket } from "bun";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type RpcRequestHandlers = Record<string, (params: any) => unknown | Promise<unknown>>;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface ConnData {
  /** Reserved for the auth gate (TASK-492). */
  authed: boolean;
  /**
   * Broadcast subscription filter (TASK-475). `null` = receive ALL broadcasts
   * (default). A Set narrows to only those routing ids (conversationId /
   * sessionId / projectId) — plus "global" broadcasts that carry no routing id.
   * A client sets it by sending { "t": "sub", "ids": ["<conversationId>", ...] }.
   */
  subs: Set<string> | null;
}

/** Pull the routing id a broadcast belongs to, if any (else it is global). */
function routingIdOf(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const key of ["conversationId", "sessionId", "projectId"] as const) {
      const v = p[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return null;
}

export interface RemoteRpcServer {
  server: Server<ConnData>;
  /** Push a broadcast frame to every connected client (used by TASK-475). */
  broadcast: (method: string, payload: unknown) => void;
  /** Number of currently-connected clients. */
  connectionCount: () => number;
  stop: () => void;
}

export interface RemoteRpcServerOptions {
  port: number;
  /** Defaults to loopback so the server is not world-reachable by accident. */
  hostname?: string;
  requestHandlers: RpcRequestHandlers;
}

export function startRemoteRpcServer(options: RemoteRpcServerOptions): RemoteRpcServer {
  const sockets = new Set<ServerWebSocket<ConnData>>();

  const server = Bun.serve<ConnData>({
    port: options.port,
    hostname: options.hostname ?? "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "agentdesk-remote-rpc" });
      }
      // TASK-492: authenticate the upgrade (device token) before accepting.
      if (srv.upgrade(req, { data: { authed: true, subs: null } })) return undefined;
      return new Response("AgentDesk remote RPC", { status: 200 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      async message(ws, raw) {
        let env: { t?: string; id?: string; method?: string; params?: unknown; ids?: unknown };
        try {
          env = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        } catch {
          return; // ignore non-JSON frames
        }
        if (!env || typeof env !== "object") return;

        // Broadcast subscription (TASK-475): narrow which routing ids this client
        // receives. { t:"sub", ids:[...] } → only those (+ global); absent/empty → all.
        if (env.t === "sub") {
          ws.data.subs = Array.isArray(env.ids)
            ? new Set(env.ids.filter((x): x is string => typeof x === "string"))
            : null;
          return;
        }

        if (env.t !== "req" || typeof env.method !== "string") return;

        const fn = options.requestHandlers[env.method];
        if (!fn) {
          ws.send(JSON.stringify({ t: "err", id: env.id, message: `unknown method: ${env.method}` }));
          return;
        }
        try {
          const result = await fn(env.params);
          ws.send(JSON.stringify({ t: "res", id: env.id, result }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ t: "err", id: env.id, message }));
        }
      },
    },
  });

  function broadcast(method: string, payload: unknown): void {
    const routingId = routingIdOf(payload);
    const frame = JSON.stringify({ t: "broadcast", method, payload });
    for (const ws of sockets) {
      // Deliver if the client receives all (subs===null), the broadcast is
      // global (no routing id), or the client subscribed to this routing id.
      const subs = ws.data.subs;
      if (subs === null || routingId === null || subs.has(routingId)) {
        try {
          ws.send(frame);
        } catch {
          /* drop; closed sockets are removed on close */
        }
      }
    }
  }

  return {
    server,
    broadcast,
    connectionCount: () => sockets.size,
    stop: () => server.stop(true),
  };
}
