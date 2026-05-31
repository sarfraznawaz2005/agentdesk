// Re-export shim — the RPC schema has been split into domain modules.
// All existing imports (`import type { AgentDeskRPC } from "...shared/rpc"`)
// continue to resolve here without any changes required in consumers.
export type { AgentDeskRPC } from "./rpc/index";
