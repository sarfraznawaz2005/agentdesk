import { db } from "../db";
import { whatsappSessions } from "../db/schema";
import { eq } from "drizzle-orm";

export async function useSQLiteAuthState(channelId: string) {
    const { initAuthCreds, BufferJSON } = await import("@whiskeysockets/baileys");

    let rows = await db.select().from(whatsappSessions)
        .where(eq(whatsappSessions.channelId, channelId)).limit(1);

    if (rows.length === 0) {
        await db.insert(whatsappSessions).values({ channelId });
        rows = await db.select().from(whatsappSessions)
            .where(eq(whatsappSessions.channelId, channelId)).limit(1);
    }

    const row = rows[0];

    // Use BufferJSON.reviver so Uint8Array/Buffer fields deserialize correctly
    const storedCreds = JSON.parse(row.creds || "{}", BufferJSON.reviver);
    const creds = storedCreds.noiseKey ? storedCreds : initAuthCreds();
    const keys: Record<string, unknown> = JSON.parse(row.keys || "{}", BufferJSON.reviver);

    const saveCreds = async () => {
        await db.update(whatsappSessions)
            .set({ creds: JSON.stringify(creds, BufferJSON.replacer), updatedAt: new Date().toISOString() })
            .where(eq(whatsappSessions.channelId, channelId));
    };

    const state = {
        creds,
        keys: {
            get: (type: string, ids: string[]) => {
                const data: Record<string, unknown> = {};
                const typeStore = (keys[type] as Record<string, unknown>) || {};
                for (const id of ids) {
                    if (typeStore[id] !== undefined) data[id] = typeStore[id];
                }
                return data;
            },
            set: async (data: Record<string, Record<string, unknown>>) => {
                for (const [type, entries] of Object.entries(data)) {
                    if (!keys[type]) keys[type] = {};
                    const typeStore = keys[type] as Record<string, unknown>;
                    for (const [id, value] of Object.entries(entries)) {
                        if (value) typeStore[id] = value;
                        else Reflect.deleteProperty(typeStore, id);
                    }
                }
                await db.update(whatsappSessions)
                    .set({ keys: JSON.stringify(keys, BufferJSON.replacer), updatedAt: new Date().toISOString() })
                    .where(eq(whatsappSessions.channelId, channelId));
            },
        },
    };

    return { state, saveCreds };
}
