import { Client, GatewayIntentBits, type TextChannel } from "discord.js";

export type BotStatus = "connected" | "disconnected" | "reconnecting" | "error";

export class DiscordBot {
	private client: Client;
	private token: string;
	private status: BotStatus = "disconnected";
	private reconnectAttempts = 0;
	private destroyed = false;

	constructor(
		token: string,
		private onMessageCallback?: (channelId: string, username: string, content: string) => void,
	) {
		this.token = token;
		this.client = this.createClient();
	}

	private createClient(): Client {
		const client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
			],
		});

		client.on("clientReady", (readyClient) => {
			console.log(`[discord] Bot connected as ${readyClient.user.tag}`);
			this.status = "connected";
			this.reconnectAttempts = 0;
		});

		client.on("messageCreate", (message) => {
			if (message.author.bot) return;
			if (this.onMessageCallback) {
				this.onMessageCallback(message.channelId, message.author.username, message.content);
			}
		});

		client.on("error", (err) => {
			console.error("[discord] Client error:", err);
			this.status = "error";
		});

		client.on("shardDisconnect", () => {
			if (!this.destroyed) {
				this.status = "disconnected";
				this.scheduleReconnect();
			}
		});

		return client;
	}

	async connect(): Promise<void> {
		try {
			this.status = "reconnecting";
			await this.client.login(this.token);
		} catch (err) {
			console.error("[discord] Failed to connect:", err);
			this.status = "error";
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.destroyed) return;
		const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
		this.reconnectAttempts++;
		console.log(`[discord] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
		const oldClient = this.client;
		setTimeout(async () => {
			if (!this.destroyed) {
				// Destroy old client first to stop its internal reconnection logic,
				// which would otherwise race with our new client and cause InvalidStateError.
				try {
					await oldClient.destroy();
				} catch {
					// ignore — client may already be in a bad state
				}
				this.client = this.createClient();
				void this.connect();
			}
		}, delay);
	}

	async sendToChannel(channelId: string, content: string): Promise<void> {
		try {
			const channel = await this.client.channels.fetch(channelId);
			if (channel && channel.isTextBased()) {
				await (channel as TextChannel).send(content);
			}
		} catch (err) {
			console.error(`[discord] Failed to send to channel ${channelId}:`, err);
		}
	}

	getStatus(): BotStatus {
		return this.status;
	}

	async shutdown(): Promise<void> {
		this.destroyed = true;
		this.status = "disconnected";
		await this.client.destroy();
	}
}
