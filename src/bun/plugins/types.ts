import type { Tool } from "ai";
import type {
	PluginSidebarItem,
	PluginProjectTab,
	PluginSettingsSection,
	PluginChatCommand,
	PluginTheme,
} from "./extensions";

// Re-export for convenience
export type { PluginSidebarItem, PluginProjectTab, PluginSettingsSection, PluginChatCommand, PluginTheme };

/** Permissions a plugin can request */
export type PluginPermission = "fs" | "shell" | "network";

/** Hooks a plugin can implement */
export interface PluginHooks {
	onInstall?: () => void | Promise<void>;
	onEnable?: () => void | Promise<void>;
	onDisable?: () => void | Promise<void>;
	onUninstall?: () => void | Promise<void>;
}

/** JSON schema-like setting definition */
export interface PluginSettingDef {
	type: "string" | "number" | "boolean" | "array";
	default?: unknown;
	description?: string;
}

/** Plugin manifest.json schema */
export interface PluginManifest {
	name: string;
	displayName: string;
	version: string;
	description: string;
	author: string;
	permissions: PluginPermission[];
	tools?: string[];
	settings?: Record<string, PluginSettingDef>;
	/** If false, the plugin is disabled on first install. Defaults to true. */
	defaultEnabled?: boolean;
	/** Optional prompt snippet injected into agent system prompts when plugin is enabled. */
	prompt?: string;
}

/** What a plugin's index.ts must export */
export interface PluginModule {
	activate(api: PluginAPI): void | Promise<void>;
	deactivate?(): void | Promise<void>;
	onInstall?(): void | Promise<void>;
	onEnable?(): void | Promise<void>;
	onDisable?(): void | Promise<void>;
	onUninstall?(): void | Promise<void>;
}

/** Callback for file change events (path, content). May return diagnostic strings. */
export type FileChangeCallback = (filePath: string, content: string) => undefined | string[] | Promise<undefined | string[]>;

/** API object passed to plugin's activate() */
export interface PluginAPI {
	registerTool(name: string, tool: Tool): void;
	registerHook(event: string, handler: (...args: unknown[]) => void): void;
	getSettings(): Record<string, unknown>;
	setSettings(partial: Record<string, unknown>): Promise<void>;
	getProjectContext(): { id: string; name: string; workspacePath: string } | null;
	log(level: "info" | "warn" | "error", message: string): void;
	// File change notifications (used by LSP plugin)
	onFileChange(callback: FileChangeCallback): void;
	// UI Extension Points
	registerSidebarItem(item: PluginSidebarItem): void;
	registerProjectTab(tab: PluginProjectTab): void;
	registerSettingsSection(section: PluginSettingsSection): void;
	registerChatCommand(command: PluginChatCommand): void;
	registerTheme(theme: PluginTheme): void;
}

/** Runtime representation of a loaded plugin */
export interface PluginInstance {
	manifest: PluginManifest;
	directory: string;
	module: PluginModule;
	api: PluginAPI;
	enabled: boolean;
	registeredTools: string[];
	registeredHooks: Array<{ event: string; handler: (...args: unknown[]) => void }>;
	fileChangeCallbacks: FileChangeCallback[];
}
