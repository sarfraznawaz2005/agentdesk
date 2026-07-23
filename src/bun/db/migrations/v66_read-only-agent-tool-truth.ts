import { sqlite } from "../connection";
import { isToolStrippedAtDispatch } from "../../../shared/agent-capabilities";

export const name = "read-only-agent-tool-truth";

/**
 * Remove write-capable `agent_tools` rows from read-only agents.
 *
 * These rows were never functional: `filterReadOnlyTools` (agent-loop.ts)
 * strips every WRITE_TOOL from a read-only agent at dispatch, regardless of
 * what `agent_tools` says. But Settings → Agents → Tools read straight from
 * those rows, so `run_shell` rendered as an enabled toggle on `code-explorer`
 * — an agent that can never run a shell command. Anyone debugging why the
 * agent "refused" to use its shell started from a false premise, because the
 * DB and the runtime disagreed.
 *
 * Three concrete rows this clears on existing installs:
 *  - code-explorer      → run_shell         (SHELL dropped from its seed defaults)
 *  - research-expert    → run_background, kill_process
 *                         (PROCESS → PROCESS_READ; run_background is literally
 *                          "spawn a shell command as a background process", so it
 *                          now belongs to WRITE_TOOLS and is stripped like shell)
 *
 * Expressed as the general rule rather than those three special cases, so it
 * also catches any other stale write row a read-only agent picked up from an
 * older seed, and stays correct if the read-only roster changes later.
 *
 * `task-planner`'s `create_task` is preserved — `isToolStrippedAtDispatch`
 * honours READ_ONLY_WRITE_EXCEPTIONS, and task-planner is the sole task author.
 *
 * Additions (git_show, query_sqlite, PROCESS_READ, checksum, file_permissions)
 * need no work here: `seedAgentTools()`'s per-boot backfill already adds any
 * default tool an agent is missing. Only removals require a migration, because
 * that backfill never deletes.
 *
 * Idempotent — a second run finds nothing left to delete.
 */
export function run(): void {
	const rows = sqlite
		.prepare("SELECT at.id AS rowId, a.name AS agentName, at.tool_name AS toolName FROM agent_tools at JOIN agents a ON a.id = at.agent_id")
		.all() as Array<{ rowId: string; agentName: string; toolName: string }>;

	const doomed = rows.filter((r) => isToolStrippedAtDispatch(r.agentName, r.toolName));
	if (doomed.length === 0) return;

	const stmt = sqlite.prepare("DELETE FROM agent_tools WHERE id = ?");
	for (const row of doomed) stmt.run(row.rowId);

	console.log(`[migrate] Removed ${doomed.length} unusable write-tool row(s) from read-only agents.`);
}
