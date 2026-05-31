/**
 * Shared frontend types used across multiple components and stores.
 * Centralised here to prevent type drift from duplicate interface definitions.
 */

export interface ActivityEvent {
	/** Monotonic unique ID assigned on the frontend when the event is received. */
	_id: number;
	projectId: string;
	conversationId: string;
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

/** Monotonic counter for generating unique ActivityEvent IDs. */
let _activityIdCounter = 0;

/** Assign a unique `_id` to an event. Mutates and returns the same object. */
export function assignActivityId<T extends { _id?: number }>(event: T): T & { _id: number } {
	(event as T & { _id: number })._id = ++_activityIdCounter;
	return event as T & { _id: number };
}
