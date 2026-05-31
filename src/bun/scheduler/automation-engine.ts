// src/bun/scheduler/automation-engine.ts
import { db } from "../db";
import { automationRules } from "../db/schema";
import { eq, asc } from "drizzle-orm";
import { executeTask, type TaskType } from "./task-executor";
import { eventBus, type AgentDeskEvent } from "./event-bus";

const MAX_CHAIN_DEPTH = 5;

interface TriggerCondition {
	field: string;
	operator: "equals" | "contains" | "not_equals";
	value: string;
}

interface TriggerConfig {
	eventType: string;
	conditions: TriggerCondition[];
}

interface AutomationAction {
	type: TaskType;
	config: Record<string, unknown>;
}

function matchesCondition(event: AgentDeskEvent, condition: TriggerCondition): boolean {
	const eventRecord = event as unknown as Record<string, unknown>;
	const fieldValue = String(eventRecord[condition.field] ?? "");

	switch (condition.operator) {
		case "equals":
			return fieldValue.toLowerCase() === condition.value.toLowerCase();
		case "contains":
			return fieldValue.toLowerCase().includes(condition.value.toLowerCase());
		case "not_equals":
			return fieldValue.toLowerCase() !== condition.value.toLowerCase();
		default:
			return false;
	}
}

async function evaluateRules(event: AgentDeskEvent, chainDepth: number): Promise<void> {
	if (chainDepth >= MAX_CHAIN_DEPTH) {
		console.warn(`[AutomationEngine] Chain depth ${chainDepth} reached, stopping`);
		return;
	}

	const rules = await db
		.select()
		.from(automationRules)
		.where(eq(automationRules.enabled, 1))
		.orderBy(asc(automationRules.priority));

	for (const rule of rules) {
		const trigger: TriggerConfig = JSON.parse(rule.trigger);
		if (trigger.eventType !== event.type) continue;

		const allMatch = trigger.conditions.every((c) => matchesCondition(event, c));
		if (!allMatch) continue;

		// Rule matches — execute actions
		const actions: AutomationAction[] = JSON.parse(rule.actions);

		for (const action of actions) {
			await executeTask(action.type, action.config);
		}

		// Update lastTriggeredAt
		await db
			.update(automationRules)
			.set({ lastTriggeredAt: new Date().toISOString() })
			.where(eq(automationRules.id, rule.id));

		// Emit completion event for chaining
		eventBus.emit({ type: "automation:completed", ruleId: rule.id, ruleName: rule.name });

		// Evaluate chained rules
		await evaluateRules(
			{ type: "automation:completed", ruleId: rule.id, ruleName: rule.name },
			chainDepth + 1,
		);
	}
}

let listening = false;

export function initAutomationEngine(): void {
	if (listening) return;
	listening = true;

	eventBus.onAny((event) => {
		// Don't re-process automation:completed here — it's handled via chaining
		if (event.type === "automation:completed") return;

		evaluateRules(event, 0).catch((err) => {
			console.error("[AutomationEngine] Error evaluating rules:", err);
		});
	});

	console.log("[AutomationEngine] Listening for events");
}

export function shutdownAutomationEngine(): void {
	eventBus.removeAllListeners();
	listening = false;
}
