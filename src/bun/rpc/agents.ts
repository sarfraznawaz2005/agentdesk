import { eq, and, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { agents, agentTools } from "../db/schema";
import { isUniqueViolation } from "../db/errors";
import { logAudit } from "../db/audit";
import { getToolDefinitions, clearToolCache } from "../agents/tools/index";

export interface AgentListItem {
	id: string;
	name: string;
	displayName: string;
	color: string;
	isBuiltin: boolean;
	systemPrompt: string;
	providerId: string | null;
	modelId: string | null;
	temperature: string | null;
	maxTokens: number | null;
	isEnabled: boolean;
	thinkingBudget: string | null;
	useSystemPromptOnly: boolean;
	chatEnabled: boolean;
	availableToPm: boolean;
}

/**
 * Return all agents, mapping the integer isBuiltin column to a boolean.
 * Sorted alphabetically by displayName.
 */
export async function getAgentsList(): Promise<AgentListItem[]> {
	// playground-agent, issue-fixer, freelance-expert are page-exclusive built-ins — never shown/managed in the Agents UI.
	const rows = (await db.select().from(agents)).filter(
		(row) => row.name !== "playground-agent" && row.name !== "issue-fixer" && row.name !== "freelance-expert",
	);
	const mapped = rows.map((row) => ({
		id: row.id,
		name: row.name,
		displayName: row.displayName,
		color: row.color,
		isBuiltin: row.isBuiltin === 1,
		systemPrompt: row.systemPrompt,
		providerId: row.providerId ?? null,
		modelId: row.modelId ?? null,
		temperature: row.temperature ?? null,
		maxTokens: row.maxTokens ?? null,
		isEnabled: row.isEnabled === 1,
		thinkingBudget: row.thinkingBudget ?? null,
		useSystemPromptOnly: row.useSystemPromptOnly === 1,
		chatEnabled: row.chatEnabled === 1,
		availableToPm: row.availableToPm === 1,
	}));
	return mapped.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Update mutable fields on an agent by id.
 */
export async function updateAgent(params: {
	id: string;
	displayName?: string;
	color?: string;
	systemPrompt?: string;
	providerId?: string;
	modelId?: string;
	temperature?: string;
	maxTokens?: number;
	isEnabled?: boolean;
	thinkingBudget?: string | null;
	useSystemPromptOnly?: boolean;
	chatEnabled?: boolean;
	availableToPm?: boolean;
}): Promise<{ success: boolean; error?: string }> {
	// Reject a display-name change that collides (case-insensitive) with a DIFFERENT agent.
	// (The internal name/slug is immutable after creation, so only displayName can change.)
	if (params.displayName !== undefined) {
		const trimmedDisplay = params.displayName.trim();
		const dupe = await db
			.select({ id: agents.id })
			.from(agents)
			.where(and(sql`lower(${agents.displayName}) = lower(${trimmedDisplay})`, ne(agents.id, params.id)))
			.limit(1);
		if (dupe.length > 0) {
			return { success: false, error: `Another agent already uses the display name "${trimmedDisplay}". Please choose a different one.` };
		}
	}

	const updates: Record<string, unknown> = {};
	// Boolean columns stored as INTEGER 0/1 — convert explicitly for clarity.
	const BOOL_TO_INT = new Set(["isEnabled", "useSystemPromptOnly", "chatEnabled", "availableToPm"]);
	for (const [key, value] of Object.entries(params)) {
		if (key === "id" || value === undefined) continue;
		updates[key] = BOOL_TO_INT.has(key) ? (value ? 1 : 0) : value;
	}
	try {
		await db.update(agents).set(updates).where(eq(agents.id, params.id));
	} catch (err) {
		// Atomic backstop for the display-name pre-check race (v51 unique index).
		if (isUniqueViolation(err) && params.displayName !== undefined) {
			return { success: false, error: `Another agent already uses the display name "${params.displayName.trim()}". Please choose a different one.` };
		}
		throw err;
	}
	logAudit({ action: "agent.update", entityType: "agent", entityId: params.id });
	return { success: true };
}

/**
 * Reset a built-in agent's overrides back to defaults.
 * Only works for agents where isBuiltin = 1.
 */
export async function resetAgent(id: string): Promise<{ success: boolean; error?: string }> {
	const agent = await db.select().from(agents).where(eq(agents.id, id));
	if (!agent[0] || !agent[0].isBuiltin) {
		return { success: false, error: "Not a built-in agent" };
	}
	await db
		.update(agents)
		.set({
			systemPrompt: "",
			providerId: null,
			modelId: null,
			temperature: null,
			maxTokens: null,
			isEnabled: 1,
			thinkingBudget: null,
		})
		.where(eq(agents.id, id));
	return { success: true };
}

// Tools auto-enabled for newly created custom agents. The user can untick
// any of these (or enable others) via Settings → Agents → Tools tab. These
// defaults give custom agents the read-only skills/web utilities most assistant-
// style agents need without exposing destructive operations like git/shell.
const DEFAULT_CUSTOM_AGENT_TOOLS = [
	"web_search",
	"web_fetch",
	"http_request",
	"enhanced_web_search",
	"sleep",
	"read_skill",
	"read_skill_file",
	"find_skills",
	// Lets a new custom agent ask the user a question via the modal dialog by default.
	"request_human_input",
	// Memory: new custom agents can remember per-project learnings and user
	// "remember this" requests out of the box.
	"save_memory",
	"recall_memory",
	"delete_memory",
];

/**
 * Create a new custom agent.
 */
export async function createAgent(params: {
	name: string;
	displayName: string;
	color: string;
	systemPrompt: string;
	providerId?: string;
	modelId?: string;
	useSystemPromptOnly?: boolean;
	chatEnabled?: boolean;
	availableToPm?: boolean;
}): Promise<{ success: boolean; id?: string; error?: string }> {
	// Reject duplicates (case-insensitive) against ALL agents — including built-in and
	// hidden ones — so names/display names stay unique across the whole roster.
	const trimmedName = params.name.trim();
	const trimmedDisplay = params.displayName.trim();
	const nameDupe = await db
		.select({ id: agents.id })
		.from(agents)
		.where(sql`lower(${agents.name}) = lower(${trimmedName})`)
		.limit(1);
	if (nameDupe.length > 0) {
		return { success: false, error: `An agent with the name "${trimmedName}" already exists. Please choose a different Name (slug).` };
	}
	const displayDupe = await db
		.select({ id: agents.id })
		.from(agents)
		.where(sql`lower(${agents.displayName}) = lower(${trimmedDisplay})`)
		.limit(1);
	if (displayDupe.length > 0) {
		return { success: false, error: `An agent with the display name "${trimmedDisplay}" already exists. Please choose a different Display Name.` };
	}

	const id = crypto.randomUUID();
	try {
		await db.insert(agents).values({
			id,
			name: params.name,
			displayName: params.displayName,
			color: params.color,
			systemPrompt: params.systemPrompt,
			isBuiltin: 0,
			providerId: params.providerId ?? null,
			modelId: params.modelId ?? null,
			useSystemPromptOnly: params.useSystemPromptOnly ? 1 : 0,
			chatEnabled: params.chatEnabled ? 1 : 0,
			// Default true when omitted — matches historical "always visible" behavior
			// and saves users from having to flip it on for every newly created agent.
			availableToPm: params.availableToPm === false ? 0 : 1,
		});
	} catch (err) {
		// The pre-checks above aren't atomic with this insert; a concurrent create
		// can still trip the case-insensitive UNIQUE index (v51). Translate it into
		// the same friendly message — the index names the offending column.
		if (isUniqueViolation(err)) {
			const msg = err instanceof Error ? err.message : "";
			return /display_name/i.test(msg)
				? { success: false, error: `An agent with the display name "${trimmedDisplay}" already exists. Please choose a different Display Name.` }
				: { success: false, error: `An agent with the name "${trimmedName}" already exists. Please choose a different Name (slug).` };
		}
		throw err;
	}

	// Seed the default tool set. If the caller (UI's "Copy Tools From" flow)
	// later issues setAgentTools, it will replace these rows wholesale.
	await db.insert(agentTools).values(
		DEFAULT_CUSTOM_AGENT_TOOLS.map((toolName) => ({
			id: crypto.randomUUID(),
			agentId: id,
			toolName,
			isEnabled: 1 as const,
		})),
	);

	logAudit({ action: "agent.create", entityType: "agent", entityId: id, details: { name: params.name, displayName: params.displayName } });
	return { success: true, id };
}

/**
 * Delete a custom (non-built-in) agent by id.
 */
export async function deleteAgent(id: string): Promise<{ success: boolean; error?: string }> {
	const agent = await db.select().from(agents).where(eq(agents.id, id));
	if (!agent[0] || agent[0].isBuiltin === 1) {
		return { success: false, error: "Cannot delete built-in agents" };
	}
	await db.delete(agentTools).where(eq(agentTools.agentId, id));
	await db.delete(agents).where(eq(agents.id, id));
	logAudit({ action: "agent.delete", entityType: "agent", entityId: id });
	return { success: true };
}

// ---------------------------------------------------------------------------
// Agent Tools CRUD
// ---------------------------------------------------------------------------

/**
 * Get tool assignments for an agent.
 */
export async function getAgentToolsList(agentId: string): Promise<Array<{ toolName: string; isEnabled: boolean }>> {
	const rows = await db
		.select({ toolName: agentTools.toolName, isEnabled: agentTools.isEnabled })
		.from(agentTools)
		.where(eq(agentTools.agentId, agentId));
	return rows.map((r) => ({ toolName: r.toolName, isEnabled: r.isEnabled === 1 }));
}

/**
 * Replace all tool assignments for an agent.
 * Clears the tool config cache so the next getToolsForAgent() picks up changes.
 */
export async function setAgentToolsList(
	agentId: string,
	tools: Array<{ toolName: string; isEnabled: boolean }>,
): Promise<{ success: boolean }> {
	// Look up agent name for cache invalidation
	const agentRows = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
	const agentName = agentRows[0]?.name;

	// Delete existing rows and insert new ones
	await db.delete(agentTools).where(eq(agentTools.agentId, agentId));
	if (tools.length > 0) {
		const rows = tools.map((t) => ({
			id: crypto.randomUUID(),
			agentId,
			toolName: t.toolName,
			isEnabled: t.isEnabled ? (1 as const) : (0 as const),
		}));
		await db.insert(agentTools).values(rows);
	}

	// Invalidate cache
	if (agentName) clearToolCache(agentName);

	logAudit({ action: "agent.tools.update", entityType: "agent", entityId: agentId });
	return { success: true };
}

/**
 * Return all registered tool definitions for UI display.
 */
export function getAllToolDefinitions(): Array<{ name: string; category: string; description: string }> {
	return getToolDefinitions();
}

/**
 * Reset agent tools to defaults (re-seed from defaultAgentTools).
 */
export async function resetAgentToolsToDefaults(agentId: string): Promise<{ success: boolean }> {
	const agentRows = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
	const agentName = agentRows[0]?.name;
	if (!agentName) return { success: false };

	// Import default tool mapping from seed
	const { getDefaultAgentTools } = await import("../db/seed");
	const defaultTools = getDefaultAgentTools(agentName);

	await db.delete(agentTools).where(eq(agentTools.agentId, agentId));
	if (defaultTools.length > 0) {
		const rows = defaultTools.map((toolName) => ({
			id: crypto.randomUUID(),
			agentId,
			toolName,
			isEnabled: 1 as const,
		}));
		await db.insert(agentTools).values(rows);
	}

	clearToolCache(agentName);
	logAudit({ action: "agent.tools.reset", entityType: "agent", entityId: agentId });
	return { success: true };
}
