/**
 * Remote access entrypoint (TASK-474+).
 *
 * Opt-in local WebSocket RPC server that re-dispatches into the SAME backend
 * handler map the Electrobun bridge uses, plus broadcast forwarding (TASK-475)
 * so webview broadcasts also reach connected remote clients. Disabled unless
 * `AGENTDESK_REMOTE_RPC_PORT` is set, so existing users are completely
 * unaffected until the feature is finished and turned on.
 *
 * The relay transport (TASK-476/477) reuses `requestHandlers` and the broadcast
 * bus directly — it does not need this local port — but this server is useful
 * for direct/LAN/tunnel access and for testing against a real backend.
 */

import { startRemoteRpcServer, type RemoteRpcServer } from "./rpc-ws-server";
import { requestHandlers } from "./rpc-handlers";
import { addBroadcastTarget } from "./broadcast-bus";
import { ensureRemoteBroadcastHook, removeRemoteBroadcastHook } from "./broadcast-hook";

export { ensureRemoteBroadcastHook };

let instance: RemoteRpcServer | null = null;
let teardown: Array<() => void> = [];

export function maybeStartRemoteRpcServer(): RemoteRpcServer | null {
  if (instance) return instance;
  const portStr = process.env.AGENTDESK_REMOTE_RPC_PORT;
  if (!portStr) return null;
  const port = Number(portStr);
  if (!Number.isFinite(port) || port <= 0) {
    console.warn(`[remote-rpc] ignoring invalid AGENTDESK_REMOTE_RPC_PORT=${portStr}`);
    return null;
  }
  try {
    instance = startRemoteRpcServer({ port, requestHandlers });
    // TASK-475: webview broadcasts -> bus -> this server's connected clients.
    ensureRemoteBroadcastHook();
    teardown.push(addBroadcastTarget((method, payload) => instance?.broadcast(method, payload)));
    console.log(`[remote-rpc] WebSocket RPC server listening on 127.0.0.1:${port}`);
  } catch (err) {
    console.error("[remote-rpc] failed to start:", err);
    instance = null;
  }
  return instance;
}

/** Exposed for the relay session (TASK-477) to push frames to direct clients. */
export function getRemoteRpcServer(): RemoteRpcServer | null {
  return instance;
}

export function shutdownRemoteRpcServer(): void {
  for (const fn of teardown) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  teardown = [];
  removeRemoteBroadcastHook();
  try {
    instance?.stop();
  } catch {
    /* ignore */
  }
  instance = null;
}
