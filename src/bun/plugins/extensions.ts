/**
 * Runtime registry for UI extension points that plugins can contribute.
 * All data is in-memory and rebuilt when plugins activate/deactivate.
 */

export interface PluginSidebarItem {
	id: string;
	label: string;
	icon: string; // Lucide icon name
	href: string; // route path (e.g. "/plugin/my-plugin/view")
}

export interface PluginProjectTab {
	id: string;
	label: string;
	description?: string;
}

export interface PluginSettingsField {
	key: string;
	label: string;
	type: "string" | "number" | "boolean" | "array";
	description?: string;
	default?: unknown;
}

export interface PluginSettingsSection {
	id: string;
	title: string;
	description?: string;
	fields: PluginSettingsField[];
}

export interface PluginChatCommand {
	name: string; // without slash, e.g. "summarize"
	description: string;
	pattern?: string; // optional regex pattern for arguments
}

export interface PluginTheme {
	tokens: Record<string, string>; // CSS variable name → value (e.g. "--primary": "#ff0000")
	css?: string; // raw CSS string appended to document
}

// ── Internal registry ─────────────────────────────────────────────────────

const sidebarItems = new Map<string, PluginSidebarItem[]>();
const projectTabs = new Map<string, PluginProjectTab[]>();
const settingsSections = new Map<string, PluginSettingsSection[]>();
const chatCommands = new Map<string, PluginChatCommand[]>();
const themes = new Map<string, PluginTheme>();

// ── Registration helpers (called from PluginAPI) ──────────────────────────

export function extRegisterSidebarItem(pluginName: string, item: PluginSidebarItem) {
	sidebarItems.set(pluginName, [...(sidebarItems.get(pluginName) ?? []), item]);
}

export function extRegisterProjectTab(pluginName: string, tab: PluginProjectTab) {
	projectTabs.set(pluginName, [...(projectTabs.get(pluginName) ?? []), tab]);
}

export function extRegisterSettingsSection(pluginName: string, section: PluginSettingsSection) {
	settingsSections.set(pluginName, [...(settingsSections.get(pluginName) ?? []), section]);
}

export function extRegisterChatCommand(pluginName: string, command: PluginChatCommand) {
	chatCommands.set(pluginName, [...(chatCommands.get(pluginName) ?? []), command]);
}

export function extRegisterTheme(pluginName: string, theme: PluginTheme) {
	themes.set(pluginName, theme);
}

/** Remove all extension points contributed by a plugin (called on deactivate). */
export function clearPluginExtensions(pluginName: string) {
	sidebarItems.delete(pluginName);
	projectTabs.delete(pluginName);
	settingsSections.delete(pluginName);
	chatCommands.delete(pluginName);
	themes.delete(pluginName);
}

// ── Query (called from RPC handler) ──────────────────────────────────────

export function getAllExtensions() {
	return {
		sidebarItems: Array.from(sidebarItems.entries()).flatMap(([pluginName, items]) =>
			items.map((item) => ({ ...item, pluginName })),
		),
		projectTabs: Array.from(projectTabs.entries()).flatMap(([pluginName, tabs]) =>
			tabs.map((tab) => ({ ...tab, pluginName })),
		),
		settingsSections: Array.from(settingsSections.entries()).flatMap(([pluginName, sections]) =>
			sections.map((section) => ({ ...section, pluginName })),
		),
		chatCommands: Array.from(chatCommands.entries()).flatMap(([pluginName, commands]) =>
			commands.map((cmd) => ({ ...cmd, pluginName })),
		),
		themes: Array.from(themes.entries()).map(([pluginName, theme]) => ({ ...theme, pluginName })),
	};
}
