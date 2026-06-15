// src/bun/channels/manager.ts
//
// Module-level singleton that manages channel adapters across all platforms.
// Responsibilities:
//   - Registry of adapter factories (one factory per platform)
//   - On init: load all enabled channel configs from DB and connect adapters
//   - Route incoming messages: write to inbox → forward to AgentEngine
//   - Outbound: sendMessage delegates to the appropriate connected adapter
//   - Lifecycle: getStatuses, shutdown

import { eq, asc, and, sql } from "drizzle-orm";
import { db } from "../db";
import { channels, conversations, projects, settings } from "../db/schema";
import { writeInboxMessage } from "../rpc/inbox";
import { sendNativeNotification } from "../notifications/native";
import { getSetting } from "../rpc/settings";
import { eventBus } from "../scheduler";
import { broadcastToWebview } from "../engine-manager";
import type { AgentEngine } from "../agents/engine";
import type {
	ChannelAdapter,
	ChannelConfig,
	ChannelPlatform,
	ConnectionStatus,
	IncomingMessage,
	SendOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A factory that produces a fresh ChannelAdapter instance for a given platform. */
export type AdapterFactory = () => ChannelAdapter;

/**
 * Callback signature expected by initChannelManager.
 * Returns an AgentEngine for the given projectId, creating one if needed.
 */
export type GetOrCreateEngine = (projectId: string) => AgentEngine;

/** Status snapshot returned by getChannelStatuses(). */
export interface ChannelStatus {
	channelId: string;
	platform: ChannelPlatform;
	status: ConnectionStatus;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Map of platform → factory function */
const adapterFactories = new Map<ChannelPlatform, AdapterFactory>();

/** Map of channelId → live adapter instance */
const activeAdapters = new Map<string, ChannelAdapter>();

/** Channels currently mid-connect — prevents concurrent connectSingleChannel calls */
const connectingChannels = new Set<string>();

/** Map of channelId → ChannelConfig (retained for routing) */
const channelConfigs = new Map<string, ChannelConfig>();

/** Cached reference to the engine resolver set during init */
let engineResolver: GetOrCreateEngine | null = null;

/** Last inbound message context per channel — used to attach threading/subject to outbound replies. */
const lastInboundContext = new Map<string, { threadId?: string; subject?: string; senderId: string; msgChannelId?: string }>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a factory for a given platform. Must be called before
 * initChannelManager so that the factory is available when configs are loaded.
 */
export function registerAdapter(
	platform: ChannelPlatform,
	factory: AdapterFactory,
): void {
	adapterFactories.set(platform, factory);
}

/**
 * Load all enabled channel configs from the database, connect each one using
 * its registered adapter factory, and wire up the incoming-message handler.
 *
 * @param getOrCreateEngine - Returns the AgentEngine for a given projectId.
 *   Called lazily per incoming message so engines are only created when needed.
 */
export async function initChannelManager(
	getOrCreateEngine: GetOrCreateEngine,
): Promise<void> {
	engineResolver = getOrCreateEngine;

	const rows = await db
		.select()
		.from(channels)
		.where(eq(channels.enabled, 1));

	for (const row of rows) {
		const platform = row.platform as ChannelPlatform;
		const factory = adapterFactories.get(platform);

		if (!factory) {
			console.warn(
				`[ChannelManager] No adapter factory registered for platform "${platform}" (channel ${row.id}). Skipping.`,
			);
			continue;
		}

		const config: ChannelConfig = {
			id: row.id,
			projectId: row.projectId ?? null,
			platform,
			config: parseJsonConfig(row.config),
			enabled: row.enabled === 1,
		};

		const adapter = factory();

		// Wire QR callback so the UI receives it even on startup reconnect
		if (platform === "whatsapp") {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(adapter as any).onQR?.((qr: string) => {
				broadcastQR(row.id, qr);
			});
		}

		try {
			await adapter.connect(config);
		} catch (err) {
			console.error(
				`[ChannelManager] Failed to connect adapter for channel ${row.id} (${platform}):`,
				err,
			);
			continue;
		}

		adapter.onMessage((msg: IncomingMessage) => {
			handleIncomingMessage(msg, config).catch((err) => {
				console.error(
					`[ChannelManager] Error handling incoming message on channel ${row.id}:`,
					err,
				);
			});
		});

		activeAdapters.set(row.id, adapter);
		channelConfigs.set(row.id, config);

		console.log(
			`[ChannelManager] Connected channel ${row.id} (${platform}).`,
		);
	}
}

/**
 * Send an outbound message through the adapter associated with channelId.
 * Automatically attaches reply/threading context from the last inbound message.
 * Throws if no adapter is connected for the given channelId.
 */
export async function sendChannelMessage(
	channelId: string,
	content: string,
): Promise<void> {
	const adapter = activeAdapters.get(channelId);
	if (!adapter) {
		throw new Error(
			`[ChannelManager] No active adapter for channel "${channelId}".`,
		);
	}

	// Attach reply context from the last inbound message for this channel
	const ctx = lastInboundContext.get(channelId);
	const options: SendOptions = {};
	if (ctx) {
		if (ctx.threadId) options.replyToMessageId = ctx.threadId;
		if (ctx.subject) options.subject = `Re: ${ctx.subject.replace(/^Re:\s*/i, "")}`;
	}

	// Determine the outbound recipient:
	// - Discord: reply to the originating channel snowflake (msgChannelId), not the username
	// - WhatsApp/Email: reply to the sender JID/address (senderId)
	const recipient = ctx?.msgChannelId ?? ctx?.senderId ?? channelId;

	// WhatsApp: prefix AI replies with a label so they're visually distinguishable
	// from the user's own messages (both appear as sent-by-you green bubbles).
	const config = channelConfigs.get(channelId);
	const outboundContent = config?.platform === "whatsapp"
		? `🤖 *AgentDesk PM:*\n${content}`
		: content;

	await adapter.sendMessage(recipient, outboundContent, options);
}

/**
 * Broadcast a task-done notification to all connected channels.
 *
 * - Discord: always sends to the configured channel snowflake.
 * - WhatsApp / Email: only sends if there is a prior inbound context
 *   (i.e. someone has messaged us from that channel), so we have a
 *   recipient address/JID to reply to.
 *
 * Silently skips channels that are not in "connected" status.
 */
export async function broadcastTaskDoneNotification(taskTitle: string, projectName?: string): Promise<void> {
	const enabled = await getSetting("task_done_channel_notify", "notifications");
	if (enabled !== null && String(enabled) === "false") return;

	const label = projectName ? `[${projectName}] ` : "";
	const text = `${label}✅ Task done: ${taskTitle}`;

	for (const [channelId, adapter] of activeAdapters) {
		if (adapter.getStatus() !== "connected") continue;

		const config = channelConfigs.get(channelId);
		if (!config) continue;

		try {
			if (config.platform === "discord") {
				// Discord: send to the configured channel snowflake stored in config
				const discordChannelId = (config.config as { channelId?: string }).channelId;
				if (discordChannelId) {
					await adapter.sendMessage(discordChannelId, text);
				}
			} else {
				// WhatsApp: send to self JID (the linked phone number)
				// Email: only send if we have an inbound context (need a reply-to address)
				const defaultRecipient = adapter.getDefaultRecipient?.() ?? null;
				const ctx = lastInboundContext.get(channelId);
				const recipient = defaultRecipient ?? ctx?.msgChannelId ?? ctx?.senderId;
				if (!recipient) continue;
				const outbound = config.platform === "whatsapp" ? `🤖 *AgentDesk PM:*\n${text}` : text;
				await adapter.sendMessage(recipient, outbound);
			}
		} catch (err) {
			console.warn(`[ChannelManager] broadcastTaskDoneNotification failed for channel ${channelId}:`, err);
		}
	}
}

/**
 * Broadcast the result of a scheduled agent task to all connected channels.
 * Models after broadcastTaskDoneNotification — Discord uses configured channel,
 * WhatsApp/Email use inbound context or default recipient.
 */
export async function broadcastSchedulerResult(jobName: string, result: string): Promise<void> {
	const text = `🤖 *${jobName}*\n${result}`;

	for (const [channelId, adapter] of activeAdapters) {
		if (adapter.getStatus() !== "connected") continue;

		const config = channelConfigs.get(channelId);
		if (!config) continue;

		try {
			if (config.platform === "discord") {
				const discordChannelId = (config.config as { channelId?: string }).channelId;
				if (discordChannelId) {
					await adapter.sendMessage(discordChannelId, text);
				}
			} else {
				const defaultRecipient = adapter.getDefaultRecipient?.() ?? null;
				const ctx = lastInboundContext.get(channelId);
				const recipient = defaultRecipient ?? ctx?.msgChannelId ?? ctx?.senderId;
				if (!recipient) continue;
				const outbound = config.platform === "whatsapp" ? text : result;
				await adapter.sendMessage(recipient, outbound);
			}
		} catch (err) {
			console.warn(`[ChannelManager] broadcastSchedulerResult failed for channel ${channelId}:`, err);
		}
	}
}

/**
 * Return a snapshot of connection statuses for every connected adapter.
 */
export function getChannelStatuses(): ChannelStatus[] {
	const statuses: ChannelStatus[] = [];

	for (const [channelId, adapter] of activeAdapters) {
		const config = channelConfigs.get(channelId);
		statuses.push({
			channelId,
			platform: config?.platform ?? adapter.platform,
			status: adapter.getStatus(),
		});
	}

	return statuses;
}

/**
 * Get the real-time connection status of a single adapter.
 * Returns null if no adapter is connected for the given channelId.
 */
export function getAdapterStatus(channelId: string): ConnectionStatus | null {
	const adapter = activeAdapters.get(channelId);
	return adapter ? adapter.getStatus() : null;
}

/**
 * Return the platform for a connected channel, or null if unknown.
 */
export function getChannelPlatform(channelId: string): ChannelPlatform | null {
	return channelConfigs.get(channelId)?.platform ?? null;
}

/**
 * Get or create a channel conversation in the given project with the standard
 * `Platform - YYYY-MM-DD` title format.
 *
 * Uses a composite ID `channel:{channelId}:{projectId}:{date}` so conversations
 * in different projects for the same channel never collide.
 *
 * Exported for use by cross-project agent dispatch in pm-tools.ts.
 */
export async function getOrCreateProjectChannelConversation(
	projectId: string,
	channelId: string,
	platform: ChannelPlatform,
): Promise<string> {
	const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);
	const dateStr = new Date().toISOString().slice(0, 10);
	const title = `${platformLabel} - ${dateStr}`;

	// Composite ID: channel + target project + date — unique per project per day
	const conversationId = `channel:${channelId}:${projectId}:${dateStr}`;
	const now = new Date().toISOString();

	// Single upsert: insert today's conversation or bump updatedAt if it already exists
	await db.insert(conversations).values({
		id: conversationId,
		projectId,
		title,
		createdAt: now,
		updatedAt: now,
	}).onConflictDoUpdate({
		target: conversations.id,
		set: { updatedAt: now },
	});

	broadcastToWebview("conversationUpdated", { conversationId, updatedAt: now, projectId });
	return conversationId;
}

/**
 * Disconnect a single active adapter by channel ID.
 * No-op if no adapter is connected for the given channelId.
 *
 * Pass `{ logout: true }` to permanently unlink the platform session (WhatsApp device
 * unlink) instead of merely closing the socket — used on delete, never on transient
 * teardown (reconnect/shutdown), which must keep the session reusable.
 */
export async function disconnectChannel(channelId: string, opts?: { logout?: boolean }): Promise<void> {
	const adapter = activeAdapters.get(channelId);
	if (!adapter) return;
	try {
		if (opts?.logout && adapter.logout) await adapter.logout();
		else await adapter.disconnect();
	} catch { /* ignore */ }
	activeAdapters.delete(channelId);
	channelConfigs.delete(channelId);
	// Drop any stashed reply-routing context so a deleted channel can't be replied to.
	lastInboundContext.delete(channelId);
	console.log(`[ChannelManager] Disconnected channel ${channelId}.`);
}

/**
 * Connect a single channel by ID — loads config from DB, creates adapter,
 * wires message + QR handlers, and stores it in the active adapters map.
 * Safe to call after app startup (e.g. when a new config is saved).
 */
export async function connectSingleChannel(channelId: string): Promise<void> {
	// Guard against concurrent calls for the same channel
	if (connectingChannels.has(channelId)) {
		console.warn(`[ChannelManager] connectSingleChannel already in progress for ${channelId}, skipping`);
		return;
	}
	connectingChannels.add(channelId);
	try {
		await _connectSingleChannel(channelId);
	} finally {
		connectingChannels.delete(channelId);
	}
}

async function _connectSingleChannel(channelId: string): Promise<void> {
	// Disconnect existing adapter for this channel if any
	const existing = activeAdapters.get(channelId);
	if (existing) {
		try { await existing.disconnect(); } catch { /* ignore */ }
		activeAdapters.delete(channelId);
		channelConfigs.delete(channelId);
	}

	const rows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
	if (rows.length === 0) throw new Error(`Channel ${channelId} not found`);

	const row = rows[0];
	const platform = row.platform as ChannelPlatform;
	const factory = adapterFactories.get(platform);
	if (!factory) throw new Error(`No adapter factory for platform "${platform}"`);

	const config: ChannelConfig = {
		id: row.id,
		projectId: row.projectId ?? null,
		platform,
		config: parseJsonConfig(row.config),
		enabled: row.enabled === 1,
	};

	const adapter = factory();

	// Wire QR callback before connecting so we capture the first QR event
	if (platform === "whatsapp") {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(adapter as any).onQR?.((qr: string) => { broadcastQR(channelId, qr).catch(() => {}); });
	}

	await adapter.connect(config);

	adapter.onMessage((msg: IncomingMessage) => {
		handleIncomingMessage(msg, config).catch((err) => {
			console.error(`[ChannelManager] Error handling message on channel ${channelId}:`, err);
		});
	});

	activeAdapters.set(channelId, adapter);
	channelConfigs.set(channelId, config);

	console.log(`[ChannelManager] Dynamically connected channel ${channelId} (${platform}).`);
}

/**
 * Gracefully disconnect all active adapters and clear internal state.
 */
export async function shutdownChannelManager(): Promise<void> {
	const disconnections = Array.from(activeAdapters.entries()).map(
		async ([channelId, adapter]) => {
			try {
				await adapter.disconnect();
				console.log(`[ChannelManager] Disconnected channel ${channelId}.`);
			} catch (err) {
				console.error(
					`[ChannelManager] Error disconnecting channel ${channelId}:`,
					err,
				);
			}
		},
	);

	await Promise.allSettled(disconnections);

	activeAdapters.clear();
	channelConfigs.clear();
	engineResolver = null;
}

// ---------------------------------------------------------------------------
// Internal pipeline
// ---------------------------------------------------------------------------

/**
 * Convert a raw Baileys QR string to a base64 PNG data URL and broadcast it.
 */
async function broadcastQR(channelId: string, qr: string): Promise<void> {
	try {
		const QRCode = await import("qrcode");
		const dataUrl = await QRCode.toDataURL(qr);
		broadcastToWebview("whatsappQR", { channelId, qr: dataUrl });
	} catch (err) {
		console.error("[ChannelManager] Failed to generate QR code image:", err);
	}
}

/**
 * Unified incoming-message pipeline:
 *   1. Write the message to the inbox (persists it for the UI).
 *   2. If the channel is bound to a project, ensure a conversation exists
 *      and forward the message to the AgentEngine.
 */
async function handleIncomingMessage(
	msg: IncomingMessage,
	config: ChannelConfig,
): Promise<void> {
	// Step 1 — persist to inbox
	await writeInboxMessage({
		projectId: config.projectId ?? undefined,
		channelId: config.id,
		sender: msg.senderName || msg.senderId,
		content: msg.content,
		platform: msg.platform,
		threadId: msg.threadId,
	});

	eventBus.emit({ type: "message:received", platform: msg.platform, channelId: config.id, sender: msg.senderName || msg.senderId });

	// Send native OS notification
	await sendNativeNotification({
		platform: msg.platform,
		projectId: msg.metadata?.projectId as string | undefined,
		title: `New message from ${msg.senderName}`,
		body: msg.content.slice(0, 100),
	});

	// Store inbound context for outbound reply threading.
	// msgChannelId is the platform-specific channel/room ID (Discord snowflake, etc.)
	// For Discord this is the channel to reply to; for WhatsApp/email use senderId.
	lastInboundContext.set(config.id, {
		threadId: msg.threadId,
		subject: (msg.metadata?.subject as string) ?? undefined,
		senderId: msg.senderId,
		msgChannelId: msg.platform === "discord" ? msg.channelId : undefined,
	});

	// Step 2 — route to engine.
	// Priority: channel.projectId (bound mode) → default_channel_project_id setting (explicit
	// override) → dedicated per-platform "<Platform> Chat" project (global mode, auto-created
	// + reused). A first-project safety net only triggers if the chat project can't be created,
	// so an inbound message is never dropped.
	if (!engineResolver) return;

	let routingProjectId = config.projectId;

	if (!routingProjectId) {
		const defaultRow = await db
			.select({ value: settings.value })
			.from(settings)
			.where(eq(settings.key, "default_channel_project_id"))
			.limit(1);
		if (defaultRow.length > 0) {
			try { routingProjectId = JSON.parse(defaultRow[0].value) as string; }
			catch { routingProjectId = defaultRow[0].value; }
		}
	}

	if (!routingProjectId) {
		// Global mode: route to the dedicated per-platform chat project (created on first use).
		routingProjectId = await getOrCreateGlobalChannelProject(msg.platform);
	}

	if (!routingProjectId) {
		// Safety net — only reached if the chat project couldn't be created (e.g. no global
		// workspace configured). Route to the first project so the message isn't lost.
		const firstProject = await db.select({ id: projects.id }).from(projects)
			.orderBy(asc(projects.createdAt)).limit(1);
		if (firstProject.length > 0) routingProjectId = firstProject[0].id;
	}

	if (!routingProjectId) return;

	const engine = engineResolver(routingProjectId);

	// Prefix the content with platform context so the agent has full visibility
	const platformPrefix = `[${msg.platform}${msg.threadId ? ` thread:${msg.threadId}` : ""}] ${msg.senderName || msg.senderId}: `;
	const enrichedContent = `${platformPrefix}${msg.content}`;

	// Ensure a conversation row exists in the DB. Channel messages get a
	// persistent conversation per channel (or per thread) so that the FK
	// on the messages table is satisfied and the conversation appears in
	// the sidebar for the user to review.
	const conversationId = await getOrCreateChannelConversation(
		routingProjectId,
		config.id,
		msg.platform,
		msg.threadId,
	);

	// Map platform name to a recognised source type
	const sourceMap: Record<string, "discord" | "whatsapp" | "email"> = {
		discord: "discord",
		whatsapp: "whatsapp",
		email: "email",
	};

	try {
		await engine.sendMessage(conversationId, enrichedContent, {
			source: sourceMap[msg.platform] ?? "discord",
			channelId: config.id,   // config UUID — used by engine-manager to look up adapter
			username: msg.senderName || msg.senderId,
		});
	} catch (err) {
		console.error(`[ChannelManager] AgentEngine.sendMessage failed for channel ${config.id}:`, err);
	}
}

// Human-friendly platform names for the auto-created global-mode chat project.
const PLATFORM_DISPLAY_NAME: Record<ChannelPlatform, string> = {
	discord: "Discord",
	whatsapp: "WhatsApp",
	email: "Email",
	chat: "Chat",
};

/**
 * Resolve the project that a GLOBAL-mode channel (no bound `projectId`) routes to:
 * a dedicated per-platform "<Platform> Chat" project (e.g. "WhatsApp Chat"), created on
 * first use and reused thereafter. All global-mode channels of the same platform share
 * this one project, so channel conversations get a predictable, self-describing home
 * instead of silently landing in whatever project happens to be oldest.
 *
 * Returns the project id, or null if it could not be found or created (e.g. no global
 * workspace path is configured) — the caller then applies a last-ditch safety fallback
 * so an inbound message is never dropped.
 */
async function getOrCreateGlobalChannelProject(platform: ChannelPlatform): Promise<string | null> {
	const name = `${PLATFORM_DISPLAY_NAME[platform] ?? platform} Chat`;

	// Reuse an existing project with this name (case-insensitive — mirrors the duplicate-name
	// rule in createProjectHandler so we never try to create a colliding one).
	const findByName = async (): Promise<string | null> => {
		const rows = await db.select({ id: projects.id }).from(projects)
			.where(sql`lower(${projects.name}) = lower(${name})`).limit(1);
		return rows.length > 0 ? rows[0].id : null;
	};

	const existing = await findByName();
	if (existing) return existing;

	// Create it — workspace path is derived from the global_workspace_path setting.
	try {
		const { createProjectHandler } = await import("../rpc/projects");
		const result = await createProjectHandler({
			name,
			description: `Conversations from the ${PLATFORM_DISPLAY_NAME[platform] ?? platform} channel (global mode).`,
		});
		if (result.success) return result.id;
		// A concurrent inbound message may have created it between our check and now;
		// re-read by name before giving up.
		const raced = await findByName();
		if (raced) return raced;
		console.warn(`[ChannelManager] Could not create "${name}" project: ${result.error ?? "unknown error"}`);
		return null;
	} catch (err) {
		console.error(`[ChannelManager] Error creating global channel project "${name}":`, err);
		return null;
	}
}

/**
 * Get or create a daily conversation for a channel.
 * Title format: "WhatsApp - 2026-04-06" (Channel Name - Date, no time).
 * Reuses an existing conversation if one with a matching title already exists
 * for the project today. Creates a new one otherwise.
 * New conversations use a `channel:` prefixed ID so the backend can detect
 * channel-sourced conversations for routing and plan-approval logic.
 */
async function getOrCreateChannelConversation(
	projectId: string,
	channelId: string,
	platform: ChannelPlatform,
	_threadId?: string,
): Promise<string> {
	const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);
	const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
	const title = `${platformLabel} - ${dateStr}`;

	// Look for an existing conversation with this title in the project (today's conv)
	const existing = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(and(
			eq(conversations.projectId, projectId),
			eq(conversations.title, title),
			eq(conversations.isArchived, 0),
		))
		.limit(1);

	if (existing.length > 0) {
		const now = new Date().toISOString();
		// Bump updatedAt so it sorts to the top of the sidebar
		await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, existing[0].id));
		broadcastToWebview("conversationUpdated", {
			conversationId: existing[0].id,
			updatedAt: now,
			projectId,
		});
		return existing[0].id;
	}

	// Create a new daily conversation. Include projectId in the ID so that the
	// same channel used across multiple projects never produces conflicting IDs.
	const conversationId = `channel:${channelId}:${projectId}:${dateStr}`;
	const now = new Date().toISOString();
	await db.insert(conversations).values({
		id: conversationId,
		projectId,
		title,
		createdAt: now,
		updatedAt: now,
	}).onConflictDoNothing();

	// Notify frontend so the conversation appears in the sidebar immediately
	broadcastToWebview("conversationUpdated", {
		conversationId,
		updatedAt: now,
		projectId,
	});

	return conversationId;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonConfig(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Fall through to empty object
	}
	return {};
}
