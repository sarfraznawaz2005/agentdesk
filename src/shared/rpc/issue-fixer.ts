// RPC contract for the Issue Fixer feature.

export interface IssueFixerConfigDto {
	projectId: string;
	enabled: boolean;
	keywords: string[];
	labels: string[];
	authMode: "collab" | "label" | "both";
	pollIntervalMin: number;
	autonomy: "branch_pr" | "draft";
	testCommand: string | null;
	customInstructions: string | null;
	tokenSource: "global" | "custom";
	cooldownSec: number;
	maxPerHour: number;
	notifyChannels: string[];
	cursorAt: string | null;
	lastPolledAt: string | null;
}

export interface IssueFixRunDto {
	id: string;
	projectId: string;
	issueNumber: number;
	issueTitle: string;
	issueUrl: string | null;
	triggerType: string;
	triggerKeyword: string | null;
	intent: string;
	author: string | null;
	authorized: boolean;
	status: string;
	branchName: string | null;
	prNumber: number | null;
	prUrl: string | null;
	testPassed: boolean | null;
	summary: string | null;
	error: string | null;
	startedAt: string;
	finishedAt: string | null;
}

export interface IssueFixerKeywordDto {
	keyword: string;
	intent: string;
	description: string;
}

/** In-memory snapshot of the latest run for a project (mirrors the frontend store). */
export interface ActiveIssueFixRunDto {
	runId: string;
	issueNumber: number;
	issueTitle: string;
	intent: string;
	status: string;
	running: boolean;
	parts: Record<string, unknown>[];
	prNumber: number | null;
	prUrl: string | null;
	error: string | null;
}

export type IssueFixerRequests = {
	getIssueFixerConfig: {
		params: { projectId: string };
		response: { config: IssueFixerConfigDto | null };
	};
	saveIssueFixerConfig: {
		params: { projectId: string; config: Partial<Omit<IssueFixerConfigDto, "projectId">> };
		response: { config: IssueFixerConfigDto };
	};
	listIssueFixRuns: {
		params: { projectId: string; limit?: number };
		response: { runs: IssueFixRunDto[] };
	};
	getIssueFixRun: {
		params: { id: string };
		response: { run: IssueFixRunDto | null };
	};
	/** Current/most-recent live run snapshot (in-memory) so the Activity tab can hydrate
	 *  on mount — covers runs whose start/part broadcasts the webview missed (e.g. the
	 *  startup poll firing before the UI attached its listeners). */
	getActiveIssueFixRun: {
		params: { projectId: string };
		response: { run: ActiveIssueFixRunDto | null };
	};
	/** Poll this project's GitHub issues/comments immediately (out of band). */
	pollIssueFixerNow: {
		params: { projectId: string };
		response: { ok: boolean };
	};
	/** Cancel the in-flight run (aborts the agent + marks the run failed). */
	cancelIssueFixRun: {
		params: { runId: string };
		response: { ok: boolean };
	};
	/** Manually queue an Issue Fixer run for a specific issue (intent = fix). */
	triggerIssueFixManually: {
		params: { projectId: string; issueNumber: number };
		response: { ok: boolean; error?: string };
	};
	/** The predefined agentdesk-* keyword catalog (for the settings UI). */
	getIssueFixerKeywordCatalog: {
		params: Record<string, never>;
		response: { keywords: IssueFixerKeywordDto[] };
	};
};
