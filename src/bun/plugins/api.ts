import type { Tool } from "ai";
import type { PluginAPI, PluginManifest, FileChangeCallback } from "./types";
import { registerTools, type ToolRegistryEntry } from "../agents/tools/index";
import { db } from "../db";
import { plugins as pluginsTable } from "../db/schema";
import { eq } from "drizzle-orm";
import {
	extRegisterSidebarItem,
	extRegisterProjectTab,
	extRegisterSettingsSection,
	extRegisterChatCommand,
	extRegisterTheme,
	type PluginSidebarItem,
	type PluginProjectTab,
	type PluginSettingsSection,
	type PluginChatCommand,
	type PluginTheme,
} from "./extensions";

export function createPluginAPI(manifest: PluginManifest): {
	api: PluginAPI;
	registeredTools: string[];
	registeredHooks: Array<{ event: string; handler: (...args: unknown[]) => void }>;
	fileChangeCallbacks: FileChangeCallback[];
} {
	const registeredTools: string[] = [];
	const registeredHooks: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];
	const fileChangeCallbacks: FileChangeCallback[] = [];

	const api: PluginAPI = {
		registerTool(name: string, tool: Tool) {
			const entry: ToolRegistryEntry = { tool, category: "plugin" };
			const toolKey = `plugin__${manifest.name.replace(/-/g, "_")}__${name}`;
			registerTools({ [toolKey]: entry });
			registeredTools.push(toolKey);
		},
		registerHook(event: string, handler: (...args: unknown[]) => void) {
			registeredHooks.push({ event, handler });
		},
		getSettings(): Record<string, unknown> {
			try {
				const rows = db.select().from(pluginsTable).where(eq(pluginsTable.name, manifest.name)).limit(1).all();
				if (rows.length > 0 && rows[0].settings) {
					return JSON.parse(rows[0].settings);
				}
			} catch {
				// Fall through
			}
			// Return defaults from manifest
			return Object.fromEntries(
				Object.entries(manifest.settings ?? {}).map(([k, v]) => [k, v.default ?? null])
			);
		},
		async setSettings(partial: Record<string, unknown>) {
			const rows = await db.select().from(pluginsTable).where(eq(pluginsTable.name, manifest.name)).limit(1);
			if (rows.length === 0) return;
			const current = JSON.parse(rows[0].settings ?? "{}");
			const merged = { ...current, ...partial };
			await db.update(pluginsTable).set({ settings: JSON.stringify(merged), updatedAt: new Date().toISOString() }).where(eq(pluginsTable.name, manifest.name));
		},
		getProjectContext() {
			return null;
		},
		log(level, message) {
			const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
			fn(`[plugin:${manifest.name}] ${message}`);
		},
		onFileChange(callback: FileChangeCallback) {
			fileChangeCallbacks.push(callback);
		},
		registerSidebarItem(item: PluginSidebarItem) {
			extRegisterSidebarItem(manifest.name, item);
		},
		registerProjectTab(tab: PluginProjectTab) {
			extRegisterProjectTab(manifest.name, tab);
		},
		registerSettingsSection(section: PluginSettingsSection) {
			extRegisterSettingsSection(manifest.name, section);
		},
		registerChatCommand(command: PluginChatCommand) {
			extRegisterChatCommand(manifest.name, command);
		},
		registerTheme(theme: PluginTheme) {
			extRegisterTheme(manifest.name, theme);
		},
	};

	return { api, registeredTools, registeredHooks, fileChangeCallbacks };
}
