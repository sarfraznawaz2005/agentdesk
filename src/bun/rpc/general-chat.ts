// ---------------------------------------------------------------------------
// General Chat RPC handlers
// ---------------------------------------------------------------------------

import { eq, and, asc, desc } from "drizzle-orm";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { generalChatConversations, generalChatMessages } from "../db/schema";
import {
	sendMessage as orchestratorSendMessage,
	stopGeneralChatGeneration as orchestratorStop,
	isGeneralChatRunning,
	compactConversation,
	resolveProviderConfig,
} from "../general-chat/orchestrator";
import { getContextLimit } from "../providers/models";
import type { GeneralChatConversationDto, GeneralChatMessageDto } from "../../shared/rpc/general-chat";

function mapConversation(row: typeof generalChatConversations.$inferSelect): GeneralChatConversationDto {
	return {
		id: row.id,
		title: row.title,
		isPinned: row.isPinned === 1,
		isArchived: row.isArchived === 1,
		deepResearchMode: row.deepResearchMode === 1,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapMessage(row: typeof generalChatMessages.$inferSelect): GeneralChatMessageDto {
	return {
		id: row.id,
		conversationId: row.conversationId,
		role: row.role as "user" | "assistant",
		content: row.content,
		tokenCount: row.tokenCount,
		metadata: row.metadata,
		createdAt: row.createdAt,
	};
}

export async function listGeneralChatConversations(): Promise<GeneralChatConversationDto[]> {
	const rows = await db
		.select()
		.from(generalChatConversations)
		.where(eq(generalChatConversations.isArchived, 0))
		.orderBy(desc(generalChatConversations.updatedAt));
	return rows.map(mapConversation);
}

export async function listArchivedGeneralChatConversations(): Promise<GeneralChatConversationDto[]> {
	const rows = await db
		.select()
		.from(generalChatConversations)
		.where(eq(generalChatConversations.isArchived, 1))
		.orderBy(desc(generalChatConversations.updatedAt));
	return rows.map(mapConversation);
}

/**
 * Create a new conversation. If a non-archived, non-pinned, empty "New
 * conversation" already exists, reuse it (bump updatedAt) instead of creating
 * a duplicate — mirrors createConversation's behavior for project chat.
 */
export async function createGeneralChatConversation(params: { title?: string }): Promise<{ id: string; title: string }> {
	if (!params.title) {
		const candidates = await db
			.select({ id: generalChatConversations.id, title: generalChatConversations.title })
			.from(generalChatConversations)
			.where(
				and(
					eq(generalChatConversations.isArchived, 0),
					eq(generalChatConversations.isPinned, 0),
					eq(generalChatConversations.title, "New conversation"),
				),
			);
		for (const candidate of candidates) {
			const msgCount = await db
				.select({ id: generalChatMessages.id })
				.from(generalChatMessages)
				.where(eq(generalChatMessages.conversationId, candidate.id))
				.limit(1);
			if (msgCount.length === 0) {
				const now = new Date().toISOString();
				await db.update(generalChatConversations).set({ updatedAt: now }).where(eq(generalChatConversations.id, candidate.id));
				return { id: candidate.id, title: candidate.title };
			}
		}
	}

	const id = crypto.randomUUID();
	const title = params.title ?? "New conversation";
	const now = new Date().toISOString();
	await db.insert(generalChatConversations).values({ id, title, createdAt: now, updatedAt: now });
	return { id, title };
}

export async function renameGeneralChatConversation(params: { id: string; title: string }): Promise<{ success: boolean }> {
	await db
		.update(generalChatConversations)
		.set({ title: params.title, updatedAt: new Date().toISOString() })
		.where(eq(generalChatConversations.id, params.id));
	return { success: true };
}

export async function deleteGeneralChatConversation(params: { id: string }): Promise<{ success: boolean }> {
	if (isGeneralChatRunning(params.id)) orchestratorStop(params.id);
	await db.delete(generalChatMessages).where(eq(generalChatMessages.conversationId, params.id));
	await db.delete(generalChatConversations).where(eq(generalChatConversations.id, params.id));
	// The orchestrator passes conversationId as runInlineAgent's projectId, so
	// ModelSelector (general-chat.tsx) persists chatModelId/chatProviderId/
	// shellApprovalMode/planMode under project:<id>:* the same way a real
	// project's settings are stored (see saveProjectSetting) — clean those up
	// too, mirroring deleteProject's own settings cleanup, so deleted
	// conversations don't leave orphaned settings rows behind.
	sqlite.prepare("DELETE FROM settings WHERE key LIKE 'project:' || ?1 || ':%'").run(params.id);
	return { success: true };
}

export async function pinGeneralChatConversation(params: { id: string; pinned: boolean }): Promise<{ success: boolean }> {
	await db
		.update(generalChatConversations)
		.set({ isPinned: params.pinned ? 1 : 0, updatedAt: new Date().toISOString() })
		.where(eq(generalChatConversations.id, params.id));
	return { success: true };
}

export async function archiveGeneralChatConversation(params: { id: string; archived: boolean }): Promise<{ success: boolean }> {
	await db
		.update(generalChatConversations)
		.set({ isArchived: params.archived ? 1 : 0, updatedAt: new Date().toISOString() })
		.where(eq(generalChatConversations.id, params.id));
	return { success: true };
}

/**
 * Copy a conversation's messages (up to and including upToMessageId, or all
 * messages if omitted) into a brand-new conversation. Flat copy — no parts
 * table to carry over.
 */
export async function forkGeneralChatConversation(params: { id: string; upToMessageId?: string }): Promise<{ id: string; title: string }> {
	const sourceRows = await db.select().from(generalChatConversations).where(eq(generalChatConversations.id, params.id)).limit(1);
	if (sourceRows.length === 0) throw new Error(`No General Chat conversation with id '${params.id}'`);
	const source = sourceRows[0];

	const allMessages = await db
		.select()
		.from(generalChatMessages)
		.where(eq(generalChatMessages.conversationId, params.id))
		.orderBy(asc(generalChatMessages.createdAt));

	const pivotIndex = params.upToMessageId ? allMessages.findIndex((m) => m.id === params.upToMessageId) : -1;
	const messagesToCopy = pivotIndex === -1 ? allMessages : allMessages.slice(0, pivotIndex + 1);

	const newId = crypto.randomUUID();
	const title = `Fork of ${source.title}`;
	const now = new Date().toISOString();
	await db.insert(generalChatConversations).values({
		id: newId,
		title,
		deepResearchMode: source.deepResearchMode,
		createdAt: now,
		updatedAt: now,
	});

	if (messagesToCopy.length > 0) {
		await db.insert(generalChatMessages).values(
			messagesToCopy.map((m) => ({
				conversationId: newId,
				role: m.role,
				content: m.content,
				tokenCount: m.tokenCount,
				metadata: m.metadata,
				createdAt: m.createdAt,
			})),
		);
	}

	return { id: newId, title };
}

export async function getGeneralChatMessages(params: { conversationId: string }): Promise<GeneralChatMessageDto[]> {
	const rows = await db
		.select()
		.from(generalChatMessages)
		.where(eq(generalChatMessages.conversationId, params.conversationId))
		.orderBy(asc(generalChatMessages.createdAt));
	return rows.map(mapMessage);
}

/** Whether a turn is still in flight — lets the page re-derive "still working"
 * state (Stop button, busy indicator) on mount/refresh. */
export function getGeneralChatStatus(params: { conversationId: string }): { isRunning: boolean } {
	return { isRunning: isGeneralChatRunning(params.conversationId) };
}

/** Delete all messages in a conversation without deleting the conversation itself (the /clear slash command). */
export async function clearGeneralChatConversation(params: { id: string }): Promise<{ success: boolean }> {
	if (isGeneralChatRunning(params.id)) orchestratorStop(params.id);
	await db.delete(generalChatMessages).where(eq(generalChatMessages.conversationId, params.id));
	return { success: true };
}

/** Delete a single message — mirrors project chat's deleteMessage (used by the hover action row's Delete button and Retry). */
export async function deleteGeneralChatMessage(params: { id: string }): Promise<{ success: boolean }> {
	await db.delete(generalChatMessages).where(eq(generalChatMessages.id, params.id));
	return { success: true };
}

/** Fire-and-forget — the reply streams via generalChatPart / generalChatComplete broadcasts. */
export function sendGeneralChatMessage(params: { conversationId: string; content: string }): { ok: boolean; error?: string } {
	const content = params.content?.trim();
	if (!content) return { ok: false, error: "Message is empty." };
	if (isGeneralChatRunning(params.conversationId)) {
		return { ok: false, error: "A response is already being generated for this conversation." };
	}
	orchestratorSendMessage(params.conversationId, content).catch((err) => {
		console.error("[general-chat] sendMessage error:", err);
	});
	return { ok: true };
}

export function stopGeneralChatGeneration(params: { conversationId: string }): { success: boolean } {
	orchestratorStop(params.conversationId);
	return { success: true };
}

export async function setGeneralChatDeepResearchMode(params: { conversationId: string; enabled: boolean }): Promise<{ success: boolean }> {
	await db
		.update(generalChatConversations)
		.set({ deepResearchMode: params.enabled ? 1 : 0, updatedAt: new Date().toISOString() })
		.where(eq(generalChatConversations.id, params.conversationId));
	return { success: true };
}

/**
 * Compaction (/compact) — thin wrapper over the orchestrator's own
 * `compactConversation`, which is also called automatically from `sendMessage`
 * once a conversation's context crosses the threshold (mirrors AgentEngine's
 * auto-compaction). Kept in one place so both triggers share the exact same
 * logic and `lastPromptTokens` bookkeeping.
 */
export async function compactGeneralChatConversation(params: { conversationId: string }): Promise<{ success: boolean; message?: string }> {
	return compactConversation(params.conversationId);
}

/**
 * The real context window for the conversation's currently resolved model —
 * the same number sendMessage's own auto-compaction threshold check uses
 * (getContextLimit(modelId, conversationId)). The frontend's context meter
 * calls this on mount and whenever the model selection changes, instead of
 * assuming a flat token limit that doesn't match the actual model.
 */
export async function getGeneralChatContextLimit(params: { conversationId: string }): Promise<{ contextLimit: number; modelId: string }> {
	const { modelId } = await resolveProviderConfig(params.conversationId);
	return { contextLimit: getContextLimit(modelId, params.conversationId), modelId };
}
