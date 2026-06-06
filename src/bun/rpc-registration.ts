import { BrowserView } from "electrobun/bun";
import type { AgentDeskRPC } from "../shared/rpc";
import { logError } from "./db/error-logger";
import { broadcastToWebview } from "./engine-manager";

// Re-export onSettingChange so index.ts can still import it from here
export { onSettingChange } from "./rpc-groups/setting-callbacks";

import { handlers as settingsProviderHandlers } from "./rpc-groups/settings-providers";
import { handlers as projectsSystemHandlers } from "./rpc-groups/projects-system";
import { handlers as conversationsControlHandlers } from "./rpc-groups/conversations-control";
import { handlers as agentsKanbanNotesHandlers } from "./rpc-groups/agents-kanban-notes";
import { handlers as gitAnalyticsHandlers } from "./rpc-groups/git-analytics";
import { handlers as channelsInboxSchedulerHandlers } from "./rpc-groups/channels-inbox-scheduler";
import { handlers as pluginsToolsHandlers } from "./rpc-groups/plugins-tools";
import { handlers as featuresHandlers } from "./rpc-groups/features";

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
		requests: withErrorToast({
			...settingsProviderHandlers,
			...projectsSystemHandlers,
			...conversationsControlHandlers,
			...agentsKanbanNotesHandlers,
			...gitAnalyticsHandlers,
			...channelsInboxSchedulerHandlers,
			...pluginsToolsHandlers,
			...featuresHandlers,
		}),
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
