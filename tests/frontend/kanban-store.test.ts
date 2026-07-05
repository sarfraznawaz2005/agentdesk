/**
 * kanban-store.test.ts
 *
 * Tests for src/mainview/stores/kanban-store.ts's loadTasks() staleness
 * guard — part of the original cross-project state-leak fix: a slower
 * getKanbanTasks() fetch for a project switched away from must never
 * overwrite the kanban board for whichever project is actually being viewed
 * now (rapid project switching leaves multiple fetches in flight; whichever
 * resolves last for the CURRENT activeProjectId wins, not whichever was
 * issued last).
 *
 * rpc is mocked — no real Electrobun/network/DB access. kanban-store.ts
 * registers a top-level `window.addEventListener` at import time, hence the
 * dom-shim import.
 */

import { mock, describe, it, expect, beforeEach } from "bun:test";
import "../helpers/dom-shim";

let getKanbanTasksImpl: (projectId: string) => Promise<unknown[]> = async () => [];

mock.module("../../src/mainview/lib/rpc", () => ({
	rpc: {
		getKanbanTasks: (projectId: string) => getKanbanTasksImpl(projectId),
		createKanbanTask: async () => "new-task-id",
		updateKanbanTask: async () => ({ success: true }),
		deleteKanbanTask: async () => ({ success: true }),
		moveKanbanTask: async () => ({ success: true }),
	},
}));

const { useKanbanStore } = await import("../../src/mainview/stores/kanban-store");

beforeEach(() => {
	useKanbanStore.getState().reset();
	getKanbanTasksImpl = async () => [];
});

function fakeTask(id: string, projectId: string) {
	return {
		id,
		projectId,
		title: `task ${id}`,
		description: null,
		acceptanceCriteria: null,
		importantNotes: null,
		column: "backlog",
		priority: "medium",
		assignedAgentId: null,
		blockedBy: null,
		dueDate: null,
		position: 0,
		reviewRounds: 0,
		verificationStatus: null,
		createdAt: "",
		updatedAt: "",
	};
}

describe("loadTasks", () => {
	it("applies the result when still viewing the requested project", async () => {
		getKanbanTasksImpl = async (projectId) => [fakeTask("t1", projectId)];
		await useKanbanStore.getState().loadTasks("project-A");
		expect(useKanbanStore.getState().tasks.map((t) => t.id)).toEqual(["t1"]);
		expect(useKanbanStore.getState().isLoading).toBe(false);
	});

	it("drops a late-resolving fetch for a project switched away from", async () => {
		let resolveA!: (rows: unknown[]) => void;
		getKanbanTasksImpl = (projectId: string) => {
			if (projectId === "project-A") return new Promise((resolve) => { resolveA = resolve; });
			return Promise.resolve([fakeTask("tB", "project-B")]);
		};

		const loadA = useKanbanStore.getState().loadTasks("project-A"); // in flight

		// Rapid switch to project-B, whose (faster) fetch completes first.
		await useKanbanStore.getState().loadTasks("project-B");
		expect(useKanbanStore.getState().tasks.map((t) => t.id)).toEqual(["tB"]);

		// Stale project-A fetch resolves now — before the fix this would have
		// silently overwritten project-B's board.
		resolveA([fakeTask("tA-stale", "project-A")]);
		await loadA;

		expect(useKanbanStore.getState().tasks.map((t) => t.id)).toEqual(["tB"]);
	});

	it("a stale fetch's catch branch does not clear isLoading for the now-current project", async () => {
		let rejectA!: (err: unknown) => void;
		getKanbanTasksImpl = (projectId: string) => {
			if (projectId === "project-A") return new Promise((_resolve, reject) => { rejectA = reject; });
			return new Promise(() => { /* project-B fetch never resolves in this test */ });
		};

		const loadA = useKanbanStore.getState().loadTasks("project-A");
		void useKanbanStore.getState().loadTasks("project-B"); // switches activeProjectId to B, still pending

		rejectA(new Error("network error"));
		await loadA.catch(() => {});

		// project-A's failure must not touch project-B's isLoading flag.
		expect(useKanbanStore.getState().activeProjectId).toBe("project-B");
		expect(useKanbanStore.getState().isLoading).toBe(true);
	});

	it("sets activeProjectId immediately (before the fetch resolves)", () => {
		getKanbanTasksImpl = () => new Promise(() => { /* never resolves in this test */ });
		void useKanbanStore.getState().loadTasks("project-X");
		expect(useKanbanStore.getState().activeProjectId).toBe("project-X");
	});
});
