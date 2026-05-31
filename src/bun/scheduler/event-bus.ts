// src/bun/scheduler/event-bus.ts
import { EventEmitter } from "events";

export type AgentDeskEvent =
	| { type: "task:moved"; projectId: string; taskId: string; from: string; to: string }
	| { type: "task:created"; projectId: string; taskId: string }
	| { type: "deploy:completed"; projectId: string; environmentId: string; status: "success" | "error" }
	| { type: "agent:completed"; projectId: string; agentId: string; taskId?: string }
	| { type: "agent:error"; projectId: string; agentId: string; error: string }
	| { type: "agent:stale"; projectId: string; agentId: string; agentName: string }
	| { type: "message:received"; platform: string; channelId: string; sender: string }
	| { type: "cron:fired"; jobId: string; jobName: string }
	| { type: "automation:completed"; ruleId: string; ruleName: string };

class EventBusImpl {
	private emitter = new EventEmitter();

	constructor() {
		this.emitter.setMaxListeners(50);
	}

	emit(event: AgentDeskEvent): void {
		this.emitter.emit(event.type, event);
		this.emitter.emit("*", event);
	}

	on(eventType: string, handler: (event: AgentDeskEvent) => void): void {
		this.emitter.on(eventType, handler);
	}

	off(eventType: string, handler: (event: AgentDeskEvent) => void): void {
		this.emitter.off(eventType, handler);
	}

	onAny(handler: (event: AgentDeskEvent) => void): void {
		this.emitter.on("*", handler);
	}

	removeAllListeners(): void {
		this.emitter.removeAllListeners();
	}
}

export const eventBus = new EventBusImpl();
