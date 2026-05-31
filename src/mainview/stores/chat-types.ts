// Re-export so consumers can import ActivityEvent from this module too
export type { ActivityEvent } from "../lib/types";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  isPinned: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: string;
  agentId: string | null;
  agentName: string | null;
  content: string;
  metadata: string | null;
  tokenCount: number;
  hasParts: number;
  createdAt: string;
}

export interface ActiveInlineAgent {
  agentName: string;
  agentDisplayName: string;
  messageId: string;
}

export type AgentStatusValue =
  | "spawned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ShellApprovalRequest {
  requestId: string;
  agentName: string;
  command: string;
  timestamp: string;
  decision?: "allow" | "deny" | "always";
}
