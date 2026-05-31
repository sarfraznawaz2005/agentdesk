import { tool } from "ai";
import { z } from "zod";
import type { ToolRegistryEntry } from "./index";

export const communicationTools: Record<string, ToolRegistryEntry> = {
	request_human_input: {
		category: "communication",
		tool: tool({
			description:
				"Request input from the human user. This queues a blocking prompt that the user must answer before the agent can continue. Use sparingly — only when ambiguity cannot be resolved from existing context.",
			inputSchema: z.object({
				question: z
					.string()
					.describe("The question to present to the user."),
				context: z
					.string()
					.optional()
					.describe(
						"Additional background context that helps the user understand why the question is being asked.",
					),
				options: z
					.array(z.string())
					.optional()
					.describe(
						"Suggested options the user may choose from (shown as hints, not enforced).",
					),
			}),
			execute: async (args) => {
				try {
					return JSON.stringify({
						queued: true,
						question: args.question,
						note: "Human input request has been queued. The response will be provided by the PM agent.",
					});
				} catch (err) {
					return `request_human_input error: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
		}),
	},
};
