/**
 * Prompt debug logger — when enabled via the "debug_prompts" setting,
 * logs all prompts sent to AI providers to {userData}/logs/prompts.log.
 *
 * Works with any provider — hooks into streamText calls in engine.ts
 * and sub-agent.ts before the request is dispatched.
 */
import { Utils } from "electrobun/bun";
import {
	existsSync,
	mkdirSync,
	appendFileSync,
	writeFileSync,
	readFileSync,
	statSync,
	renameSync,
	unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { getSetting } from "../rpc/settings";

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

let enabled: boolean | null = null;
let logsDir: string | null = null;

/** Refresh the cached enabled flag from the DB. */
async function refreshEnabled(): Promise<boolean> {
	const val = await getSetting("debug_prompts", "ai");
	// getSetting JSON-parses the stored value, so a boolean true comes back
	// as actual boolean despite the string | null return type.
	enabled = val === "true" || (val as unknown) === true;
	return enabled;
}

/** Check if prompt logging is currently enabled. Caches the value. */
export async function isPromptLoggingEnabled(): Promise<boolean> {
	if (enabled !== null) return enabled;
	return refreshEnabled();
}

/** Force a re-read of the setting (call when user toggles the option). */
export function invalidatePromptLogCache(): void {
	enabled = null;
}

/** Return the full path to the prompts.log file. */
export function getPromptLogPath(): string {
	if (!logsDir) {
		logsDir = join(Utils.paths.userData, "logs");
	}
	return join(logsDir, "prompts.log");
}

/** Rotate the log file if it exceeds MAX_LOG_SIZE. */
function rotateIfNeeded(): void {
	const logPath = getPromptLogPath();
	if (!existsSync(logPath)) return;
	try {
		const { size } = statSync(logPath);
		if (size < MAX_LOG_SIZE) return;
		const old = `${logPath}.1`;
		if (existsSync(old)) unlinkSync(old);
		renameSync(logPath, old);
	} catch { /* non-critical */ }
}

/** Rough token estimate: ~4 chars per token for English text. */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Log a prompt payload to prompts.log.
 *
 * @param agent   - agent name or "PM" for the project manager
 * @param system  - system prompt
 * @param messages - the messages array sent to the model
 * @param model   - model identifier string
 */
export async function logPrompt(
	agent: string,
	system: string,
	messages: unknown[],
	model: string,
): Promise<void> {
	if (!(await isPromptLoggingEnabled())) return;

	try {
		const dir = dirname(getPromptLogPath());
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		rotateIfNeeded();

		const messagesStr = JSON.stringify(messages, null, 2);
		const systemTokens = estimateTokens(system);
		const messagesTokens = estimateTokens(messagesStr);
		const totalTokens = systemTokens + messagesTokens;

		const ts = new Date().toISOString();
		const separator = "=".repeat(80);
		const lines = [
			separator,
			`[${ts}] Agent: ${agent} | Model: ${model} | Tokens: ~${totalTokens} (system: ~${systemTokens}, messages: ~${messagesTokens})`,
			separator,
			"",
			"--- SYSTEM PROMPT ---",
			"",
			system,
			"",
			"--- CONVERSATION MESSAGES ---",
			"",
			messagesStr,
			"",
		];
		appendFileSync(getPromptLogPath(), lines.join("\n") + "\n");
	} catch {
		/* non-critical — don't break agent execution */
	}
}

/** Clear the prompt log file contents. */
export function clearPromptLog(): { success: boolean } {
	try {
		const logPath = getPromptLogPath();
		if (existsSync(logPath)) writeFileSync(logPath, "");
		// Also remove rotated copy
		const old = `${logPath}.1`;
		if (existsSync(old)) unlinkSync(old);
		return { success: true };
	} catch {
		return { success: false };
	}
}

export type PromptLogEntry = {
	timestamp: string;
	agent: string;
	model: string;
	totalTokens: number;
	systemTokens: number;
	messagesTokens: number;
};

/**
 * Parse prompt log and return per-entry stats (most recent first).
 * Only parses header lines — does not read full prompt bodies.
 */
export function getPromptLogStats(limit = 50): { entries: PromptLogEntry[]; fileSize: number } {
	try {
		const logPath = getPromptLogPath();
		if (!existsSync(logPath)) return { entries: [], fileSize: 0 };

		const { size } = statSync(logPath);
		const content = readFileSync(logPath, "utf-8");

		const headerRe = /^\[(.+?)\] Agent: (.+?) \| Model: (.+?) \| Tokens: ~(\d+) \(system: ~(\d+), messages: ~(\d+)\)$/gm;
		const entries: PromptLogEntry[] = [];
		let match: RegExpExecArray | null;

		while ((match = headerRe.exec(content)) !== null) {
			entries.push({
				timestamp: match[1],
				agent: match[2],
				model: match[3],
				totalTokens: parseInt(match[4], 10),
				systemTokens: parseInt(match[5], 10),
				messagesTokens: parseInt(match[6], 10),
			});
		}

		// Most recent first, limited
		entries.reverse();
		if (entries.length > limit) entries.length = limit;

		return { entries, fileSize: size };
	} catch {
		return { entries: [], fileSize: 0 };
	}
}

export type PromptLogEntryFull = PromptLogEntry & {
	systemPrompt: string;
	messages: string;
};

/**
 * Fetch the full content of a specific prompt log entry by its timestamp.
 * The log is split on separator lines ("====..."), and we find the block
 * whose header matches the given timestamp.
 */
export function getPromptLogEntry(timestamp: string): PromptLogEntryFull | null {
	try {
		const logPath = getPromptLogPath();
		if (!existsSync(logPath)) return null;

		const content = readFileSync(logPath, "utf-8");
		const separator = "=".repeat(80);
		const blocks = content.split(separator).filter((b) => b.trim());

		// Blocks come in pairs: [header\n===, body] but after split on ===
		// we get: header line, then body until next ===.
		// Actually the format is: ===\nheader\n===\nbody\n
		// After splitting on ===: ["", "\nheader\n", "\nbody\n", "\nheader\n", "\nbody\n", ...]
		// So headers are at odd indices (1, 3, 5...) and bodies at even indices (2, 4, 6...)

		for (let i = 0; i < blocks.length - 1; i++) {
			const block = blocks[i].trim();
			if (!block.startsWith("[")) continue;

			// Check if this header matches the timestamp
			const headerMatch = block.match(/^\[(.+?)\] Agent: (.+?) \| Model: (.+?) \| Tokens: ~(\d+) \(system: ~(\d+), messages: ~(\d+)\)$/);
			if (!headerMatch || headerMatch[1] !== timestamp) continue;

			// The body is the next block
			const body = blocks[i + 1] || "";
			const systemMatch = body.match(/--- SYSTEM PROMPT ---\n\n?([\s\S]*?)\n\n?--- CONVERSATION MESSAGES ---/);
			const messagesMatch = body.match(/--- CONVERSATION MESSAGES ---\n\n?([\s\S]*?)$/);

			return {
				timestamp: headerMatch[1],
				agent: headerMatch[2],
				model: headerMatch[3],
				totalTokens: parseInt(headerMatch[4], 10),
				systemTokens: parseInt(headerMatch[5], 10),
				messagesTokens: parseInt(headerMatch[6], 10),
				systemPrompt: systemMatch?.[1]?.trim() ?? "",
				messages: messagesMatch?.[1]?.trim() ?? "",
			};
		}
		return null;
	} catch {
		return null;
	}
}

/** Open the prompt log file in the OS default editor/viewer. */
export function openPromptLog(): { success: boolean } {
	try {
		const logPath = getPromptLogPath();
		const dir = dirname(logPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		if (!existsSync(logPath)) writeFileSync(logPath, "");

		if (process.platform === "win32") {
			spawnSync("cmd", ["/c", "start", "", logPath], { stdio: "ignore" });
		} else if (process.platform === "darwin") {
			spawnSync("open", [logPath], { stdio: "ignore" });
		} else {
			spawnSync("xdg-open", [logPath], { stdio: "ignore" });
		}
		return { success: true };
	} catch {
		return { success: false };
	}
}
