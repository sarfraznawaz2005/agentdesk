import type {
    ChannelAdapter, ChannelConfig, ConnectionStatus, IncomingMessage, SendOptions,
} from "./types";

export interface EmailChannelConfig {
    imapHost: string;
    imapPort: number;
    imapUser: string;
    imapPass: string;
    imapTls: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPass: string;
    smtpTls: boolean;
}

export class EmailAdapter implements ChannelAdapter {
    readonly platform = "email" as const;
    private config: ChannelConfig | null = null;
    private emailConfig: EmailChannelConfig | null = null;
    private status: ConnectionStatus = "disconnected";
    private messageHandler: ((msg: IncomingMessage) => void) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private smtpTransport: any = null;
    private idleRestart: ReturnType<typeof setTimeout> | null = null;
    /** Highest UID we have successfully processed. 0 = not yet initialised. */
    private lastProcessedUid = 0;

    onMessage(handler: (msg: IncomingMessage) => void): void { this.messageHandler = handler; }
    getStatus(): ConnectionStatus { return this.status; }

    async connect(config: ChannelConfig): Promise<void> {
        this.config = config;
        this.emailConfig = config.config as unknown as EmailChannelConfig;
        this.status = "connecting";

        const nodemailer = await import("nodemailer");

        this.smtpTransport = nodemailer.createTransport({
            host: this.emailConfig.smtpHost,
            port: this.emailConfig.smtpPort,
            secure: this.emailConfig.smtpTls,
            auth: { user: this.emailConfig.smtpUser, pass: this.emailConfig.smtpPass },
        });

        // Verify credentials with a quick connect/logout before starting the loop
        console.log(`[EmailAdapter] Verifying IMAP ${this.emailConfig.imapHost}:${this.emailConfig.imapPort}`);
        const { ImapFlow: ImapFlowVerify } = await import("imapflow");
        const verifyClient = new ImapFlowVerify({
            host: this.emailConfig.imapHost,
            port: this.emailConfig.imapPort,
            secure: this.emailConfig.imapTls,
            auth: { user: this.emailConfig.imapUser, pass: this.emailConfig.imapPass },
            logger: false,
        });
        await verifyClient.connect();
        await verifyClient.logout();
        this.status = "connected";
        console.log("[EmailAdapter] IMAP verified. Starting idle loop.");
        void this.startIdleLoop();
    }

