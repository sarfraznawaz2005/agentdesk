import * as pluginsRpc from "../rpc/plugins";
import * as pluginExtensionsRpc from "../rpc/plugin-extensions";
import * as skillsRpc from "../rpc/skills";
import * as skillsChatRpc from "../rpc/skills-search-chat";
import * as lspRpc from "../rpc/lsp";
import * as dbViewerRpc from "../rpc/db-viewer";
import * as mcpRpc from "../rpc/mcp";
import * as maintenanceRpc from "../rpc/maintenance";
import * as searchRpc from "../rpc/search";
import * as promptsRpc from "../rpc/prompts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (params: any) => any> = {
	// Plugins
	getPlugins: () => pluginsRpc.getPluginsList(),
	togglePlugin: (params) => pluginsRpc.togglePlugin(params.name, params.enabled),
	getPluginSettings: (params) => pluginsRpc.getPluginSettings(params.name),
	savePluginSettings: (params) => pluginsRpc.savePluginSettings(params.name, params.settings),
	savePluginPrompt: (params) => pluginsRpc.savePluginPrompt(params.name, params.prompt),

	// Plugin Extensions
	getPluginExtensions: () => pluginExtensionsRpc.getPluginExtensions(),

	// Skills
	getSkills: () => skillsRpc.getSkills(),
	getSkill: (params) => skillsRpc.getSkill(params.name),
	refreshSkills: () => skillsRpc.refreshSkills(),
	getSkillsDirectory: () => skillsRpc.getSkillsDirectory(),
	openSkillInEditor: (params) => skillsRpc.openSkillInEditor(params.name),
	openSkillsFolder: () => skillsRpc.openSkillsFolder(),
	getAvailableTools: () => skillsRpc.getAvailableTools(),
	deleteSkill: (params) => skillsRpc.deleteSkill(params.name),

	// Skills Search Chat (human-facing chat wrapping the search-skills skill)
	"skillsChat.getMessages": () => skillsChatRpc.getMessages(),
	"skillsChat.sendMessage": (params) => skillsChatRpc.sendMessage(params),
	"skillsChat.regenerate": () => skillsChatRpc.regenerate(),
	"skillsChat.clearMessages": () => skillsChatRpc.clearMessages(),
	"skillsChat.stop": () => skillsChatRpc.stopChat(),

	// LSP
	getLspStatus: () => lspRpc.getLspStatus(),
	installLspServer: (params) => lspRpc.installLspServerHandler(params.serverId),
	uninstallLspServer: (params) => lspRpc.uninstallLspServerHandler(params.serverId),

	// Database Viewer
	dbViewerGetTables: () => dbViewerRpc.dbViewerGetTables(),
	dbViewerGetRows: (p) => dbViewerRpc.dbViewerGetRows(p.table, p.page, p.pageSize ?? 20),
	dbViewerDeleteRow: (p) => dbViewerRpc.dbViewerDeleteRow(p.table, p.id),

	// MCP
	getMcpConfig: () => mcpRpc.getMcpConfig(),
	saveMcpConfig: (params) => mcpRpc.saveMcpConfig(params.configJson),
	getMcpStatus: () => mcpRpc.getMcpStatusRpc(),
	reconnectMcpServer: (p) => mcpRpc.reconnectMcpServerRpc(p.name),
	disconnectMcpServer: (p) => mcpRpc.disconnectMcpServerRpc(p.name),

	// Database Maintenance
	optimizeDatabase: () => maintenanceRpc.optimizeDatabase(),
	vacuumDatabase: () => maintenanceRpc.vacuumDatabase(),
	pruneDatabase: (params) => maintenanceRpc.pruneDatabase(params.days),
	getMaintenanceStatus: () => maintenanceRpc.getMaintenanceStatus(),

	// Search
	globalSearch: (params) => searchRpc.globalSearch(params.query),

	// Prompts (template library)
	getPrompts: () => promptsRpc.getPrompts(),
	savePrompt: (params) => promptsRpc.savePrompt(params),
	deletePrompt: (params) => promptsRpc.deletePrompt(params.id),
	searchPrompts: (params) => promptsRpc.searchPrompts(params.query),
};
