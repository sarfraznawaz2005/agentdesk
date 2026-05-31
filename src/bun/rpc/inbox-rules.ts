import { db } from "../db";
import { inboxRules } from "../db/schema";
import { eq, asc } from "drizzle-orm";

interface RuleCondition {
    field: "sender" | "content" | "platform" | "projectId";
    operator: "contains" | "equals" | "matches";
    value: string;
}

interface RuleAction {
    type: "setCategory" | "setPriority" | "markAsRead" | "setProject";
    value: string;
}

interface InboxMessageParams {
    projectId?: string;
    channelId?: string;
    sender: string;
    content: string;
    platform?: string;
    threadId?: string;
    priority?: number;
    category?: string;
}

function matchesCondition(msg: InboxMessageParams, cond: RuleCondition): boolean {
    const fieldValue = (msg[cond.field as keyof InboxMessageParams] as string) || "";
    switch (cond.operator) {
        case "contains": return fieldValue.toLowerCase().includes(cond.value.toLowerCase());
        case "equals": return fieldValue.toLowerCase() === cond.value.toLowerCase();
        case "matches":
            try { return new RegExp(cond.value, "i").test(fieldValue); }
            catch { return false; }
        default: return false;
    }
}

export async function applyInboxRules(msg: InboxMessageParams): Promise<InboxMessageParams & { markAsRead?: boolean }> {
    const rules = await db.select().from(inboxRules)
        .where(eq(inboxRules.enabled, 1))
        .orderBy(asc(inboxRules.priority));

    const result = { ...msg };

    // Built-in: auto-detect priority from keywords
    const content = result.content.toLowerCase();
    if (content.includes("urgent") || content.includes("asap") || content.includes("critical")) {
        result.priority = Math.max(result.priority ?? 0, 1);
    }

    // Apply user rules
    let shouldMarkRead = false;
    for (const rule of rules) {
        try {
            const conditions: RuleCondition[] = JSON.parse(rule.conditions);
            const actions: RuleAction[] = JSON.parse(rule.actions);
            if (!conditions.every(c => matchesCondition(result, c))) continue;
            for (const action of actions) {
                switch (action.type) {
                    case "setCategory": result.category = action.value; break;
                    case "setPriority": result.priority = parseInt(action.value, 10); break;
                    case "setProject": result.projectId = action.value; break;
                    case "markAsRead": shouldMarkRead = true; break;
                }
            }
        } catch {
            // Skip malformed rule — don't crash all inbox writes
            console.warn(`[InboxRules] Skipping rule ${rule.id} — invalid JSON in conditions/actions`);
        }
    }

    if (shouldMarkRead) (result as InboxMessageParams & { markAsRead?: boolean }).markAsRead = true;
    return result;
}

// CRUD
export async function getInboxRulesList(projectId?: string) {
    if (projectId) return db.select().from(inboxRules).where(eq(inboxRules.projectId, projectId));
    return db.select().from(inboxRules);
}

export async function createInboxRule(params: {
    projectId?: string; name: string; conditions: string; actions: string; priority?: number;
}) {
    const id = crypto.randomUUID();
    await db.insert(inboxRules).values({
        id, projectId: params.projectId ?? null, name: params.name,
        conditions: params.conditions, actions: params.actions, priority: params.priority ?? 0,
    });
    return { id };
}

export async function updateInboxRule(params: {
    id: string; name?: string; conditions?: string; actions?: string; enabled?: boolean; priority?: number;
}) {
    const updates: Record<string, unknown> = {};
    if (params.name !== undefined) updates.name = params.name;
    if (params.conditions !== undefined) updates.conditions = params.conditions;
    if (params.actions !== undefined) updates.actions = params.actions;
    if (params.enabled !== undefined) updates.enabled = params.enabled ? 1 : 0;
    if (params.priority !== undefined) updates.priority = params.priority;
    await db.update(inboxRules).set(updates).where(eq(inboxRules.id, params.id));
    return { success: true };
}

export async function deleteInboxRule(id: string) {
    await db.delete(inboxRules).where(eq(inboxRules.id, id));
    return { success: true };
}
