import { db } from "../db";
import { channels, whatsappSessions, settings } from "../db/schema";
import { eq } from "drizzle-orm";

export async function getWhatsAppConfigs() {
	return db.select().from(channels).where(eq(channels.platform, "whatsapp"));
}

export async function saveWhatsAppConfig(params: {
	id?: string;
	projectId?: string;
	enabled?: boolean;
}) {
	if (params.id) {
		const updates: Record<string, unknown> = {};
		if (params.projectId !== undefined) updates.projectId = params.projectId;
		if (params.enabled !== undefined) updates.enabled = params.enabled ? 1 : 0;
		updates.updatedAt = new Date().toISOString();
		await db.update(channels).set(updates).where(eq(channels.id, params.id));
		return { success: true, id: params.id };
	}

	const id = crypto.randomUUID();
	await db.insert(channels).values({
		id,
		projectId: params.projectId ?? null,
		platform: "whatsapp",
		config: "{}",
		enabled: params.enabled !== false ? 1 : 0,
	});
	return { success: true, id };
}

export async function deleteWhatsAppConfig(id: string) {
	await db.delete(whatsappSessions).where(eq(whatsappSessions.channelId, id));
	await db.delete(channels).where(eq(channels.id, id));
	return { success: true };
}

export async function getWhatsAppStatus(id: string): Promise<{ status: string; phoneNumber?: string }> {
	const rows = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
	if (rows.length === 0) return { status: "not_configured" };
	if (!rows[0].enabled) return { status: "disabled" };
	// Return real adapter status if available
	const { getAdapterStatus } = await import("../channels/manager");
	const adapterStatus = getAdapterStatus(id);
	return { status: adapterStatus ?? "disconnected" };
}

export async function getDefaultChannelProject(): Promise<{ projectId: string | null }> {
	const rows = await db.select({ value: settings.value }).from(settings)
		.where(eq(settings.key, "default_channel_project_id")).limit(1);
	if (rows.length === 0) return { projectId: null };
	try { return { projectId: JSON.parse(rows[0].value) as string }; }
	catch { return { projectId: rows[0].value }; }
}

export async function setDefaultChannelProject(projectId: string | null): Promise<{ success: boolean }> {
	const value = JSON.stringify(projectId);
	const existing = await db.select({ key: settings.key }).from(settings)
		.where(eq(settings.key, "default_channel_project_id")).limit(1);
	if (existing.length > 0) {
		await db.update(settings).set({ value, updatedAt: new Date().toISOString() })
			.where(eq(settings.key, "default_channel_project_id"));
	} else {
		await db.insert(settings).values({ key: "default_channel_project_id", value, category: "channels" });
	}
	return { success: true };
}

export async function connectWhatsApp(id: string): Promise<{ success: boolean; error?: string }> {
	try {
		const { connectSingleChannel } = await import("../channels/manager");
		await connectSingleChannel(id);
		return { success: true };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}
