import { sqlite } from "../connection";

export const name = "ai-telemetry-events";

// AI SDK v7 global telemetry sink (see docs/ai-sdk-7-migration.md §6.3/§9.1
// and src/bun/agents/telemetry-sink.ts). Drizzle-managed table (see
// schema.ts:aiTelemetryEvents) — the CREATE here keeps the raw migration
// runner and the Drizzle schema in lock-step; idempotent via IF NOT EXISTS
// so it is safe on both fresh and existing databases.
export function run(): void {
	sqlite.exec(`
CREATE TABLE IF NOT EXISTS ai_telemetry_events (
  id                        TEXT PRIMARY KEY,
  call_id                   TEXT NOT NULL,
  event_kind                TEXT NOT NULL,
  operation_id              TEXT,
  provider                  TEXT,
  model_id                  TEXT,
  function_id               TEXT,
  step_number               INTEGER,
  input_tokens              INTEGER,
  output_tokens             INTEGER,
  total_tokens              INTEGER,
  cache_read_tokens         INTEGER,
  cache_write_tokens        INTEGER,
  reasoning_tokens          INTEGER,
  finish_reason             TEXT,
  response_time_ms          INTEGER,
  time_to_first_output_ms   INTEGER,
  output_tokens_per_second  REAL,
  tool_name                 TEXT,
  tool_execution_ms         INTEGER,
  tool_success              INTEGER,
  error_message             TEXT,
  runtime_context           TEXT,
  created_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_telemetry_call_id
  ON ai_telemetry_events(call_id);

CREATE INDEX IF NOT EXISTS idx_ai_telemetry_kind_time
  ON ai_telemetry_events(event_kind, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_telemetry_provider_model_time
  ON ai_telemetry_events(provider, model_id, created_at);
`);
}
