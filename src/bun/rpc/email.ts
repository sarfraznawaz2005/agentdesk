import { db } from "../db";
import { channels } from "../db/schema";
import { eq } from "drizzle-orm";

export async function getEmailConfigs() {
	return db.select().from(channels).where(eq(channels.platform, "email"));
}

export async function saveEmailConfig(params: {
	id?: string;
	projectId?: string;
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
	enabled?: boolean;
}) {
	const config = JSON.stringify({
		imapHost: params.imapHost,
		imapPort: params.imapPort,
		imapUser: params.imapUser,
		imapPass: params.imapPass,
		imapTls: params.imapTls,
		smtpHost: params.smtpHost,
		smtpPort: params.smtpPort,
		smtpUser: params.smtpUser,
		smtpPass: params.smtpPass,
		smtpTls: params.smtpTls,
	});

	if (params.id) {
		await db.update(channels).set({
			projectId: params.projectId ?? null,
			config,
			enabled: params.enabled !== false ? 1 : 0,
			updatedAt: new Date().toISOString(),
		}).where(eq(channels.id, params.id));
		return { success: true, id: params.id };
	}

	const id = crypto.randomUUID();
	await db.insert(channels).values({
		id,
		projectId: params.projectId ?? null,
		platform: "email",
		config,
		enabled: params.enabled !== false ? 1 : 0,
	});
	return { success: true, id };
}

export async function deleteEmailConfig(id: string) {
	await db.delete(channels).where(eq(channels.id, id));
	return { success: true };
}

export async function testEmailConnection(params: {
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
}): Promise<{ success: boolean; error?: string }> {
	try {
		const { ImapFlow } = await import("imapflow");
		const imap = new ImapFlow({
			host: params.imapHost,
			port: params.imapPort,
			secure: params.imapTls,
			auth: { user: params.imapUser, pass: params.imapPass },
			logger: false,
		});
		await imap.connect();
		await imap.logout();

		const nodemailer = await import("nodemailer");
		const transport = nodemailer.createTransport({
			host: params.smtpHost,
			port: params.smtpPort,
			secure: params.smtpTls,
			auth: { user: params.smtpUser, pass: params.smtpPass },
		});
		await transport.verify();
		transport.close();

		return { success: true };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}
