/**
 * telemetry-sink.ts — AI SDK v7 global telemetry integration.
 *
 * Implements the `Telemetry` interface (see docs/ai-sdk-7-migration.md
 * §6.3/§9.1) and is registered ONCE, globally, via `registerTelemetry()` in
 * src/bun/index.ts's startup path. Because v7 telemetry is "enabled by
 * default when a telemetry integration is registered," every existing
 * streamText/generateText call site across all 9+ independent surfaces
 * starts reporting here with zero per-call-site changes — that was the
 * whole point of landing this ahead of the rest of Phase 3.
 *
 * Deliberately a single wide events table (ai_telemetry_events), not a
 * normalized per-event-type schema — see schema.ts's comment on the table
 * for why. Every write is fire-and-forget and non-fatal: a telemetry sink
 * must never be able to break or slow down a real agent turn.
 *
 * Scope note: `runtimeContext` is recorded whenever a call provides one, but
 * no call site sets it yet — that's Phase 3.2's job. Until then this column
 * stays empty; no future migration is needed once it starts flowing.
 */
import type { Telemetry } from "ai";
import { db } from "../db";
import { aiTelemetryEvents } from "../db/schema";

function insert(row: Partial<typeof aiTelemetryEvents.$inferInsert> & { callId: string; eventKind: string }): void {
	db.insert(aiTelemetryEvents).values(row as typeof aiTelemetryEvents.$inferInsert).catch(() => {
		/* non-fatal — telemetry must never break a real agent turn */
	});
}

function serializeRuntimeContext(runtimeContext: unknown): string | undefined {
	if (runtimeContext == null || typeof runtimeContext !== "object") return undefined;
	if (Object.keys(runtimeContext as object).length === 0) return undefined;
	try {
		return JSON.stringify(runtimeContext);
	} catch {
		return undefined;
	}
}

export const telemetrySink: Telemetry = {
	onStart(event) {
		// OperationStartEvent also covers generateObject/embed/rerank, which don't
		// all carry a `runtimeContext` field shaped like GenerateTextStartEvent's.
		insert({
			callId: event.callId,
			eventKind: "start",
			operationId: event.operationId,
			provider: event.provider,
			modelId: event.modelId,
			functionId: event.functionId,
			runtimeContext: "runtimeContext" in event ? serializeRuntimeContext(event.runtimeContext) : undefined,
		});
	},

	onLanguageModelCallEnd(event) {
		const usage = event.usage;
		insert({
			callId: event.callId,
			eventKind: "language_model_call_end",
			provider: event.provider,
			modelId: event.modelId,
			finishReason: event.finishReason,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			totalTokens: usage.totalTokens,
			cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
			cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
			reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
			responseTimeMs: Math.round(event.performance.responseTimeMs),
			timeToFirstOutputMs:
				event.performance.timeToFirstOutputMs != null ? Math.round(event.performance.timeToFirstOutputMs) : undefined,
			outputTokensPerSecond: event.performance.effectiveOutputTokensPerSecond,
		});
	},

	onToolExecutionEnd(event) {
		insert({
			callId: event.callId,
			eventKind: "tool_execution_end",
			toolName: event.toolCall.toolName,
			toolExecutionMs: Math.round(event.toolExecutionMs),
			toolSuccess: event.toolOutput.type === "tool-result" ? 1 : 0,
		});
	},

	onEnd(event) {
		// OperationEndEvent also covers generateObject/embed/rerank, which don't
		// carry a `usage`/`model` field shaped like GenerateTextEndEvent's — only
		// record the fields that are actually present on this specific event.
		if (!("usage" in event) || !("model" in event)) return;
		const usage = event.usage;
		insert({
			callId: event.callId,
			eventKind: "end",
			provider: event.model?.provider,
			modelId: event.model?.modelId,
			finishReason: "finishReason" in event ? (event.finishReason as string | undefined) : undefined,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			totalTokens: usage.totalTokens,
			cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
			cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
			reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
			runtimeContext: "runtimeContext" in event ? serializeRuntimeContext(event.runtimeContext) : undefined,
		});
	},

	onAbort(event) {
		insert({ callId: event.callId, eventKind: "abort" });
	},

	onError(error) {
		// error is untyped per the Telemetry interface (Error | AISDKError | unknown)
		// and carries no callId — record what we can without crashing on a bad shape.
		const message = error instanceof Error ? error.message : String(error);
		insert({ callId: "unknown", eventKind: "error", errorMessage: message.slice(0, 2000) });
	},
};
