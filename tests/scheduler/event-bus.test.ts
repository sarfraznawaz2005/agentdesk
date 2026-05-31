/**
 * event-bus.test.ts
 *
 * Tests for the in-process event bus used to decouple scheduler events from
 * consumers. The bus is a thin wrapper over Node's EventEmitter, so we focus
 * on the public contract rather than implementation internals.
 */

import { describe, it, expect, beforeEach } from "bun:test";

// event-bus.ts has no external dependencies — import directly.
const { eventBus } = await import("../../src/bun/scheduler/event-bus");

// Reset listeners before each test so tests are fully isolated.
beforeEach(() => {
	eventBus.removeAllListeners();
});

describe("eventBus.on / eventBus.emit", () => {
	it("delivers an emitted event to a registered listener", async () => {
		const received: unknown[] = [];
		eventBus.on("task:created", (evt) => received.push(evt));

		eventBus.emit({ type: "task:created", projectId: "p1", taskId: "t1" });

		expect(received).toHaveLength(1);
		expect((received[0] as { type: string }).type).toBe("task:created");
	});

	it("delivers event properties to the listener", async () => {
		let captured: Record<string, unknown> | null = null;
		eventBus.on("task:moved", (evt) => { captured = evt as Record<string, unknown>; });

		eventBus.emit({ type: "task:moved", projectId: "proj", taskId: "task-1", from: "backlog", to: "working" });

		expect(captured).not.toBeNull();
		expect(captured!["projectId"]).toBe("proj");
		expect(captured!["taskId"]).toBe("task-1");
		expect(captured!["from"]).toBe("backlog");
		expect(captured!["to"]).toBe("working");
	});

	it("calls multiple listeners registered for the same event type", () => {
		const calls1: number[] = [];
		const calls2: number[] = [];

		eventBus.on("cron:fired", () => calls1.push(1));
		eventBus.on("cron:fired", () => calls2.push(2));

		eventBus.emit({ type: "cron:fired", jobId: "j1", jobName: "test-job" });

		expect(calls1).toHaveLength(1);
		expect(calls2).toHaveLength(1);
	});

	it("does not deliver events of a different type", () => {
		const calls: unknown[] = [];
		eventBus.on("task:created", (evt) => calls.push(evt));

		eventBus.emit({ type: "cron:fired", jobId: "j", jobName: "n" });

		expect(calls).toHaveLength(0);
	});
});

describe("eventBus.onAny", () => {
	it("delivers all event types to the onAny listener", () => {
		const allReceived: string[] = [];
		eventBus.onAny((evt) => allReceived.push(evt.type));

		eventBus.emit({ type: "task:created", projectId: "p", taskId: "t" });
		eventBus.emit({ type: "cron:fired", jobId: "j", jobName: "n" });
		eventBus.emit({ type: "deploy:completed", projectId: "p", environmentId: "e", status: "success" });

		expect(allReceived).toContain("task:created");
		expect(allReceived).toContain("cron:fired");
		expect(allReceived).toContain("deploy:completed");
	});

	it("receives the same event object as the typed listener", () => {
		let fromTyped: unknown;
		let fromAny: unknown;

		eventBus.on("task:created", (evt) => { fromTyped = evt; });
		eventBus.onAny((evt) => { if (evt.type === "task:created") fromAny = evt; });

		eventBus.emit({ type: "task:created", projectId: "p", taskId: "t" });

		expect(fromTyped).toEqual(fromAny);
	});
});

describe("eventBus.off", () => {
	it("stops delivering events to the removed listener", () => {
		const calls: number[] = [];
		const handler = () => calls.push(1);

		eventBus.on("task:created", handler);
		eventBus.emit({ type: "task:created", projectId: "p", taskId: "t" });
		expect(calls).toHaveLength(1);

		eventBus.off("task:created", handler);
		eventBus.emit({ type: "task:created", projectId: "p", taskId: "t2" });
		expect(calls).toHaveLength(1); // still 1, handler not called again
	});

	it("does not affect other listeners on the same event", () => {
		const callsA: number[] = [];
		const callsB: number[] = [];

		const handlerA = () => callsA.push(1);
		const handlerB = () => callsB.push(2);

		eventBus.on("cron:fired", handlerA);
		eventBus.on("cron:fired", handlerB);

		eventBus.off("cron:fired", handlerA);
		eventBus.emit({ type: "cron:fired", jobId: "j", jobName: "n" });

		expect(callsA).toHaveLength(0);
		expect(callsB).toHaveLength(1);
	});
});

describe("eventBus.removeAllListeners", () => {
	it("clears all registered listeners", () => {
		const calls: number[] = [];
		eventBus.on("task:created", () => calls.push(1));
		eventBus.onAny(() => calls.push(2));

		eventBus.removeAllListeners();
		eventBus.emit({ type: "task:created", projectId: "p", taskId: "t" });

		expect(calls).toHaveLength(0);
	});
});

describe("event object integrity", () => {
	it("deploy:completed event properties are accessible in handler", () => {
		let captured: Record<string, unknown> | null = null;
		eventBus.on("deploy:completed", (evt) => { captured = evt as Record<string, unknown>; });

		eventBus.emit({ type: "deploy:completed", projectId: "proj-1", environmentId: "env-1", status: "error" });

		expect(captured!["projectId"]).toBe("proj-1");
		expect(captured!["environmentId"]).toBe("env-1");
		expect(captured!["status"]).toBe("error");
	});

	it("automation:completed event properties are accessible in handler", () => {
		let captured: Record<string, unknown> | null = null;
		eventBus.on("automation:completed", (evt) => { captured = evt as Record<string, unknown>; });

		eventBus.emit({ type: "automation:completed", ruleId: "rule-1", ruleName: "My Rule" });

		expect(captured!["ruleId"]).toBe("rule-1");
		expect(captured!["ruleName"]).toBe("My Rule");
	});
});
