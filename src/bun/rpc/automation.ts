// src/bun/rpc/automation.ts
import { db } from "../db";
import { automationRules } from "../db/schema";
import { eq, asc } from "drizzle-orm";

export async function getAutomationRules(params?: { projectId?: string }) {
	if (params?.projectId) {
		return db.select().from(automationRules)
			.where(eq(automationRules.projectId, params.projectId))
			.orderBy(asc(automationRules.priority));
	}
	return db.select().from(automationRules).orderBy(asc(automationRules.priority));
}

export async function createAutomationRule(params: {
	projectId?: string;
	name: string;
	trigger: string;
	actions: string;
	priority?: number;
}) {
	const id = crypto.randomUUID();
	await db.insert(automationRules).values({
		id,
		projectId: params.projectId ?? null,
		name: params.name,
		trigger: params.trigger,
		actions: params.actions,
		priority: params.priority ?? 0,
	});
	return { id };
}

export async function updateAutomationRule(params: {
	id: string;
	name?: string;
	trigger?: string;
	actions?: string;
	enabled?: boolean;
	priority?: number;
}) {
	const updates: Record<string, unknown> = {};
	if (params.name !== undefined) updates.name = params.name;
	if (params.trigger !== undefined) updates.trigger = params.trigger;
	if (params.actions !== undefined) updates.actions = params.actions;
	if (params.enabled !== undefined) updates.enabled = params.enabled ? 1 : 0;
	if (params.priority !== undefined) updates.priority = params.priority;

	await db.update(automationRules).set(updates).where(eq(automationRules.id, params.id));
	return { success: true };
}

export async function deleteAutomationRule(id: string) {
	await db.delete(automationRules).where(eq(automationRules.id, id));
	return { success: true };
}

/** Pre-built automation templates. Read-only, used by the UI. */
export function getAutomationTemplates() {
	return [
		{
			name: "Notify on deploy failure",
			trigger: JSON.stringify({ eventType: "deploy:completed", conditions: [{ field: "status", operator: "equals", value: "error" }] }),
			actions: JSON.stringify([{ type: "reminder", config: { message: "Deploy failed! Check the deploy logs.", priority: 2 } }]),
		},
		{
			name: "Alert when task moves to Done",
			trigger: JSON.stringify({ eventType: "task:moved", conditions: [{ field: "to", operator: "equals", value: "done" }] }),
			actions: JSON.stringify([{ type: "reminder", config: { message: "A task was completed!", priority: 0 } }]),
		},
		{
			name: "Run tests after agent completes",
			trigger: JSON.stringify({ eventType: "agent:completed", conditions: [] }),
			actions: JSON.stringify([{ type: "shell", config: { command: "npm test", timeout: 120000 } }]),
		},
		{
			name: "Post to Discord on deploy success",
			trigger: JSON.stringify({ eventType: "deploy:completed", conditions: [{ field: "status", operator: "equals", value: "success" }] }),
			actions: JSON.stringify([{ type: "send_channel_message", config: { channelId: "", content: "Deploy succeeded!" } }]),
		},
	];
}
