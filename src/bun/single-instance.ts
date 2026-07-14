// ---------------------------------------------------------------------------
// Windows-only single-instance coordination.
//
// macOS gets Quick Chat activation for free from Launch Services: a second
// launch of an already-registered .app bundle activates the existing process
// and delivers open-url events to it directly via the app's urlSchemes — no
// explicit lock needed there (see electrobun.config.ts + index.ts's open-url
// handler, Subsystem 6 of docs/quick-chat-plan.md).
//
// On Windows, a context-menu click always spawns a fresh OS process. This
// module lets every launch (quick-chat or normal) try to claim a well-known
// loopback TCP port; only whichever process claims it becomes reachable for
// future handoffs:
//   - A quick-chat launch that loses the race hands its request to the
//     owning process (which opens/focuses that Quick Chat window) and exits
//     immediately, without finishing the rest of its own boot.
//   - A normal launch that loses the race hands an "activate-main-window"
//     request instead — the owning process's ensureMainWindow() creates (if
//     the owner was a Quick-Chat-only process, this PROMOTES it to a full
//     instance) or focuses its main window — and this process exits too,
//     rather than becoming a redundant second full instance.
//
// Originally implemented over a Windows named pipe (net.Server.listen(path)).
// Reverted after a live test on a real packaged build threw
// "TypeError: Failed to listen at \\.\pipe\...  code: ERR_INVALID_ARG_TYPE"
// from Bun's bundled node:net polyfill — the pipe-path overload of
// server.listen() doesn't work correctly in the Bun version Electrobun
// bundles (unrelated to the globally-installed `bun` this was first verified
// against, which does not reproduce it). A loopback TCP port sidesteps that
// entirely: it's the exact same "bind, EADDRINUSE means already running"
// pattern this codebase already relies on elsewhere (the dev server, the
// annotation server, the Playground server all bind fixed/fallback ports),
// so it's proven to work in this environment.
// ---------------------------------------------------------------------------

import { createServer, connect, type Server, type Socket } from "node:net";
import { Updater } from "electrobun/bun";

export interface OpenQuickChatRequest {
	action: "open-quick-chat";
	workspacePath: string;
}

export interface ActivateMainWindowRequest {
	action: "activate-main-window";
}

export type HandoffRequest = OpenQuickChatRequest | ActivateMainWindowRequest;

type HandoffListener = (req: HandoffRequest) => void;

let server: Server | null = null;

// Channel-qualified so dev/canary/stable installs running side by side never
// collide with (or hand off to) each other. Chosen well away from this app's
// other fixed ports (Vite 5173, dev remote RPC 5174, annotation-server 4748,
// Playground server 4760).
const CHANNEL_PORTS: Record<string, number> = {
	stable: 47_900,
	canary: 47_901,
	dev: 47_902,
};

function portForChannel(channel: string): number {
	if (channel in CHANNEL_PORTS) return CHANNEL_PORTS[channel];
	// Unknown/future channel name — deterministic fallback so it still gets a
	// stable, distinct port across launches without needing a code change.
	let hash = 0;
	for (let i = 0; i < channel.length; i++) hash = (hash * 31 + channel.charCodeAt(i)) >>> 0;
	return 47_910 + (hash % 50);
}

async function ipcPort(): Promise<number> {
	const channel = await Updater.localInfo.channel();
	return portForChannel(channel);
}

/**
 * Try to become the reachable instance for future handoffs by claiming a
 * fixed loopback TCP port. Resolves true if this process claimed it (future
 * handoffs will arrive via `onHandoff`) or false if another instance already
 * owns the port. Always resolves true on non-Windows platforms (no-op — see
 * module doc comment).
 *
 * Safe to call on every launch (normal or quick-chat) — cheap, and losing the
 * race is not an error, it just means another instance is already running.
 */
export async function acquireSingleInstanceLock(onHandoff: HandoffListener): Promise<boolean> {
	if (process.platform !== "win32") return true;

	const port = await ipcPort();
	return new Promise((resolve) => {
		const srv = createServer((socket: Socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				const idx = buffer.indexOf("\n");
				if (idx === -1) return; // wait for the rest of the line
				const line = buffer.slice(0, idx);
				try {
					const req = JSON.parse(line) as HandoffRequest;
					if (req.action === "open-quick-chat" && typeof req.workspacePath === "string" && req.workspacePath) {
						onHandoff(req);
					} else if (req.action === "activate-main-window") {
						onHandoff(req);
					}
				} catch (err) {
					console.error("[single-instance] Malformed handoff payload:", err);
				}
				socket.end();
			});
			socket.on("error", () => { /* client disconnected mid-write — ignore */ });
		});

		srv.on("error", (err: NodeJS.ErrnoException) => {
			// EADDRINUSE means another instance already owns this port — we are
			// not the claimant. Any OTHER error here means the port bind itself
			// is broken (not "someone else has it") — do NOT fail open and
			// silently pretend to be the claimant in that case (a real bug that
			// previously masked itself this way): report false so this launch
			// falls through to booting as its own independent instance, which is
			// safe and visible, rather than an unbound "server" that can never
			// actually receive anything.
			if (err.code !== "EADDRINUSE") {
				console.error("[single-instance] Port bind failed (not EADDRINUSE) — this launch will boot independently:", err);
			}
			resolve(false);
		});

		// Loopback-only — never exposed off this machine.
		srv.listen(port, "127.0.0.1", () => {
			server = srv;
			resolve(true);
		});
	});
}

/**
 * Send a handoff (Quick Chat or "activate main window") to whichever instance
 * currently owns the port. Resolves true if delivered, false if the
 * connection failed (e.g. the owner quit in the brief window between the
 * failed lock attempt and this call — the caller should fall back to booting
 * this launch normally in that race).
 */
export async function sendHandoffToPrimary(req: HandoffRequest): Promise<boolean> {
	if (process.platform !== "win32") return false;
	const port = await ipcPort();
	return new Promise((resolve) => {
		let settled = false;
		const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };

		const socket = connect(port, "127.0.0.1", () => {
			socket.write(JSON.stringify(req) + "\n");
		});
		socket.on("close", () => settle(true));
		socket.on("error", () => settle(false));
		// Safety timeout — never hang the handing-off process indefinitely on a stuck connection.
		setTimeout(() => { try { socket.destroy(); } catch { /* ignore */ } settle(false); }, 3000);
	});
}

/** Closes the IPC server on app shutdown so the OS releases the port promptly. */
export function shutdownSingleInstanceServer(): void {
	if (server) {
		try { server.close(); } catch { /* ignore */ }
		server = null;
	}
}
