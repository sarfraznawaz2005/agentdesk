/**
 * Statistics & Analytics
 *
 * Queries run against kanban_tasks, kanban_task_activity, messages, and cost_budgets.
 */
import { sqlite } from "../db/connection";
import { getModelCostRate, getModelsDevCatalogFetchedAt } from "../providers/model-classification";

// ── Project Dashboard ─────────────────────────────────────────────────────

export function getProjectStats(projectId: string, days = 30) {
	const since = new Date(Date.now() - days * 86400_000).toISOString();
	const global = projectId === "all";

	interface DayRow { day: string; count: number }
	const completedPerDay = global
		? sqlite.prepare(`SELECT date(updated_at) AS day, COUNT(*) AS count FROM kanban_tasks WHERE "column" = 'done' AND updated_at >= ? GROUP BY day ORDER BY day`).all(since) as DayRow[]
		: sqlite.prepare(`SELECT date(updated_at) AS day, COUNT(*) AS count FROM kanban_tasks WHERE project_id = ? AND "column" = 'done' AND updated_at >= ? GROUP BY day ORDER BY day`).all(projectId, since) as DayRow[];

	const createdPerDay = global
		? sqlite.prepare(`SELECT date(created_at) AS day, COUNT(*) AS count FROM kanban_tasks WHERE created_at >= ? GROUP BY day ORDER BY day`).all(since) as DayRow[]
		: sqlite.prepare(`SELECT date(created_at) AS day, COUNT(*) AS count FROM kanban_tasks WHERE project_id = ? AND created_at >= ? GROUP BY day ORDER BY day`).all(projectId, since) as DayRow[];

	interface ColRow { column: string; count: number }
	const byStatus = global
		? sqlite.prepare(`SELECT "column", COUNT(*) AS count FROM kanban_tasks GROUP BY "column"`).all() as ColRow[]
		: sqlite.prepare(`SELECT "column", COUNT(*) AS count FROM kanban_tasks WHERE project_id = ? GROUP BY "column"`).all(projectId) as ColRow[];

	interface PriRow { priority: string; count: number }
	const byPriority = global
		? sqlite.prepare(`SELECT priority, COUNT(*) AS count FROM kanban_tasks GROUP BY priority`).all() as PriRow[]
		: sqlite.prepare(`SELECT priority, COUNT(*) AS count FROM kanban_tasks WHERE project_id = ? GROUP BY priority`).all(projectId) as PriRow[];

	interface AvgRow { avg_hours: number | null }
	const avgCompletion = global
		? sqlite.prepare(`SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) AS avg_hours FROM kanban_tasks WHERE "column" = 'done'`).get() as AvgRow
		: sqlite.prepare(`SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) AS avg_hours FROM kanban_tasks WHERE project_id = ? AND "column" = 'done'`).get(projectId) as AvgRow;

	const activityHeatmap = global
		? sqlite.prepare(`SELECT CAST(strftime('%w', created_at) AS INTEGER) AS dow, CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS count FROM kanban_task_activity WHERE created_at >= ? GROUP BY dow, hour`).all(since) as Array<{ dow: number; hour: number; count: number }>
		: sqlite.prepare(`SELECT CAST(strftime('%w', kta.created_at) AS INTEGER) AS dow, CAST(strftime('%H', kta.created_at) AS INTEGER) AS hour, COUNT(*) AS count FROM kanban_task_activity kta JOIN kanban_tasks kt ON kt.id = kta.task_id WHERE kt.project_id = ? AND kta.created_at >= ? GROUP BY dow, hour`).all(projectId, since) as Array<{ dow: number; hour: number; count: number }>;

	return {
		completedPerDay: completedPerDay.map((r) => ({ day: r.day, count: r.count })),
		createdPerDay: createdPerDay.map((r) => ({ day: r.day, count: r.count })),
		byStatus: byStatus.map((r) => ({ status: r.column, count: r.count })),
		byPriority: byPriority.map((r) => ({ priority: r.priority, count: r.count })),
		avgCompletionHours: avgCompletion.avg_hours ?? 0,
		activityHeatmap,
		codeChurn: { added: 0, removed: 0 },
	};
}

