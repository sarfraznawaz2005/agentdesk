import { create } from "zustand";

export interface IssueFixerPart {
	id: string;
	type: string;
	content: string;
	toolName?: string;
	toolInput?: string;
	toolOutput?: string;
	toolState?: string;
	sortOrder: number;
	agentName?: string;
	timeStart?: string;
	timeEnd?: string;
}

export interface IssueFixerRunState {
	runId: string;
	issueNumber: number;
	issueTitle: string;
	intent: string;
	status: string;
	running: boolean;
	parts: IssueFixerPart[];
	prNumber: number | null;
	prUrl: string | null;
	error: string | null;
}

interface IssueFixerStore {
	/** Live state of the most recent run, keyed by projectId. */
	byProject: Record<string, IssueFixerRunState>;
	reset: (projectId: string) => void;
	/** Seed the store from a backend snapshot (Activity tab hydration on mount). */
	hydrate: (projectId: string, snapshot: IssueFixerRunState) => void;
}

export const useIssueFixerStore = create<IssueFixerStore>((set) => ({
	byProject: {},
	reset: (projectId) =>
		set((s) => {
			const { [projectId]: _removed, ...rest } = s.byProject;
			void _removed;
			return { byProject: rest };
		}),
	hydrate: (projectId, snap) =>
		set((s) => {
			const cur = s.byProject[projectId];
			// If a live run for the same run is already at least as current (broadcasts
			// may be ahead of the snapshot), keep its parts and just reconcile terminal
			// fields. Otherwise the snapshot is authoritative — adopt it.
			if (cur && cur.runId === snap.runId && cur.parts.length >= snap.parts.length) {
				return {
					byProject: {
						...s.byProject,
						[projectId]: { ...cur, status: snap.status, running: snap.running, prNumber: snap.prNumber, prUrl: snap.prUrl, error: snap.error },
					},
				};
			}
			return { byProject: { ...s.byProject, [projectId]: snap } };
		}),
}));

const EMPTY: IssueFixerRunState = {
	runId: "",
	issueNumber: 0,
	issueTitle: "",
	intent: "",
	status: "",
	running: false,
	parts: [],
	prNumber: null,
	prUrl: null,
	error: null,
};

interface StartedDetail {
	projectId: string;
	runId: string;
	issueNumber: number;
	issueTitle: string;
	intent: string;
}
interface PartDetail {
	projectId: string;
	runId: string;
	part: IssueFixerPart;
}
interface PartUpdatedDetail {
	projectId: string;
	runId: string;
	partId: string;
	updates: Partial<IssueFixerPart>;
}
interface CompleteDetail {
	projectId: string;
	runId: string;
	status: string;
	prNumber: number | null;
	prUrl: string | null;
}
interface ErrorDetail {
	projectId: string;
	runId: string;
	error: string;
}

let attached = false;

/** Attach the window event listeners that feed the store. Safe to call repeatedly. */
export function initIssueFixerListeners(): void {
	if (attached || typeof window === "undefined") return;
	attached = true;
	const set = useIssueFixerStore.setState;

	const patch = (projectId: string, p: Partial<IssueFixerRunState>) =>
		set((s) => {
			const base = s.byProject[projectId] ?? EMPTY;
			return { byProject: { ...s.byProject, [projectId]: { ...base, ...p } } };
		});

	window.addEventListener("agentdesk:issuefixer-run-started", (e) => {
		const d = (e as CustomEvent<StartedDetail>).detail;
		set((s) => ({
			byProject: {
				...s.byProject,
				[d.projectId]: {
					...EMPTY,
					runId: d.runId,
					issueNumber: d.issueNumber,
					issueTitle: d.issueTitle,
					intent: d.intent,
					status: "fixing",
					running: true,
				},
			},
		}));
	});

	window.addEventListener("agentdesk:issuefixer-part", (e) => {
		const d = (e as CustomEvent<PartDetail>).detail;
		set((s) => {
			const cur = s.byProject[d.projectId];
			if (!cur) return s;
			const idx = cur.parts.findIndex((p) => p.id === d.part.id);
			const parts = idx >= 0 ? cur.parts.map((p, i) => (i === idx ? d.part : p)) : [...cur.parts, d.part];
			return { byProject: { ...s.byProject, [d.projectId]: { ...cur, parts } } };
		});
	});

	window.addEventListener("agentdesk:issuefixer-part-updated", (e) => {
		const d = (e as CustomEvent<PartUpdatedDetail>).detail;
		set((s) => {
			const cur = s.byProject[d.projectId];
			if (!cur) return s;
			const parts = cur.parts.map((p) => (p.id === d.partId ? { ...p, ...d.updates } : p));
			return { byProject: { ...s.byProject, [d.projectId]: { ...cur, parts } } };
		});
	});

	window.addEventListener("agentdesk:issuefixer-run-complete", (e) => {
		const d = (e as CustomEvent<CompleteDetail>).detail;
		patch(d.projectId, { status: d.status, running: false, prNumber: d.prNumber, prUrl: d.prUrl });
	});

	window.addEventListener("agentdesk:issuefixer-run-error", (e) => {
		const d = (e as CustomEvent<ErrorDetail>).detail;
		patch(d.projectId, { status: "failed", running: false, error: d.error });
	});
}

// Attach at module load (mirrors chat-store's initChatEventHandlers side-effect) so a
// live run streams into the store even if the user has never opened the Issue Fixer tab
// this session. The backend agent runs regardless; this keeps the live view in sync
// across tab/page switches. Idempotent via the `attached` guard.
initIssueFixerListeners();
