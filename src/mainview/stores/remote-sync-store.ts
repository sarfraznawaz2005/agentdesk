import { create } from "zustand";

export interface RemoteSyncLogLine {
	level: "info" | "warn" | "error";
	message: string;
	at: string;
}

export interface RemoteSyncRunState {
	runId: string;
	direction: "pull" | "push";
	running: boolean;
	total: number;
	done: number;
	ok: number;
	failed: number;
	currentFile: string | null;
	status: string;
	summary: string | null;
	error: string | null;
}

interface RemoteSyncStore {
	runByProject: Record<string, RemoteSyncRunState | undefined>;
	logsByProject: Record<string, RemoteSyncLogLine[]>;
	clearLogs: (projectId: string) => void;
}

export const useRemoteSyncStore = create<RemoteSyncStore>((set) => ({
	runByProject: {},
	logsByProject: {},
	clearLogs: (projectId) =>
		set((s) => ({ logsByProject: { ...s.logsByProject, [projectId]: [] } })),
}));

const MAX_LOGS = 300;

interface StartedDetail {
	projectId: string;
	runId: string;
	direction: "pull" | "push";
	totalFiles: number;
}
interface ProgressDetail {
	projectId: string;
	runId: string;
	direction: "pull" | "push";
	file: string;
	status: "start" | "ok" | "error";
	index: number;
	total: number;
	error?: string;
}
interface CompleteDetail {
	projectId: string;
	runId: string;
	direction: "pull" | "push";
	status: string;
	okFiles: number;
	failedFiles: number;
	bytes: number;
	summary: string;
}
interface ErrorDetail {
	projectId: string;
	runId: string;
	error: string;
}
interface LogDetail {
	projectId: string;
	level: "info" | "warn" | "error";
	message: string;
	at: string;
}

let initialized = false;

/** Attach the window listeners that translate backend broadcasts into store state.
 *  Idempotent — safe to call from every mounting Remote tab. */
export function initRemoteSyncListeners(): void {
	if (initialized) return;
	initialized = true;
	const set = useRemoteSyncStore.setState;

	window.addEventListener("agentdesk:remotesync-run-started", (e) => {
		const d = (e as CustomEvent<StartedDetail>).detail;
		set((s) => ({
			runByProject: {
				...s.runByProject,
				[d.projectId]: {
					runId: d.runId,
					direction: d.direction,
					running: true,
					total: d.totalFiles,
					done: 0,
					ok: 0,
					failed: 0,
					currentFile: null,
					status: "running",
					summary: null,
					error: null,
				},
			},
		}));
	});

	window.addEventListener("agentdesk:remotesync-progress", (e) => {
		const d = (e as CustomEvent<ProgressDetail>).detail;
		set((s) => {
			const prev = s.runByProject[d.projectId];
			if (!prev || prev.runId !== d.runId) return s;
			const next: RemoteSyncRunState = { ...prev, total: d.total };
			if (d.status === "start") {
				next.currentFile = d.file;
			} else if (d.status === "ok") {
				next.ok = prev.ok + 1;
				next.done = prev.done + 1;
			} else if (d.status === "error") {
				next.failed = prev.failed + 1;
				next.done = prev.done + 1;
			}
			return { runByProject: { ...s.runByProject, [d.projectId]: next } };
		});
	});

	window.addEventListener("agentdesk:remotesync-run-complete", (e) => {
		const d = (e as CustomEvent<CompleteDetail>).detail;
		set((s) => {
			const prev = s.runByProject[d.projectId];
			if (!prev) return s;
			return {
				runByProject: {
					...s.runByProject,
					[d.projectId]: {
						...prev,
						running: false,
						status: d.status,
						ok: d.okFiles,
						failed: d.failedFiles,
						summary: d.summary,
					},
				},
			};
		});
	});

	window.addEventListener("agentdesk:remotesync-run-error", (e) => {
		const d = (e as CustomEvent<ErrorDetail>).detail;
		set((s) => {
			const prev = s.runByProject[d.projectId];
			if (!prev) return s;
			return {
				runByProject: {
					...s.runByProject,
					[d.projectId]: { ...prev, running: false, status: "error", error: d.error },
				},
			};
		});
	});

	window.addEventListener("agentdesk:remotesync-log", (e) => {
		const d = (e as CustomEvent<LogDetail>).detail;
		set((s) => {
			const prev = s.logsByProject[d.projectId] ?? [];
			const next = [...prev, { level: d.level, message: d.message, at: d.at }];
			if (next.length > MAX_LOGS) next.splice(0, next.length - MAX_LOGS);
			return { logsByProject: { ...s.logsByProject, [d.projectId]: next } };
		});
	});
}
