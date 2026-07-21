// ---------------------------------------------------------------------------
// General Chat todo tools (injected into the Assistant agent via extraTools)
//
// A standalone, per-conversation-scoped equivalent of the PM's todo_write/
// todo_read/todo_update_item tools (pm-tools.ts). Unlike the PM's version —
// which persists to the `settings` table so it survives across PM turns and
// drives run_agent's auto-advance — this is a plain in-memory scratch list,
// since Assistant has no sub-agents to hand items off to and General Chat
// never persists tool-call state. Cleared via clearGeneralChatTodos() when
// the conversation's turn/session ends.
// ---------------------------------------------------------------------------

import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";

interface TodoItem {
	id: string;
	title: string;
	status: "pending" | "in_progress" | "done";
}

const todosByConversation = new Map<string, Map<string, TodoItem[]>>();
const activeListByConversation = new Map<string, string>();

export function clearGeneralChatTodos(conversationId: string): void {
	todosByConversation.delete(conversationId);
	activeListByConversation.delete(conversationId);
}

export function createGeneralChatTodoTools(conversationId: string): Record<string, Tool> {
	return {
		todo_write: tool({
			description:
				"Create a new todo list for this conversation. Pass titles as a simple string array. " +
				"Item IDs are auto-assigned as '1', '2', '3'... matching the order of titles. If a list " +
				"already exists and is not done, returns the existing list — do NOT retry, just use that list_id.",
			inputSchema: z.object({
				titles: z.array(z.string().min(1)).min(1).describe(
					"Ordered list of todo item titles, e.g. [\"Research topic\", \"Draft summary\"]",
				),
			}),
			execute: async ({ titles }) => {
				const activeListId = activeListByConversation.get(conversationId);
				if (activeListId) {
					const activeItems = todosByConversation.get(conversationId)?.get(activeListId);
					if (activeItems && !activeItems.every((i) => i.status === "done")) {
						const doneCount = activeItems.filter((i) => i.status === "done").length;
						const pending = activeItems.filter((i) => i.status !== "done");
						return JSON.stringify({
							success: true,
							note: "Resumed existing todo list — use this list_id, do not call todo_write again.",
							list_id: activeListId,
							done: doneCount,
							total: activeItems.length,
							remaining: pending.map((i) => ({ id: i.id, title: i.title, status: i.status })),
						});
					}
				}

				const listId = Math.random().toString(36).slice(2, 8);
				const items: TodoItem[] = titles.map((title, i) => ({ id: String(i + 1), title, status: "pending" }));

				if (!todosByConversation.has(conversationId)) todosByConversation.set(conversationId, new Map());
				todosByConversation.get(conversationId)?.set(listId, items);
				activeListByConversation.set(conversationId, listId);

				return JSON.stringify({ success: true, list_id: listId, total: items.length, done: 0 });
			},
		}),

		todo_read: tool({
			description: "Read a todo list by its list_id. Pass the list_id returned by todo_write.",
			inputSchema: z.object({
				list_id: z.string().describe("The list_id returned by todo_write"),
			}),
			execute: async ({ list_id }) => {
				const items = todosByConversation.get(conversationId)?.get(list_id);
				if (!items) return JSON.stringify({ success: false, error: `No todo list with id '${list_id}'` });
				return JSON.stringify({
					list_id,
					items,
					total: items.length,
					done: items.filter((i) => i.status === "done").length,
					inProgress: items.filter((i) => i.status === "in_progress").length,
					pending: items.filter((i) => i.status === "pending").length,
				});
			},
		}),

		todo_update_item: tool({
			description: "Update a single item's status in a todo list. Pass the list_id from todo_write and the item id.",
			inputSchema: z.object({
				list_id: z.string().describe("The list_id returned by todo_write"),
				id: z.string().describe("The item id to update"),
				status: z.enum(["pending", "in_progress", "done"]),
			}),
			execute: async ({ list_id, id, status }) => {
				const items = todosByConversation.get(conversationId)?.get(list_id);
				if (!items) return JSON.stringify({ success: false, error: `No todo list with id '${list_id}'` });
				const idx = items.findIndex((i) => i.id === id);
				if (idx === -1) return JSON.stringify({ success: false, error: `No item with id '${id}' in list '${list_id}'` });

				items[idx].status = status;
				const doneCount = items.filter((i) => i.status === "done").length;
				if (doneCount === items.length) activeListByConversation.delete(conversationId);

				return JSON.stringify({ success: true, list_id, id, status, done: doneCount, total: items.length });
			},
		}),
	};
}
