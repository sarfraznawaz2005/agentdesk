// ---------------------------------------------------------------------------
// General Chat temp-folder layout
//
//   {os.tmpdir()}/agentdesk-general-chat/<conversationId>/
//
// Unlike the Playground (one shared, reused temp root), Assistant gets a
// FRESH subfolder per conversation — conversations never share a workspace.
// ---------------------------------------------------------------------------

import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

export const GENERAL_CHAT_ROOT = path.join(os.tmpdir(), "agentdesk-general-chat");

/** Absolute workspace path for a conversation, created lazily on first use. */
export function getGeneralChatWorkspacePath(conversationId: string): string {
	const dir = path.join(GENERAL_CHAT_ROOT, conversationId);
	mkdirSync(dir, { recursive: true });
	return dir;
}
