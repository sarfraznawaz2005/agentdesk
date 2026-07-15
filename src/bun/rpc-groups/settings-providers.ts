import * as settingsRpc from "../rpc/settings";
import * as providersRpc from "../rpc/providers";
import * as settingsExportRpc from "../rpc/settings-export";
import * as resetRpc from "../rpc/reset";
import * as updaterRpc from "../rpc/updater";
import * as envVarsRpc from "../rpc/env-vars";
import * as recommendationsRpc from "../rpc/recommendations";
import { invalidatePromptLogCache, clearPromptLog, openPromptLog } from "../agents/prompt-logger";
import { broadcastToWebview } from "../engine-manager";
import { db } from "../db";
import { aiProviders } from "../db/schema";
import { eq } from "drizzle-orm";
import { settingChangeCallbacks } from "./setting-callbacks";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (params: any) => any> = {
	// Settings
	getSettings: (params) => settingsRpc.getSettings(params.category),
	getSetting: (params) => settingsRpc.getSetting(params.key, params.category),
	saveSetting: async (params) => {
		const result = await settingsRpc.saveSetting(params.key, params.value, params.category);
		if (params.key === "debug_prompts") invalidatePromptLogCache();
		settingChangeCallbacks.get(params.key)?.(params.value);
		return result;
	},

	// AI Providers
	getProviders: () => providersRpc.getProvidersList(),
	saveProvider: async (params) => {
		const result = await providersRpc.saveProviderHandler(params);
		if (result.success) broadcastToWebview("providersChanged", { reason: "saved" });
		return result;
	},
	testProvider: (params) => {
		// Fire-and-forget: run the test async (can exceed 10 s RPC timeout)
		// and push the result back via a webview message.
		providersRpc.testProviderHandler(params.id).then((result) => {
			broadcastToWebview("providerTestResult", { id: params.id, ...result });
		}).catch((err: unknown) => {
			broadcastToWebview("providerTestResult", {
				id: params.id,
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
		});
		return { queued: true };
	},
	listProviderModels: (params) => providersRpc.listProviderModelsHandler(params),
	listProviderModelsById: (params) => providersRpc.listProviderModelsByIdHandler(params.providerId),
	getProviderApiKey: (params) => providersRpc.getProviderApiKeyHandler(params.id),
	testProviderWithCredentials: (params) => providersRpc.testProviderWithCredentialsHandler(params),
	deleteProvider: async (params) => {
		const result = await providersRpc.deleteProviderHandler(params.id);
		if (result.success) broadcastToWebview("providersChanged", { reason: "deleted" });
		return result;
	},
	getConnectedProviderModels: () => providersRpc.getConnectedProviderModelsHandler(),
	getModelTypes: () => providersRpc.getModelTypesHandler(),
	checkModelToolSupport: (params) => providersRpc.checkModelToolSupportHandler(params),
	getClaudeSubscriptionEnabled: () => providersRpc.getClaudeSubscriptionEnabledHandler(),

	// Per-model preferences (enabled/favourite/last-used)
	getModelPreferences: () => providersRpc.getModelPreferencesHandler(),
	setModelEnabled: async (params) => {
		const result = await providersRpc.setModelEnabledHandler(params);
		broadcastToWebview("modelPreferencesChanged", { reason: "enabled" });
		return result;
	},
	setModelsEnabled: async (params) => {
		const result = await providersRpc.setModelsEnabledHandler(params);
		broadcastToWebview("modelPreferencesChanged", { reason: "enabled" });
		return result;
	},
	setModelFavorite: async (params) => {
		const result = await providersRpc.setModelFavoriteHandler(params);
		broadcastToWebview("modelPreferencesChanged", { reason: "favorite" });
		return result;
	},
	recordModelUsage: (params) => providersRpc.recordModelUsageHandler(params),

	// Prompt Debug Log
	clearPromptLog: () => clearPromptLog(),
	openPromptLog: () => openPromptLog(),

	// Prompt Enhancer
	enhancePrompt: async (params) => {
		const { generateText } = await import("ai");
		const { createProviderAdapter } = await import("../providers");
		const { getDefaultModel } = await import("../providers/models");

		// Resolve provider: explicit param > project setting > default
		let providerRow;
		const pid = params.providerId;
		if (pid) {
			const rows = await db.select().from(aiProviders).where(eq(aiProviders.id, pid)).limit(1);
			providerRow = rows[0];
		}
		if (!providerRow) {
			const rows = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
			providerRow = rows[0] ?? (await db.select().from(aiProviders).limit(1))[0];
		}
		if (!providerRow) throw new Error("No AI provider configured");

		const modelId = params.modelId || providerRow.defaultModel || getDefaultModel(providerRow.providerType);
		const adapter = createProviderAdapter({
			id: providerRow.id,
			name: providerRow.name,
			providerType: providerRow.providerType,
			apiKey: providerRow.apiKey ?? "",
			baseUrl: providerRow.baseUrl ?? null,
			defaultModel: providerRow.defaultModel ?? null,
		});
		const model = adapter.createModel(modelId);

		const result = await generateText({
			model,
			instructions: `You are an expert prompt engineer specializing in AI coding assistants. Your job is to transform vague or brief user prompts into clear, detailed, well-structured prompts that will get significantly better results from an AI agent.

When enhancing a prompt:
- Expand vague requirements into specific, actionable details
- Add technical depth: mention architecture patterns, edge cases, error handling, performance considerations where relevant
- Clarify ambiguous terms and make implicit assumptions explicit
- Add acceptance criteria or success conditions where they are missing
- Preserve the user's original intent, constraints, and any explicit instructions (e.g. "create a plan first" must be kept)
- Structure multi-part requests with clear sections or bullet points
- For coding tasks: specify expected behavior, file structure, key technical decisions, and any constraints
- Do NOT pad with filler or repeat the same points in different words
- Output ONLY the enhanced prompt — no preamble, no explanation, no meta-commentary`,
			messages: [
				{
					role: "user",
					content: "Enhance this prompt: add dark mode to the app",
				},
				{
					role: "assistant",
					content: `Add dark mode support to the application with the following requirements:

- Implement a light/dark/system theme toggle, persisting the user's preference to localStorage
- Use CSS custom properties (variables) for all colors so switching themes requires only a class change on the root element
- Respect the user's OS preference by default via \`prefers-color-scheme\` media query
- Ensure all UI components — buttons, modals, inputs, tables, sidebar, and charts — are fully themed with no hardcoded colors remaining
- Maintain WCAG AA contrast ratios in both themes
- The toggle should be accessible (keyboard navigable, aria-label set)`,
				},
				{
					role: "user",
					content: "Enhance this prompt: fix the login bug",
				},
				{
					role: "assistant",
					content: `Investigate and fix the bug on the login page with the following approach:

- Reproduce the issue first: describe the exact steps, inputs, and observed vs. expected behavior
- Check form validation logic — ensure all fields are validated before submission and errors surface clearly to the user
- Inspect the form submit handler for unhandled promise rejections, missing await, or incorrect error propagation
- Verify API error responses are caught and displayed as user-facing messages rather than silent failures
- Check for race conditions if the submit button can be clicked multiple times in quick succession (add loading/disabled state)
- Write a regression test that covers the failing scenario so it cannot silently rebreak`,
				},
				{
					role: "user",
					content: `Enhance this prompt: ${params.text}`,
				},
			],
		});

		return { enhanced: result.text.trim() };
	},

	// Updater
	checkForUpdate: () => updaterRpc.checkForUpdate(),
	downloadUpdate: () => updaterRpc.downloadUpdate(),
	applyUpdate: () => updaterRpc.applyUpdate(),

	// Settings Export/Import
	exportSettings: () => settingsExportRpc.exportSettings(),
	importSettings: (params) => settingsExportRpc.importSettings(params.data),

	// Reset Application
	resetApplication: () => resetRpc.resetApplication(),

	// Custom Environment Variables
	listCustomEnvVars: () => envVarsRpc.listCustomEnvVars(),
	createCustomEnvVar: (params) => envVarsRpc.createCustomEnvVar(params),
	updateCustomEnvVar: (params) => envVarsRpc.updateCustomEnvVar(params),
	deleteCustomEnvVar: (params) => envVarsRpc.deleteCustomEnvVar(params),

	// Recommendations — system dependency checks + install
	checkDependencies: () => recommendationsRpc.checkDependencies(),
	installDependency: (params) => recommendationsRpc.installDependency(params),
};
