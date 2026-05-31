export type AgentRole =
	| "project-manager"
	| "software-architect"
	| "backend-engineer"
	| "code-reviewer"
	| "task-planner"
	| "qa-engineer"
	| "frontend_engineer"
	| "devops-engineer"
	| "documentation-expert"
	| "performance-expert"
	| "security-expert"
	| "ui-ux-designer"
	| "data-engineer"
	| "debugging-specialist";

export type AgentStatus =
	| "idle"
	| "spawned"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

export interface AgentConfig {
	id: string;
	name: string;
	displayName: string;
	color: string;
	systemPrompt: string;
	providerId?: string;
	modelId?: string;
	temperature?: number;
	maxTokens?: number;
}

export interface AgentTask {
	id: string;
	agentName: string;
	description: string;
	context: string;
	constraints?: string;
}

export interface AgentResult {
	taskId: string;
	agentId: string;
	agentName: string;
	status: "completed" | "failed";
	summary: string;
	details?: string;
	tokensUsed: { prompt: number; completion: number };
	/** New messages produced during this invocation (for agent session persistence). */
	newMessages?: import("ai").ModelMessage[];
	/** Files written/edited during this invocation (from FileTracker). */
	filesModified?: string[];
}

export interface AgentActivityEvent {
	projectId: string;
	conversationId?: string;
	agentId: string;
	agentName: string;
	agentColor: string;
	type:
		| "thinking"
		| "tool_call"
		| "tool_result"
		| "task_move"
		| "task_in_review"
		| "review_result"
		| "spawn"
		| "terminate"
		| "error"
		| "status_check"
		| "shell_approval"
		| "agent_text"
		| "progress"
		| "file_conflict"
		| "info";
	data: Record<string, unknown>;
	timestamp: string;
}

export interface RunningAgent {
	id: string;
	config: AgentConfig;
	task: AgentTask;
	status: AgentStatus;
	abortController: AbortController;
	promise: Promise<AgentResult>;
	retryCount?: number;
	/** Resolved session name for concurrent same-type agent isolation (e.g. "frontend_engineer#2"). */
	_sessionName?: string;
}
