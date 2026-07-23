/**
 * reasoning-support.ts — remembers which (provider, model) pairs reject the
 * `reasoning` / `reasoning_effort` option, so we stop asking.
 *
 * Every agent thinks at Medium by default, which sends `reasoning_effort` on
 * every call. Models that don't support it reject the whole request:
 *
 *   Mistral devstral-latest / codestral-latest / mistral-large-latest
 *   → 400 {"message":"reasoning_effort is not enabled for this model",...}
 *
 * Verified 100% reproducible with the option and 100% clean without it.
 *
 * Both agent loops already recover — `isThinkingUnsupportedError` strips
 * `reasoning` and retries — but that recovery was purely reactive: nothing
 * remembered the outcome, so EVERY run against such a model burned a failed
 * round-trip first. This memo makes it cost one failure instead of one per run.
 *
 * Mirrors THINKING_PARAMS_UNSUPPORTED in providers/openai.ts, which does the
 * same job for the non-standard `enable_thinking`/`thinking_budget` pair on
 * custom endpoints — same lifetime (in-memory, resets on restart) and the same
 * reasoning. Deliberately NOT persisted: a provider that later enables
 * reasoning for a model should be picked up on the next launch rather than
 * needing the user to clear a stored flag.
 */

const unsupported = new Set<string>();

/** Stable key for a provider+model pair. Provider id, not name — names are user-editable. */
export function reasoningKey(providerId: string, modelId: string): string {
	return `${providerId}::${modelId}`;
}

/** True once this pair has rejected `reasoning`; skip sending it. */
export function isReasoningUnsupported(providerId: string, modelId: string): boolean {
	return unsupported.has(reasoningKey(providerId, modelId));
}

/** Record a rejection so later runs don't repeat the failed request. */
export function markReasoningUnsupported(providerId: string, modelId: string): void {
	unsupported.add(reasoningKey(providerId, modelId));
}

/** Test seam — the memo is process-wide, so tests must be able to reset it. */
export function resetReasoningSupport(): void {
	unsupported.clear();
}
