/**
 * Installs the engine-manager → broadcast-bus hook (TASK-475).
 *
 * Kept in its own module (imports only engine-manager + the pure broadcast-bus,
 * never rpc-handlers) so the remote manager can depend on it without creating an
 * import cycle (rpc-handlers → features → remote-access → manager → …).
 */

import { registerRemoteBroadcastSink } from "../engine-manager";
import { emitBroadcast } from "./broadcast-bus";

let installed = false;
let teardown: (() => void) | null = null;

/** Idempotently pipe webview broadcasts into the remote broadcast bus. */
export function ensureRemoteBroadcastHook(): void {
  if (installed) return;
  teardown = registerRemoteBroadcastSink(emitBroadcast);
  installed = true;
}

export function removeRemoteBroadcastHook(): void {
  teardown?.();
  teardown = null;
  installed = false;
}
