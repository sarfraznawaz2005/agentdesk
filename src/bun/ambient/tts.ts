// ---------------------------------------------------------------------------
// Ambient Mode's configurable TTS model (docs/ambient-pm-voice-plan.md
// Subsystem 6) — an OPTIONAL upgrade over the zero-config browser
// speechSynthesis default (use-text-to-speech.ts), for users who configure a
// real speech-capable AI provider model (e.g. OpenAI's tts-1/tts-1-hd).
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "../db";
import { aiProviders } from "../db/schema";
import { createProviderAdapter } from "../providers";

export async function generateAmbientSpeech(providerId: string, modelId: string, text: string, speed?: number): Promise<{ base64: string; mimeType: string }> {
	const rows = await db.select().from(aiProviders).where(eq(aiProviders.id, providerId)).limit(1);
	const provider = rows[0];
	if (!provider) throw new Error("That provider is no longer configured — pick a voice again in Settings.");

	const adapter = createProviderAdapter({
		id: provider.id, name: provider.name, providerType: provider.providerType,
		apiKey: provider.apiKey, baseUrl: provider.baseUrl, defaultModel: provider.defaultModel,
	});
	if (!adapter.generateSpeech) throw new Error(`${provider.name} doesn't support speech generation.`);
	return adapter.generateSpeech(modelId, text, speed);
}
