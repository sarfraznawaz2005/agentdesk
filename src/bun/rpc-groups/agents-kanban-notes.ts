import * as agentsRpc from "../rpc/agents";
import * as kanbanRpc from "../rpc/kanban";
import * as notesRpc from "../rpc/notes";
import { broadcastToWebview } from "../engine-manager";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (params: any) => any> = {
	// Agents
	getAgents: () => agentsRpc.getAgentsList(),
	updateAgent: (params) => agentsRpc.updateAgent(params),
	resetAgent: (params) => agentsRpc.resetAgent(params.id),
	createAgent: (params) => agentsRpc.createAgent(params),
	deleteAgent: (params) => agentsRpc.deleteAgent(params.id),
	getAgentTools: (params) => agentsRpc.getAgentToolsList(params.agentId),
	setAgentTools: (params) => agentsRpc.setAgentToolsList(params.agentId, params.tools),
	getAllToolDefinitions: () => agentsRpc.getAllToolDefinitions(),
	resetAgentTools: (params) => agentsRpc.resetAgentToolsToDefaults(params.agentId),

	// Kanban
	getKanbanTasks: (params) => kanbanRpc.getKanbanTasks(params.projectId),
	getKanbanTask: (params) => kanbanRpc.getKanbanTask(params.id),
	createKanbanTask: async (params) => {
		const result = await kanbanRpc.createKanbanTask(params);
		broadcastToWebview("kanbanTaskUpdated", {
			projectId: params.projectId,
			taskId: result.id,
			action: "created",
		});
		return result;
	},
	updateKanbanTask: async (params) => {
		const result = await kanbanRpc.updateKanbanTask(params);
		// We need the projectId for the broadcast — get it from the task
		const task = await kanbanRpc.getKanbanTask(params.id);
		if (task) {
			broadcastToWebview("kanbanTaskUpdated", {
				projectId: task.projectId,
				taskId: params.id,
				action: "updated",
			});
		}
		return result;
	},
	moveKanbanTask: async (params) => {
		const task = await kanbanRpc.getKanbanTask(params.id);
		const result = await kanbanRpc.moveKanbanTask(
			params.id,
			params.column,
			params.position,
		);
		if (task) {
			broadcastToWebview("kanbanTaskUpdated", {
				projectId: task.projectId,
				taskId: params.id,
				action: "moved",
			});
		}
		return result;
	},
	deleteKanbanTask: async (params) => {
		const task = await kanbanRpc.getKanbanTask(params.id);
		const result = await kanbanRpc.deleteKanbanTask(params.id);
		if (task) {
			broadcastToWebview("kanbanTaskUpdated", {
				projectId: task.projectId,
				taskId: params.id,
				action: "deleted",
			});
		}
		return result;
	},
	getProjectTaskStats: () => kanbanRpc.getProjectTaskStats(),

	// Notes
	getProjectNotes: (params) => notesRpc.getProjectNotes(params.projectId),
	getNote: (params) => notesRpc.getNote(params.id),
	createNote: (params) => notesRpc.createNote(params),
	updateNote: (params) => notesRpc.updateNote(params),
	deleteNote: (params) => notesRpc.deleteNote(params.id),
	searchNotes: (params) => notesRpc.searchNotes(params.projectId, params.query),
	getWorkspacePlans: (params) => notesRpc.getWorkspacePlans(params.projectId),
	deleteWorkspacePlan: (params) => notesRpc.deleteWorkspacePlan(params.path),
};
