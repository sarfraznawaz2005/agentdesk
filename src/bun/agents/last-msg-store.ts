// ---------------------------------------------------------------------------
// Last-message persistence for custom dashboard agents.
// Each agent gets its own file: {userData}/last_msgs/{agentName}/last_msg.md
// The file always contains only the agent's most recent response — it is
// overwritten on every reply and survives conversation clears.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Utils } from "electrobun/bun";

function getLastMsgPath(agentName: string): string {
	return join(Utils.paths.userData, "last_msgs", agentName, "last_msg.md");
}

function getLastMsgDir(agentName: string): string {
	return join(Utils.paths.userData, "last_msgs", agentName);
}

/** Save (overwrite) the agent's last response. */
export function saveLastMessage(agentName: string, content: string): void {
	try {
		const dir = getLastMsgDir(agentName);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(getLastMsgPath(agentName), content, "utf-8");
	} catch (err) {
		console.error(`[last-msg-store] Failed to save last message for ${agentName}:`, err);
	}
}

/** Load the agent's last response, or null if none saved. */
export function loadLastMessage(agentName: string): string | null {
	try {
		const path = getLastMsgPath(agentName);
		if (!existsSync(path)) return null;
		return readFileSync(path, "utf-8") || null;
	} catch {
		return null;
	}
}

/** Delete the agent's last message file. Returns true if the file existed. */
export function removeLastMessage(agentName: string): boolean {
	try {
		const path = getLastMsgPath(agentName);
		if (!existsSync(path)) return false;
		rmSync(path);
		return true;
	} catch (err) {
		console.error(`[last-msg-store] Failed to remove last message for ${agentName}:`, err);
		return false;
	}
}

/**
 * Build the system prompt injection block.
 * Each line of the saved content is blockquoted so it reads clearly.
 */
export function buildLastMsgInjection(content: string): string {
	const quoted = content
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return `\n\n---\n\n## Your Last Message To User:\n${quoted}`;
}
