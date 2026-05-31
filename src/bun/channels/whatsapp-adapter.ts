import type {
    ChannelAdapter, ChannelConfig, ConnectionStatus, IncomingMessage, SendOptions,
} from "./types";
import { useSQLiteAuthState } from "./whatsapp-auth-store";

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 5000;

export class WhatsAppAdapter implements ChannelAdapter {
    readonly platform = "whatsapp" as const;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private sock: any = null;
    private status: ConnectionStatus = "disconnected";
    private messageHandler: ((msg: IncomingMessage) => void) | null = null;
    private qrCallback: ((qr: string) => void) | null = null;
    private destroyed = false;
    private reconnectAttempts = 0;
    /** IDs of messages we sent — used for echo prevention on self-messages */
    private sentMessageIds = new Set<string>();

    onMessage(handler: (msg: IncomingMessage) => void): void { this.messageHandler = handler; }
    onQR(callback: (qr: string) => void): void { this.qrCallback = callback; }
    getStatus(): ConnectionStatus { return this.status; }
    getDefaultRecipient(): string | null {
        const raw = this.sock?.user?.id as string | undefined;
        if (!raw) return null;
        // Normalize: "1234567890:42@s.whatsapp.net" → "1234567890@s.whatsapp.net"
        return raw.replace(/:.*@/, "@");
    }

    async connect(config: ChannelConfig): Promise<void> {
        if (this.destroyed) return;
        this.status = "connecting";

        const baileys = await import("@whiskeysockets/baileys");
        const makeWASocket = baileys.default;
        const { DisconnectReason, fetchLatestBaileysVersion } = baileys;

        const { version } = await fetchLatestBaileysVersion();

        const { state, saveCreds } = await useSQLiteAuthState(config.id);

        const pino = (await import("pino")).default;
        this.sock = makeWASocket({
            version,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            auth: state as any,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
        });

        this.sock.ev.on("creds.update", saveCreds);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.sock.ev.on("connection.update", (update: any) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                if (this.qrCallback) this.qrCallback(qr);
            }
            if (connection === "close") {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const err = lastDisconnect?.error as any;
                const statusCode = err?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    this.status = "disconnected";
                    return;
                }
                if (this.destroyed) return;
                if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    console.warn(`[WhatsAppAdapter] Max reconnect attempts reached for channel ${config.id}. Giving up.`);
                    this.status = "disconnected";
                    return;
                }
                // Exponential backoff: 5s, 10s, 20s, 40s, 80s
                const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts);
                this.reconnectAttempts++;
                this.status = "connecting";
                setTimeout(() => { if (!this.destroyed) this.connect(config); }, delay);
            } else if (connection === "open") {
                this.reconnectAttempts = 0;
                this.status = "connected";
            }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.sock.ev.on("messages.upsert", ({ messages, type }: any) => {
            // Only process real-time messages, not historical sync
            if (type !== "notify") return;

            for (const msg of messages) {
                if (!msg.message) continue;

                // Echo prevention: skip messages we sent via sendMessage()
                if (msg.key.fromMe && this.sentMessageIds.has(msg.key.id)) {
                    this.sentMessageIds.delete(msg.key.id);
                    continue;
                }

                const text = msg.message.conversation
                    || msg.message.extendedTextMessage?.text;
                if (!text) continue;

                // For self-messages, remoteJid is our own number — use it as the channelId
                // so PM can reply back to the same chat
                let senderJid = msg.key.remoteJid || "";

                // Resolve LID to phone JID for self-messages
                if (senderJid.endsWith("@lid") && this.sock?.user) {
                    const myLidNum = this.sock.user.lid?.split("@")[0]?.split(":")[0];
                    const chatLidNum = senderJid.split("@")[0];
                    if (myLidNum && chatLidNum === myLidNum) {
                        senderJid = this.sock.user.id?.split(":")[0] + "@s.whatsapp.net";
                    }
                }

                const senderName = msg.key.fromMe
                    ? (this.sock?.user?.name || "You")
                    : (msg.pushName || senderJid.split("@")[0]);

                if (this.messageHandler) {
                    this.messageHandler({
                        platform: "whatsapp",
                        channelId: senderJid,
                        senderId: senderJid,
                        senderName,
                        content: text,
                        threadId: msg.message.extendedTextMessage?.contextInfo?.stanzaId,
                        metadata: { projectId: config.projectId, messageId: msg.key.id },
                    });
                }
            }
        });
    }

    async disconnect(): Promise<void> {
        this.destroyed = true;
        if (this.sock) { this.sock.end(undefined); this.sock = null; }
        this.status = "disconnected";
    }

    async sendMessage(channelId: string, content: string, _options?: SendOptions): Promise<void> {
        if (!this.sock) throw new Error("WhatsApp not connected");
        const result = await this.sock.sendMessage(channelId, { text: content });
        // Track sent message ID so echo prevention can skip it in messages.upsert
        if (result?.key?.id) {
            this.sentMessageIds.add(result.key.id);
            // Keep the set bounded
            if (this.sentMessageIds.size > 200) {
                const first = this.sentMessageIds.values().next().value as string;
                this.sentMessageIds.delete(first);
            }
        }
    }
}
