import { db } from "../db";
import { channels } from "../db/schema";
import { eq } from "drizzle-orm";
import type { BotStatus } from "../discord/bot";

// Status getter is injected after discord bot initialisation to avoid circular imports.
let _discordStatusGetter: (() => { status: BotStatus }) | null = null;

export function setDiscordStatusGetter(getter: () => { status: BotStatus }): void {
	_discordStatusGetter = getter;
}

export async function getDiscordConfigs() {
	return db.select().from(channels).where(eq(channels.platform, "discord"));
}

export async function saveDiscordConfig(params: {
	id?: string;
	projectId?: string;
	token: string;
	serverId: string;
	channelId: string;
	enabled?: boolean;
}) {
	const config = JSON.stringify({
		token: params.token,
		serverId: params.serverId,
		channelId: params.channelId,
	});

	let savedId: string;

	if (params.id) {
		await db.update(channels).set({
			projectId: params.projectId ?? null,
			config,
			enabled: params.enabled ? 1 : 0,
			updatedAt: new Date().toISOString(),
		}).where(eq(channels.id, params.id));
		savedId = params.id;
	} else {
		savedId = crypto.randomUUID();
		await db.insert(channels).values({
			id: savedId,
			projectId: params.projectId ?? null,
			platform: "discord",
			config,
			enabled: params.enabled ? 1 : 0,
		});
	}

	// Connect or disconnect the adapter immediately based on enabled flag
	const { connectSingleChannel, disconnectChannel } = await import("../channels/manager");
	if (params.enabled) {
		connectSingleChannel(savedId).catch((err) => {
			console.error(`[discord] Failed to connect channel ${savedId} after save:`, err);
		});
	} else {
		disconnectChannel(savedId).catch(() => {});
	}

	return { success: true, id: savedId };
}

export async function deleteDiscordConfig(id: string) {
	await db.delete(channels).where(eq(channels.id, id));
	return { success: true };
}

export async function testDiscordConnection(token: string) {
	try {
		const res = await fetch("https://discord.com/api/v10/users/@me", {
			headers: { Authorization: `Bot ${token}` },
		});
		if (!res.ok) return { success: false, error: "Invalid token" };
		const user = await res.json();

		// Get guilds
		const guildsRes = await fetch("https://discord.com/api/v10/users/@me/guilds", {
			headers: { Authorization: `Bot ${token}` },
		});
		const guilds = guildsRes.ok ? await guildsRes.json() : [];

		return {
			success: true,
			botName: user.username,
			servers: guilds.map((g: { id: string; name: string }) => ({ id: g.id, name: g.name })),
		};
	} catch (err) {
		return { success: false, error: String(err) };
	}
}

export function getDiscordStatus() {
	return _discordStatusGetter ? _discordStatusGetter() : { status: "disconnected" as const };
}
