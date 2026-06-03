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
  // Monotonic insertion-order key from the DB (SQLite rowid). Present on
  // persisted messages loaded from the backend; undefined for in-flight
  // live/optimistic messages, which are ordered after persisted ones by
  // arrival order (see message-list sort).
  seq?: number;
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
