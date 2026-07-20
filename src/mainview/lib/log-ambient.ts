import { rpc } from "./rpc";

// On — mirrors the backend's own LOG_TO_FILE toggle in
// src/bun/ambient/debug-log.ts, on for the same reason (verifying the new
// local STT feature). Flip back to false once done — no other change needed,
// every logAmbient() call site throughout the ambient pipeline stays exactly
// as is.
const ENABLED = true;

/**
 * Console + persisted-log helper for the ambient voice pipeline. Mirrors the
 * backend's logAmbient (src/bun/ambient/debug-log.ts) — both write to the
 * same {userData}/logs/ambient.log file, tagged `[ambient]`, so the whole
 * pipeline's timeline (recording, turns, tool calls, TTS, timing) lands in
 * one place regardless of which side of the RPC boundary logged it. The
 * webview has no direct filesystem access, so this relays through the
 * fire-and-forget logAmbientDebug RPC rather than writing a file itself.
 */
export function logAmbient(message: string): void {
	if (!ENABLED) return;
	console.log(`[ambient] ${message}`);
	void rpc.logAmbientDebug(message).catch(() => {
		// best-effort — never let logging itself break a turn
	});
}
