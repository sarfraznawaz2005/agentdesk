import { tool } from "ai";
import { z } from "zod";
import type { ToolRegistryEntry } from "./index";

/**
 * Build the communication tool set bound to a specific agent's identity, so the
 * question dialog can show WHO is asking. getToolsForAgent() overlays this (keyed
 * by agent name) the same way it overlays the agent-scoped kanban tools.
 *
 * Every agent uses the same wait window (the 5-minute default in engine-manager),
 * after which the dialog auto-closes and the agent continues without an answer.
 */
export function createCommunicationTools(agentName: string, displayName: string): Record<string, ToolRegistryEntry> {
	return {
		request_human_input: {
			category: "communication",
			tool: tool({
				description:
					"Ask the human user a question and wait for their answer. Pops a modal dialog in the app AND fires an " +
					"OS desktop notification, so the user is alerted even if they're on another page or the app isn't " +
					"focused. This call BLOCKS until the user responds (or it times out). Use it when you hit genuine " +
					"ambiguity, need a decision, or need information you cannot derive from context — instead of guessing. " +
					"Provide `options` to show selectable choices; omit them for a free-text answer. Use sparingly.",
				inputSchema: z.object({
					question: z.string().describe("The question to present to the user."),
					context: z
						.string()
						.optional()
						.describe("Background context that helps the user understand why the question is being asked."),
					options: z
						.array(z.string())
						.optional()
						.describe("Selectable choices to present. Omit for a free-text answer."),
				}),
				execute: async ({ question, context, options }): Promise<string> => {
					try {
						// Lazy import avoids a static cycle (engine-manager → engine → tools).
						const { askUserQuestion } = await import("../../engine-manager");
						const hasOptions = Array.isArray(options) && options.length > 0;
						const answer = await askUserQuestion({
							question,
							inputType: hasOptions ? "choice" : "text",
							options: hasOptions ? options : undefined,
							context,
							agentId: agentName,
							agentName: displayName || agentName,
						});
						return JSON.stringify({ answer });
					} catch (err) {
						return `request_human_input error: ${err instanceof Error ? err.message : String(err)}`;
					}
				},
			}),
		},
	};
}

// Static default for the base registry (no agent context). getToolsForAgent()
// overlays the agent-bound version produced by createCommunicationTools().
export const communicationTools: Record<string, ToolRegistryEntry> = createCommunicationTools("unknown", "Agent");