// ── Summary for dashboard widget ─────────────────────────────────────────

export function getAnalyticsSummary(projectId: string) {
	interface SummaryRow { total_tasks: number; done_tasks: number; total_tokens: number }
	const row = sqlite.prepare(`
		SELECT
			(SELECT COUNT(*) FROM kanban_tasks WHERE project_id = ?) AS total_tasks,
			(SELECT COUNT(*) FROM kanban_tasks WHERE project_id = ? AND "column" = 'done') AS done_tasks,
			(SELECT COALESCE(SUM(m.token_count), 0) FROM messages m
			 JOIN conversations c ON c.id = m.conversation_id
			 WHERE c.project_id = ?) AS total_tokens
	`).get(projectId, projectId, projectId) as SummaryRow;

	return {
		totalTasks: row.total_tasks,
		doneTasks: row.done_tasks,
		totalTokens: row.total_tokens,
	};
}

// ── AI Usage / Cost Analytics (§9.1) ─────────────────────────────────────
// All queries read ai_telemetry_events (Phase 3.1's telemetry-sink.ts).
// "end" events carry both the aggregated per-call usage AND runtime_context
// (project/agent), so project/agent filtering needs no join there.
// "language_model_call_end"/"tool_execution_end" carry timing/tool data but
// NOT runtime_context (confirmed against the AI SDK v7 event types), so
// filtering those by project/agent requires a LEFT JOIN back to the "start"
// event of the same call_id, which does carry it.

interface TelemetryFilters { projectId?: string; agentName?: string; provider?: string }

function endEventFilter(f: TelemetryFilters): { clause: string; params: string[] } {
	const conditions: string[] = [];
	const params: string[] = [];
	if (f.projectId) { conditions.push(`json_extract(runtime_context, '$.projectId') = ?`); params.push(f.projectId); }
	if (f.agentName) { conditions.push(`json_extract(runtime_context, '$.agentName') = ?`); params.push(f.agentName); }
	if (f.provider) { conditions.push(`provider = ?`); params.push(f.provider); }
	return { clause: conditions.length ? `AND ${conditions.join(" AND ")}` : "", params };
}

function joinedEventFilter(f: TelemetryFilters): { join: string; clause: string; params: string[] } {
	const needsJoin = !!(f.projectId || f.agentName);
	const conditions: string[] = [];
	const params: string[] = [];
	if (f.projectId) { conditions.push(`json_extract(s.runtime_context, '$.projectId') = ?`); params.push(f.projectId); }
	if (f.agentName) { conditions.push(`json_extract(s.runtime_context, '$.agentName') = ?`); params.push(f.agentName); }
	if (f.provider) { conditions.push(`e.provider = ?`); params.push(f.provider); }
	return {
		join: needsJoin ? `LEFT JOIN ai_telemetry_events s ON s.call_id = e.call_id AND s.event_kind = 'start'` : "",
		clause: conditions.length ? `AND ${conditions.join(" AND ")}` : "",
		params,
	};
}

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
	return sorted[idx];
}

