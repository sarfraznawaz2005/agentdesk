import type { Tool } from "ai";
import { isDevChannel } from "../lib/dev-mode";

/**
 * Wrap every tool's execute() with a console.log pair (call + done/error) so
 * scheduled/automation runs can be audited for which tools an actor actually
 * invoked, not just what its text claims. Reusable across any flat tool set:
 * the PM's own tools (engine.ts), and the project-less agent_task_simple
 * tool set (task-executor.ts). Sub-agents dispatched via runInlineAgent get
 * the equivalent logging from the toolTimings wrap in agent-loop.ts.
 *
 * Logging only fires on the "dev" channel — it's a debugging aid, not
 * something production/canary builds should spam to stdout for.
 */
export function wrapToolsWithCallLogging<T extends Record<string, Tool>>(tools: T, actorLabel: string): T {
	const wrapped = { ...tools } as T;
	for (const [name, t] of Object.entries(tools)) {
		const orig = (t as Tool & { execute?: (a: unknown, o: unknown) => Promise<unknown> }).execute;
		if (typeof orig !== "function") continue;
		(wrapped as Record<string, Tool>)[name] = {
			...t,
			execute: async (args: unknown, execOpts: unknown) => {
				const start = Date.now();
				const devLog = isDevChannel();
				if (devLog) console.log(`[TOOLCALL] agent=${actorLabel} tool=${name} args=${JSON.stringify(args ?? {}).slice(0, 300)}`);
				try {
					const result = await orig(args, execOpts);
					if (devLog) console.log(`[TOOLCALL DONE] agent=${actorLabel} tool=${name} durationMs=${Date.now() - start}`);
					return result;
				} catch (err) {
					if (devLog) console.log(`[TOOLCALL ERROR] agent=${actorLabel} tool=${name} durationMs=${Date.now() - start} error=${err instanceof Error ? err.message : String(err)}`);
					throw err;
				}
			},
		} as Tool;
	}
	return wrapped;
}
