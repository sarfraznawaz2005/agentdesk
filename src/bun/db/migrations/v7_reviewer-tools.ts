import { sqlite } from "../connection";

export const name = "reviewer-tools";

/**
 * Remove verify_implementation from the code-reviewer agent's tools.
 * verify_implementation is for implementers — code-reviewer should only
 * call submit_review to deliver its verdict.
 */
export function run(): void {
	// Find the code-reviewer agent ID
	const agent = sqlite
		.prepare("SELECT id FROM agents WHERE name = 'code-reviewer' LIMIT 1")
		.get() as { id: string } | undefined;

	if (!agent) return;

	sqlite
		.prepare("DELETE FROM agent_tools WHERE agent_id = ? AND tool_name = 'verify_implementation'")
		.run(agent.id);
}
