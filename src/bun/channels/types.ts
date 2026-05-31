// src/bun/channels/types.ts

export type ChannelPlatform = "discord" | "whatsapp" | "email" | "chat";
export type ConnectionStatus = "connected" | "disconnected" | "connecting" | "error";

export interface IncomingMessage {
	platform: ChannelPlatform;
	channelId: string;
	senderId: string;
	senderName: string;
	content: string;
	threadId?: string;
	metadata?: Record<string, unknown>;
}

export interface SendOptions {
	threadId?: string;
	replyToMessageId?: string;
	subject?: string;
}

export interface ChannelConfig {
	id: string;
	projectId: string | null;
	platform: ChannelPlatform;
	config: Record<string, unknown>;
	enabled: boolean;
}

export interface ChannelAdapter {
	readonly platform: ChannelPlatform;
	connect(config: ChannelConfig): Promise<void>;
	disconnect(): Promise<void>;
	getStatus(): ConnectionStatus;
	sendMessage(channelId: string, content: string, options?: SendOptions): Promise<void>;
	onMessage(handler: (msg: IncomingMessage) => void): void;
	/** Return a default recipient for proactive (outbound-only) notifications, or null if unknown. */
	getDefaultRecipient?(): string | null;
}