    private async startIdleLoop(): Promise<void> {
        if (this.status !== "connected") return;
        console.log("[EmailAdapter] startIdleLoop: connecting fresh IMAP session");
        const { ImapFlow } = await import("imapflow");
        const imap = new ImapFlow({
            host: this.emailConfig?.imapHost ?? "",
            port: this.emailConfig?.imapPort ?? 993,
            secure: this.emailConfig?.imapTls ?? true,
            auth: { user: this.emailConfig?.imapUser ?? "", pass: this.emailConfig?.imapPass ?? "" },
            logger: false,
        });
        // Prevent socket-level errors (timeout, ECONNRESET, etc.) from becoming
        // uncaught exceptions that crash the process. Our try/catch handles cleanup.
        imap.on("error", (err: unknown) => {
            console.error("[EmailAdapter] IMAP socket error:", err);
        });

        try {
            await imap.connect();
            console.log("[EmailAdapter] IMAP session ready, fetching unseen messages");

            const lock = await imap.getMailboxLock("INBOX");
            try {
                // On first connect, initialise lastProcessedUid to the current INBOX
                // ceiling so we only process genuinely new mail going forward.
                if (this.lastProcessedUid === 0) {
                    const status = await imap.status("INBOX", { uidNext: true });
                    this.lastProcessedUid = (status.uidNext ?? 1) - 1;
                    console.log(`[EmailAdapter] Initialised lastProcessedUid=${this.lastProcessedUid}`);
                }

                // Fetch all messages with UID > lastProcessedUid — this is immune to
                // emails being read/marked-seen by another mail client before we see them.
                const fetchSource = `${this.lastProcessedUid + 1}:*`;
                const newMessages = imap.fetch(fetchSource, { source: true, envelope: true, uid: true }, { uid: true });
                let count = 0;
                for await (const msg of newMessages) {
                    if (!msg.uid || msg.uid <= this.lastProcessedUid) continue;
                    count++;
                    console.log(`[EmailAdapter] Processing uid=${msg.uid} subject="${msg.envelope?.subject}"`);
                    await this.processEmail(msg);
                    this.lastProcessedUid = msg.uid;
                }
                console.log(`[EmailAdapter] Fetched ${count} new message(s) (lastProcessedUid=${this.lastProcessedUid}). Entering IDLE.`);
            } finally {
                lock.release();
            }

            // Break IDLE after 60 seconds as a polling fallback (in case the server
            // doesn't push a notification for new mail) and at 29 min for RFC 2177.
            const POLL_INTERVAL_MS = 60_000;
            if (this.idleRestart) clearTimeout(this.idleRestart);
            this.idleRestart = setTimeout(() => {
                console.log("[EmailAdapter] Poll interval: breaking IDLE to re-check");
                imap.idle().catch(() => {});
            }, POLL_INTERVAL_MS);

            await imap.idle();
            console.log("[EmailAdapter] IDLE resolved — reconnecting to fetch new mail");
        } catch (err) {
            console.error("[EmailAdapter] session error:", err);
        } finally {
            if (this.idleRestart) { clearTimeout(this.idleRestart); this.idleRestart = null; }
            try { await imap.logout(); } catch { /* already disconnected */ }
        }

        // Reconnect for the next cycle (whether we got new mail or hit an error)
        if (this.status === "connected") {
            void this.startIdleLoop();
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async processEmail(msg: any): Promise<void> {
        if (!this.messageHandler || !this.config) return;
        const envelope = msg.envelope;
        const from = envelope?.from?.[0];
        const senderName = from?.name || from?.address || "Unknown";
        const senderId = from?.address || "unknown";

        let content = "";
        if (msg.source) {
            const source = msg.source.toString();
            // Match the text/plain part, capturing transfer encoding if present
            const partMatch = source.match(
                /Content-Type: text\/plain([\s\S]*?)\r\n\r\n([\s\S]*?)(?=\r\n--|$)/i
            );
            if (partMatch) {
                const headers = partMatch[1];
                const body = partMatch[2].trim();
                const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(headers);
                const isQP = /Content-Transfer-Encoding:\s*quoted-printable/i.test(headers);
                if (isBase64) {
                    try {
                        content = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf-8");
                    } catch {
                        content = body;
                    }
                } else if (isQP) {
                    content = body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/gi, (_: string, h: string) =>
                        String.fromCharCode(parseInt(h, 16))
                    );
                } else {
                    content = body;
                }
            } else {
                content = source.slice(0, 500);
            }
        }

        const messageId = envelope?.messageId || "";
        const inReplyTo = envelope?.inReplyTo || "";
        const subject = envelope?.subject || "";

        console.log(`[EmailAdapter] Dispatching message from=${senderId} subject="${subject}" contentLen=${content.length}`);
        this.messageHandler({
            platform: "email",
            channelId: senderId,
            senderId,
            senderName,
            content: `[Subject: ${subject}]\n${content}`,
            threadId: inReplyTo || messageId,
            metadata: { projectId: this.config.projectId, messageId, inReplyTo, subject },
        });
    }

    async disconnect(): Promise<void> {
        if (this.idleRestart) { clearTimeout(this.idleRestart); this.idleRestart = null; }
        if (this.smtpTransport) { this.smtpTransport.close(); this.smtpTransport = null; }
        this.status = "disconnected";
        // startIdleLoop checks this.status === "connected" and will stop on its next cycle
    }

    async sendMessage(channelId: string, content: string, options?: SendOptions): Promise<void> {
        if (!this.smtpTransport || !this.emailConfig) throw new Error("Email not connected");
        await this.smtpTransport.sendMail({
            from: this.emailConfig.smtpUser,
            to: channelId,
            subject: options?.subject || "AgentDesk Notification",
            text: content,
            ...(options?.replyToMessageId && { inReplyTo: options.replyToMessageId, references: options.replyToMessageId }),
        });
    }
}
