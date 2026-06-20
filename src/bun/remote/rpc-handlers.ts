/**
 * Single source of truth for backend RPC request handlers.
 *
 * Both transports dispatch into THIS exact map, so a given method returns an
 * identical result regardless of how it was invoked:
 *   • the Electrobun webview bridge  (rpc-registration.ts)
 *   • the remote WebSocket RPC server (rpc-ws-server.ts, reached via the relay
 *     or a direct/tunnel connection from the web app)
 *
 * The handlers are plain transport-agnostic functions — they take `params` and
 * return a value/Promise — so reusing them across transports requires no change
 * to any handler in src/bun/rpc/. (TASK-474)
 */

import { handlers as settingsProviderHandlers } from "../rpc-groups/settings-providers";
import { handlers as projectsSystemHandlers } from "../rpc-groups/projects-system";
import { handlers as conversationsControlHandlers } from "../rpc-groups/conversations-control";
import { handlers as agentsKanbanNotesHandlers } from "../rpc-groups/agents-kanban-notes";
import { handlers as gitAnalyticsHandlers } from "../rpc-groups/git-analytics";
import { handlers as channelsInboxSchedulerHandlers } from "../rpc-groups/channels-inbox-scheduler";
import { handlers as pluginsToolsHandlers } from "../rpc-groups/plugins-tools";
import { handlers as featuresHandlers } from "../rpc-groups/features";

/**
 * The combined request-handler map (all 8 rpc-groups). The type is INFERRED as
 * the precise intersection of the eight group types so that
 * `BrowserView.defineRPC<AgentDeskRPC>` keeps full type-checking in
 * rpc-registration.ts. The remote WS server accepts it via a looser structural
 * `RpcRequestHandlers` parameter (the precise type is assignable to it).
 */
export const requestHandlers = {
  ...settingsProviderHandlers,
  ...projectsSystemHandlers,
  ...conversationsControlHandlers,
  ...agentsKanbanNotesHandlers,
  ...gitAnalyticsHandlers,
  ...channelsInboxSchedulerHandlers,
  ...pluginsToolsHandlers,
  ...featuresHandlers,
};
