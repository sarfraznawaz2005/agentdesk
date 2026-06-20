import { BrowserView } from "electrobun/bun";
import type { AgentDeskRPC } from "../shared/rpc";
import { logError } from "./db/error-logger";
import { broadcastToWebview } from "./engine-manager";

// Re-export onSettingChange so index.ts can still import it from here
export { onSettingChange } from "./rpc-groups/setting-callbacks";

// The combined request-handler map (all 8 rpc-groups) lives in ./remote/rpc-handlers
// so the Electrobun bridge (here) and the remote WebSocket RPC server dispatch
// into the IDENTICAL handlers. (TASK-474)
import { requestHandlers } from "./remote/rpc-handlers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withErrorToast<T extends Record<string, (p: any) => any>>(handlers: T): T {
	const wrapped: Record<string, (p: unknown) => unknown> = {};
	for (const [key, fn] of Object.entries(handlers)) {
		wrapped[key] = async (params: unknown) => {
			try {
				return await fn(params);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				broadcastToWebview("showToast", { type: "error", message });
				throw err;
			}
		};
	}
	return wrapped as T;
}

// Define RPC handlers for Bun side
export const rpc = BrowserView.defineRPC<AgentDeskRPC>({
	// Agent operations can take several minutes — disable the 1 s default timeout.
	maxRequestTime: Infinity,
	handlers: {
		requests: withErrorToast(requestHandlers),
		messages: {
			log: ({ level, message }: { level: string; message: string }) => {
				const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
				fn(`[renderer] ${message}`);
			},
			logClientError: ({ type, message, stack }: { type: string; message: string; stack?: string }) => {
				console.error(`[renderer:${type}] ${message}`);
				logError("renderer", type, message, stack);
			},
		},
	},
});
