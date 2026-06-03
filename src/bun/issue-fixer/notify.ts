// ---------------------------------------------------------------------------
// Issue Fixer — result notifications to ALL connected channels (Discord/email/etc.)
// Sends a summary on BOTH success and failure, modeled on broadcastSchedulerResult.
// ---------------------------------------------------------------------------

export interface RunResult {
	ok: boolean;
	projectId: string;
	issueNumber: number;
	issueTitle: string;
	intent: string;
	prUrl?: string | null;
	prNumber?: number | null;
	summary?: string | null;
	error?: string | null;
}

function buildMessage(r: RunResult): string {
	if (r.ok) {
		return (
			`✅ Issue Fixer (${r.intent}) finished #${r.issueNumber} "${r.issueTitle}".\n` +
			(r.prUrl ? `Pull request #${r.prNumber}: ${r.prUrl}\n` : "") +
			(r.summary ? `\n${r.summary}` : "")
		);
	}
	return `❌ Issue Fixer (${r.intent}) failed on #${r.issueNumber} "${r.issueTitle}".\n${r.error ?? "Unknown error"}`;
}

/**
 * Send the run summary to all connected channels. Best-effort — never throws
 * into the run flow.
 */
export async function notifyIssueFixResult(result: RunResult): Promise<void> {
	const message = buildMessage(result);
	try {
		const { broadcastSchedulerResult } = await import("../channels/manager");
		await broadcastSchedulerResult(`Issue Fixer #${result.issueNumber}`, message);
	} catch (err) {
		console.log(`[issue-fixer] notify: ${message}`, err instanceof Error ? err.message : "");
	}
}
