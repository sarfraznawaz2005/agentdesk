import { DiscordBot } from "../discord/bot";
import type {
	ChannelAdapter,
	ChannelConfig,
	ConnectionStatus,
	IncomingMessage,
	SendOptions,
} from "./types";

export class DiscordAdapter implements ChannelAdapter {
	readonly platform = "discord" as const;
	private bot: DiscordBot | null = null;
	private messageHandler: ((msg: IncomingMessage) => void) | null = null;

	getStatus(): ConnectionStatus {
		if (!this.bot) return "disconnected";
		const s = this.bot.getStatus();
		if (s === "reconnecting") return "connecting";
		return s;
	}

	onMessage(handler: (msg: IncomingMessage) => void): void {
		this.messageHandler = handler;
	}

	async connect(config: ChannelConfig): Promise<void> {
		const token = (config.config as { token: string }).token;
		if (!token) throw new Error("Discord token is required");

		this.bot = new DiscordBot(token, (channelId, username, content) => {
			if (this.messageHandler) {
				this.messageHandler({
					platform: "discord",
					channelId,
					senderId: username,
					senderName: username,
					content,
					metadata: { projectId: config.projectId },
				});
			}
		});

		await this.bot.connect();
	}

	async disconnect(): Promise<void> {
		if (this.bot) {
			await this.bot.shutdown();
			this.bot = null;
		}
	}

	async sendMessage(channelId: string, content: string, _options?: SendOptions): Promise<void> {
		if (!this.bot) throw new Error("Discord bot not connected");
		await this.bot.sendToChannel(channelId, content);
	}
}