export async function getTelemetryUsage(filters: TelemetryFilters & { days?: number }) {
	const days = filters.days ?? 30;
	const since = new Date(Date.now() - days * 86400_000).toISOString();
	const { clause: endClause, params: endParams } = endEventFilter(filters);

	interface TotalsRow {
		calls: number; input_tokens: number; output_tokens: number;
		cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number;
	}
	const totalsRow = sqlite.prepare(`
		SELECT
			COUNT(*) AS calls,
			COALESCE(SUM(input_tokens), 0) AS input_tokens,
			COALESCE(SUM(output_tokens), 0) AS output_tokens,
			COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
			COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
			COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
		FROM ai_telemetry_events
		WHERE event_kind = 'end' AND created_at >= ? ${endClause}
	`).get(since, ...endParams) as TotalsRow;

	const cacheHitRate = totalsRow.cache_read_tokens + totalsRow.input_tokens > 0
		? totalsRow.cache_read_tokens / (totalsRow.cache_read_tokens + totalsRow.input_tokens)
		: 0;

	interface DayRow {
		day: string; input_tokens: number; output_tokens: number;
		cache_read_tokens: number; reasoning_tokens: number;
	}
	const tokensPerDay = sqlite.prepare(`
		SELECT
			date(created_at) AS day,
			COALESCE(SUM(input_tokens), 0) AS input_tokens,
			COALESCE(SUM(output_tokens), 0) AS output_tokens,
			COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
			COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
		FROM ai_telemetry_events
		WHERE event_kind = 'end' AND created_at >= ? ${endClause}
		GROUP BY day ORDER BY day
	`).all(since, ...endParams) as DayRow[];

	interface ProviderRow { provider: string | null; total_tokens: number; calls: number }
	const byProviderRows = sqlite.prepare(`
		SELECT provider, COALESCE(SUM(total_tokens), 0) AS total_tokens, COUNT(*) AS calls
		FROM ai_telemetry_events
		WHERE event_kind = 'end' AND created_at >= ? AND provider IS NOT NULL ${endClause}
		GROUP BY provider ORDER BY total_tokens DESC
	`).all(since, ...endParams) as ProviderRow[];

	interface AgentRow { agent_name: string | null; total_tokens: number; calls: number }
	const byAgentRows = sqlite.prepare(`
		SELECT json_extract(runtime_context, '$.agentName') AS agent_name, COALESCE(SUM(total_tokens), 0) AS total_tokens, COUNT(*) AS calls
		FROM ai_telemetry_events
		WHERE event_kind = 'end' AND created_at >= ? AND runtime_context IS NOT NULL ${endClause}
		GROUP BY agent_name ORDER BY total_tokens DESC
	`).all(since, ...endParams) as AgentRow[];

	const { join, clause: joinedClause, params: joinedParams } = joinedEventFilter(filters);

	interface LatencyRow { response_time_ms: number | null; time_to_first_output_ms: number | null }
	const latencyRows = sqlite.prepare(`
		SELECT e.response_time_ms, e.time_to_first_output_ms
		FROM ai_telemetry_events e
		${join}
		WHERE e.event_kind = 'language_model_call_end' AND e.created_at >= ? ${joinedClause}
	`).all(since, ...joinedParams) as LatencyRow[];

	const responseTimes = latencyRows.map((r) => r.response_time_ms).filter((v): v is number => v != null).sort((a, b) => a - b);
	const ttfoValues = latencyRows.map((r) => r.time_to_first_output_ms).filter((v): v is number => v != null);

	interface ThroughputRow { provider: string | null; model_id: string | null; avg_tps: number | null }
	const throughputRows = sqlite.prepare(`
		SELECT e.provider, e.model_id, AVG(e.output_tokens_per_second) AS avg_tps
		FROM ai_telemetry_events e
		${join}
		WHERE e.event_kind = 'language_model_call_end' AND e.output_tokens_per_second IS NOT NULL AND e.created_at >= ? ${joinedClause}
		GROUP BY e.provider, e.model_id
	`).all(since, ...joinedParams) as ThroughputRow[];

	interface ToolRow { tool_name: string | null; count: number; avg_ms: number | null; failure_rate: number | null }
	const toolRows = sqlite.prepare(`
		SELECT e.tool_name, COUNT(*) AS count, AVG(e.tool_execution_ms) AS avg_ms, AVG(1.0 - e.tool_success) AS failure_rate
		FROM ai_telemetry_events e
		${join}
		WHERE e.event_kind = 'tool_execution_end' AND e.created_at >= ? ${joinedClause}
		GROUP BY e.tool_name ORDER BY count DESC
	`).all(since, ...joinedParams) as ToolRow[];

	const agentsRows = sqlite.prepare(`
		SELECT DISTINCT json_extract(runtime_context, '$.agentName') AS agent_name
		FROM ai_telemetry_events WHERE event_kind = 'end' AND runtime_context IS NOT NULL
	`).all() as Array<{ agent_name: string | null }>;
	const providersRows = sqlite.prepare(`
		SELECT DISTINCT provider FROM ai_telemetry_events WHERE provider IS NOT NULL
	`).all() as Array<{ provider: string }>;
	const sinceRow = sqlite.prepare(`SELECT MIN(created_at) AS since FROM ai_telemetry_events`).get() as { since: string | null };

	// ── Cost (§9.1) — grouped by (provider, model) so each group can be priced
	// individually via models.dev rates (see model-classification.ts's
	// getModelCostRate). Groups with no known rate (custom providers, or a
	// model id absent from the catalog) are excluded from costUsd but counted
	// toward costCoveragePct so the $ figure never silently understates itself
	// as complete.
	interface ModelTokenRow {
		provider: string | null; model_id: string | null;
		input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; total_tokens: number;
	}
	const modelTokenRows = sqlite.prepare(`
		SELECT provider, model_id,
			COALESCE(SUM(input_tokens), 0) AS input_tokens,
			COALESCE(SUM(output_tokens), 0) AS output_tokens,
			COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
			COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
			COALESCE(SUM(total_tokens), 0) AS total_tokens
		FROM ai_telemetry_events
		WHERE event_kind = 'end' AND created_at >= ? AND provider IS NOT NULL AND model_id IS NOT NULL ${endClause}
		GROUP BY provider, model_id
	`).all(since, ...endParams) as ModelTokenRow[];

	let costUsd = 0;
	let pricedTokens = 0;
	// $ saved by prompt caching (proves out the §6.4/Phase 2.8 stable-tool-
	// ordering fix): the delta between what cache-read tokens actually cost
	// vs. what they would have cost at the full input rate. Only computed
	// when both the input and cache-read rates are known for that model.
	let costSavedUsd = 0;
	const byModel = await Promise.all(modelTokenRows.map(async (r) => {
		const rate = await getModelCostRate(r.provider, r.model_id);
		let rowCostUsd: number | null = null;
		if (rate === "free") {
			rowCostUsd = 0;
		} else if (rate) {
			rowCostUsd =
				(r.input_tokens * rate.inputPerMillion) / 1_000_000 +
				(r.output_tokens * rate.outputPerMillion) / 1_000_000 +
				(rate.cacheReadPerMillion != null ? (r.cache_read_tokens * rate.cacheReadPerMillion) / 1_000_000 : 0) +
				(rate.cacheWritePerMillion != null ? (r.cache_write_tokens * rate.cacheWritePerMillion) / 1_000_000 : 0);
			if (rate.cacheReadPerMillion != null) {
				costSavedUsd += (r.cache_read_tokens * (rate.inputPerMillion - rate.cacheReadPerMillion)) / 1_000_000;
			}
		}
		if (rowCostUsd != null) { costUsd += rowCostUsd; pricedTokens += r.total_tokens; }
		return { provider: r.provider as string, modelId: r.model_id as string, totalTokens: r.total_tokens, costUsd: rowCostUsd };
	}));
	const totalTokensForCoverage = modelTokenRows.reduce((s, r) => s + r.total_tokens, 0);

	return {
		totals: {
			calls: totalsRow.calls,
			inputTokens: totalsRow.input_tokens,
			outputTokens: totalsRow.output_tokens,
			cacheReadTokens: totalsRow.cache_read_tokens,
			cacheWriteTokens: totalsRow.cache_write_tokens,
			reasoningTokens: totalsRow.reasoning_tokens,
			cacheHitRate,
			costUsd: pricedTokens > 0 || modelTokenRows.length === 0 ? costUsd : null,
			costCoveragePct: totalTokensForCoverage > 0 ? pricedTokens / totalTokensForCoverage : 0,
			costSavedUsd,
		},
		byModel,
		pricingAsOf: (() => {
			const fetchedAt = getModelsDevCatalogFetchedAt();
			return fetchedAt != null ? new Date(fetchedAt).toISOString() : null;
		})(),
		tokensPerDay: tokensPerDay.map((r) => ({
			day: r.day, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
			cacheReadTokens: r.cache_read_tokens, reasoningTokens: r.reasoning_tokens,
		})),
		byProvider: byProviderRows.map((r) => ({ provider: r.provider ?? "unknown", totalTokens: r.total_tokens, calls: r.calls })),
		byAgent: byAgentRows.map((r) => ({ agentName: r.agent_name ?? "unknown", totalTokens: r.total_tokens, calls: r.calls })),
		latency: {
			p50Ms: percentile(responseTimes, 0.5),
			p95Ms: percentile(responseTimes, 0.95),
			avgTimeToFirstOutputMs: ttfoValues.length > 0 ? ttfoValues.reduce((a, b) => a + b, 0) / ttfoValues.length : null,
		},
		throughputByModel: throughputRows
			.filter((r) => r.avg_tps != null)
			.map((r) => ({ provider: r.provider ?? "unknown", modelId: r.model_id ?? "unknown", avgTokensPerSecond: r.avg_tps as number })),
		toolStats: toolRows.map((r) => ({
			toolName: r.tool_name ?? "unknown", count: r.count,
			avgMs: r.avg_ms ?? 0, failureRate: r.failure_rate ?? 0,
		})),
		filters: {
			agents: agentsRows.map((r) => r.agent_name).filter((v): v is string => !!v),
			providers: providersRows.map((r) => r.provider),
		},
		telemetrySince: sinceRow.since,
	};
}

