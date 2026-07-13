// Historically gated behind a `claude` marker file next to the app executable,
// back when Claude Subscription needed a locally-installed `claude` CLI it
// couldn't guarantee every user had. Now that Sonnet/Opus route through
// @anthropic-ai/claude-agent-sdk (which drives the CLI programmatically and
// degrades gracefully — see claude-subscription.ts / -cli-runner.ts — when
// no binary/credentials are found), that constraint no longer applies, so
// this is available to everyone. Kept as a function (not inlined at call
// sites) so the RPC/UI plumbing that already keys off it needs no changes.
export function isClaudeSubscriptionEnabled(): boolean {
  return true;
}
