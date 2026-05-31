import { db } from "../db";
import { notificationPreferences } from "../db/schema";
import { eq } from "drizzle-orm";

export async function getNotificationPreferences(params?: { platform?: string; projectId?: string }) {
    if (params?.platform) {
        return db.select().from(notificationPreferences).where(eq(notificationPreferences.platform, params.platform));
    }
    return db.select().from(notificationPreferences);
}

export async function saveNotificationPreference(params: {
    id?: string;
    platform: string;
    projectId?: string;
    soundEnabled?: boolean;
    badgeEnabled?: boolean;
    bannerEnabled?: boolean;
    muteUntil?: string | null;
}) {
    if (params.id) {
        const updates: Record<string, unknown> = {};
        if (params.soundEnabled !== undefined) updates.soundEnabled = params.soundEnabled ? 1 : 0;
        if (params.badgeEnabled !== undefined) updates.badgeEnabled = params.badgeEnabled ? 1 : 0;
        if (params.bannerEnabled !== undefined) updates.bannerEnabled = params.bannerEnabled ? 1 : 0;
        if (params.muteUntil !== undefined) updates.muteUntil = params.muteUntil;
        await db.update(notificationPreferences).set(updates).where(eq(notificationPreferences.id, params.id));
        return { success: true, id: params.id };
    }
    const id = crypto.randomUUID();
    await db.insert(notificationPreferences).values({
        id, platform: params.platform, projectId: params.projectId ?? null,
        soundEnabled: params.soundEnabled !== false ? 1 : 0,
        badgeEnabled: params.badgeEnabled !== false ? 1 : 0,
        bannerEnabled: params.bannerEnabled !== false ? 1 : 0,
        muteUntil: params.muteUntil ?? null,
    });
    return { success: true, id };
}

export async function shouldNotify(platform: string, projectId?: string): Promise<{
    sound: boolean; badge: boolean; banner: boolean;
}> {
    const rows = await db.select().from(notificationPreferences)
        .where(eq(notificationPreferences.platform, platform));
    const projectPref = projectId ? rows.find(r => r.projectId === projectId) : null;
    const globalPref = rows.find(r => !r.projectId);
    const pref = projectPref || globalPref;
    if (!pref) return { sound: true, badge: true, banner: true };
    if (pref.muteUntil && new Date(pref.muteUntil) > new Date()) {
        return { sound: false, badge: pref.badgeEnabled === 1, banner: false };
    }
    return { sound: pref.soundEnabled === 1, badge: pref.badgeEnabled === 1, banner: pref.bannerEnabled === 1 };
}