// ── Provider health/status trend (§9.4) ──────────────────────────────────
// System-wide (no project/agent filter) — per-provider volume/error/latency
// trend from the same telemetry sink. Error rate is derived from "end"
// events' finish_reason='error' — the only per-provider-attributable error
// signal telemetry captures; the SDK's global onError callback carries no
// callId/provider (confirmed against the v7 Telemetry type), so it cannot
// be attributed here and is intentionally excluded rather than guessed at.
export function getProviderHealth(days = 30) {
	const since = new Date(Date.now() - days * 86400_000).toISOString();

	interface ProviderRow { provider: string | null; calls: number; errors: number; avg_response_time_ms: number | null }
	const providerRows = sqlite.prepare(`
		SELECT provider, COUNT(*) AS calls,
			SUM(CASE WHEN finish_reason = 'error' THEN 1 ELSE 0 END) AS errors,
			AVG(response_time_ms) AS avg_response_time_ms
		FROM ai_telemetry_events
		WHERE event_kind = 'end' AND created_at >= ? AND provider IS NOT NULL
		GROUP BY provider ORDER BY calls DESC
	`).all(since) as ProviderRow[];

	interface DayRow { provider: string; day: string; calls: number; errors: number }
	const dayRows = sqlite.prepare(`
		SELECT provider, date(created_at) AS day, COUNT(*) AS calls,
			SUM(CASE WHEN finish_reason = 'error' THEN 1 ELSE 0 END) AS errors
		FROM ai_telemetry_events
		WHERE event_kind = 'end' AND created_at >= ? AND provider IS NOT NULL
		GROUP BY provider, day ORDER BY day
	`).all(since) as DayRow[];

	return {
		perProvider: providerRows.map((r) => ({
			provider: r.provider as string,
			calls: r.calls,
			errors: r.errors,
			errorRate: r.calls > 0 ? r.errors / r.calls : 0,
			avgResponseTimeMs: r.avg_response_time_ms,
			callsPerDay: dayRows
				.filter((d) => d.provider === r.provider)
				.map((d) => ({ day: d.day, calls: d.calls, errors: d.errors })),
		})),
	};
}
