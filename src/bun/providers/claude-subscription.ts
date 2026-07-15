import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

// Path candidates for the claude CLI — same dir as the app exe first, then PATH.
//
// IMPORTANT: the bare "claude" candidate (no extension) is the exact same path
// as the empty "claude" feature-flag marker file historically checked by
// isClaudeSubscriptionEnabled() (see claude/feature-flag.ts) in this same
// directory — a real bundled binary is never 0 bytes, the flag file always
// was. resolveClaudeCliPath() below skips any 0-byte candidate rather than
// doing a bare existsSync() check, which would otherwise mistake that marker
// file for the CLI itself.
export const CLAUDE_CLI_CANDIDATES = [
  join(dirname(process.execPath), "claude"),
  join(dirname(process.execPath), "claude.exe"),
  "claude",
];

export function resolveClaudeCliPath(): string {
  for (const candidate of CLAUDE_CLI_CANDIDATES) {
    if (candidate === "claude") return candidate; // bare name — rely on PATH
    try {
      if (existsSync(candidate) && statSync(candidate).size > 0) return candidate;
    } catch {
      // Fall through to the next candidate
    }
  }
  return "claude";
}

// Last-resort fallback only — used when the dynamic /v1/models lookup below
// fails (offline, API down, endpoint unreachable). Never the primary source:
// model names/aliases change over time (e.g. claude-opus-4-20250514 and
// claude-sonnet-4-20250514 have since been retired — confirmed via a live
// 404 — so this list is deliberately pruned to currently-valid IDs), so
// anything relying on this list staying current would silently go stale.
export const CLAUDE_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
];

/** Only Haiku is known to work over this adapter's direct-HTTP OAuth-header-
 *  impersonation path — Sonnet/Opus consistently 429 with rate_limit_error on
 *  that path specifically (verified live: replicating the real `claude` CLI's
 *  actual headers, billing/client-request-id attribution, and even its
 *  bootstrap handshake still 429s identically, and the 429 lacks the normal
 *  rate-limit accounting headers — a server-side gate upstream of quota, not
 *  a header AgentDesk is missing). Non-Haiku models route through the
 *  official Agent SDK instead — see claude-subscription-cli-runner.ts, wired
 *  in at src/bun/agents/agent-loop.ts. */
export function isHaikuModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("haiku");
}

/** Model ID to use for a tool's OWN internal, standalone LLM call (e.g.
 *  deep_research's planner/evaluator/synthesis steps, set_feature_branch's
 *  naming call, preview_project's AI detection) — these create a fresh model
 *  instance directly via createProviderAdapter().createModel() rather than
 *  reusing the calling agent's model, so they bypass agent-loop.ts/engine.ts's
 *  CLI/SDK routing entirely and would hit the same direct-HTTP 429 as any
 *  other non-Haiku Claude Subscription call. These are all bounded, simple
 *  text tasks (structured JSON planning, branch naming, project-type
 *  classification) well within Haiku's reach, so swap to it rather than
 *  building CLI/SDK routing for every standalone internal LLM call in the
 *  codebase. No-op for every other provider. */
export function internalCallModelId(providerType: string, modelId: string): string {
  if (providerType === "claude-subscription" && !isHaikuModel(modelId)) {
    return "claude-haiku-4-5-20251001";
  }
  return modelId;
}

interface OAuthCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface CredentialsFile {
  claudeAiOauth?: OAuthCredentials;
}

function readCredentialsFile(): CredentialsFile {
  const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
  return JSON.parse(raw) as CredentialsFile;
}

/** Non-throwing OAuth token read — returns null rather than erroring, for
 *  callers (model listing, connection checks) that should degrade gracefully
 *  rather than fail hard. */
export function readOAuthTokenOrNull(): string | null {
  try {
    return readCredentialsFile().claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Refresh the OAuth token by spawning the Claude CLI in non-interactive mode.
 * The CLI handles the full OAuth refresh flow (including Cloudflare-protected
 * endpoints) and writes fresh credentials back to ~/.claude/.credentials.json.
 * We then re-read the file to get the new access token.
 */
async function tryRefreshOAuthToken(): Promise<string | null> {
  const cli = resolveClaudeCliPath();
  try {
    const proc = Bun.spawn([cli, "-p", "hi"], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    });

    // Wait up to 30 s; kill if it hangs
    const exited = await Promise.race([
      proc.exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 30_000)),
    ]);

    if (exited === "timeout") {
      proc.kill();
      console.warn("[ClaudeSubscription] claude CLI timed out during token refresh.");
      return null;
    }

    // Re-read the credentials file — the CLI will have written a fresh token
    const creds = readCredentialsFile();
    const newToken = creds.claudeAiOauth?.accessToken;
    if (newToken) {
      console.log("[ClaudeSubscription] OAuth token refreshed via claude CLI.");
      return newToken;
    }
    return null;
  } catch {
    console.warn("[ClaudeSubscription] claude CLI not found; cannot refresh token automatically.");
    return null;
  }
}

function loadOAuthToken(): string {
  let creds: CredentialsFile;
  try {
    creds = readCredentialsFile();
  } catch {
    throw new Error(
      "Claude Code not found. Install it from claude.com/code, then run `claude` once in a terminal to log in.",
    );
  }
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error(
      "Not logged into Claude Code. Run `claude` in a terminal to log in.",
    );
  }
  return token;
}

/**
 * Provider adapter that uses Claude Code's stored OAuth credentials to call
 * the Anthropic API directly — no separate API key required. Available to
 * all users (previously gated behind a locally-installed `claude` CLI; the
 * Agent SDK dependency now covers that for non-Haiku models — see below).
 *
 * Only reliable for Haiku (see isHaikuModel) — Sonnet/Opus 429 on this direct-
 * HTTP path regardless of headers sent. Non-Haiku models are NOT served via
 * this adapter's createModel()/testConnection(); agent-loop.ts and
 * testConnection() below route those through the Agent SDK instead
 * (claude-subscription-cli-runner.ts).
 *
 * Tokens are refreshed automatically on 401 responses, so no manual `claude`
 * invocation is needed after the token expires.
 */
export class ClaudeSubscriptionAdapter implements ProviderAdapter {
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /**
   * Shared by createModel() and getFilesApi() — both need the same
   * OAuth-header-impersonating Anthropic provider instance, just calling a
   * different member on it (model factory vs. `.files()`).
   */
  private buildProvider(): ReturnType<typeof createAnthropic> {
    const token = loadOAuthToken();
    // authToken sets Authorization: Bearer <token>.
    // Headers mirror what Claude Code sends so the API applies the correct OAuth
    // rate limit tier. Without oauth-2025-04-20 the API returns generic 429s.
    // Custom fetch appends ?beta=true to the path, which Claude Code also does.
    // Cap max_tokens at 32000 — the Max subscription API quota is measured in
    // output tokens per minute, and 128K max_tokens per request exhausts it instantly.
    const MAX_OUTPUT_TOKENS = 8192;

    const interceptFetch = async (
      url: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : (url as Request).url;
      const patched = u.includes("?") ? u : `${u}?beta=true`;

      let patchedInit = init;
      if (init?.body && typeof init.body === "string") {
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          if (typeof body.max_tokens === "number" && body.max_tokens > MAX_OUTPUT_TOKENS) {
            body.max_tokens = MAX_OUTPUT_TOKENS;
            patchedInit = { ...init, body: JSON.stringify(body) };
          }
        } catch { /* leave body as-is on parse error */ }
      }

      let response = await globalThis.fetch(patched, patchedInit);

      // On 401: the stored token is likely expired. Try to refresh and retry once.
      if (response.status === 401) {
        const newToken = await tryRefreshOAuthToken();
        if (newToken) {
          const headers = new Headers(patchedInit?.headers as HeadersInit | undefined);
          headers.set("authorization", `Bearer ${newToken}`);
          response = await globalThis.fetch(patched, { ...patchedInit, headers });
        }
      }

      return response;
    };

    return createAnthropic({
      authToken: token,
      headers: {
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,prompt-caching-scope-2026-01-05",
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
        "user-agent": "claude-cli/2.1.207 (external, cli)",
      },
      fetch: interceptFetch as unknown as typeof fetch,
    });
  }

  createModel(modelId: string, _thinkingBudgetTokens?: number): LanguageModel {
    return this.buildProvider()(modelId);
  }

  /**
   * Confirmed live (2026-07-15, §6.7 prototype): Anthropic's separate Files
   * REST endpoint accepts this same OAuth bearer token, not just
   * `/v1/messages` — upload-once/reference-later works over the Claude
   * Subscription path exactly as it does for a real Anthropic API key.
   */
  getFilesApi() {
    return this.buildProvider().files();
  }

  /**
   * Live model list from Anthropic's API using the stored OAuth token — so
   * newly released models/aliases show up without an AgentDesk code change.
   * Falls back to the static CLAUDE_MODELS list only when the token is
   * missing or the request fails (offline, API down, etc.).
   */
  async listModels(): Promise<string[]> {
    const token = readOAuthTokenOrNull();
    if (!token) return CLAUDE_MODELS;
    try {
      const response = await fetch("https://api.anthropic.com/v1/models?beta=true", {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
          "x-app": "cli",
          "user-agent": "claude-cli/2.1.207 (external, cli)",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return CLAUDE_MODELS;
      const data = await response.json() as { data?: Array<{ id: string }> };
      const models = (data.data ?? []).map((m) => m.id).sort();
      return models.length > 0 ? models : CLAUDE_MODELS;
    } catch {
      return CLAUDE_MODELS;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    const modelId = this.config.defaultModel ?? "claude-haiku-4-5-20251001";
    // Non-Haiku models never reach here via createModel() (see class doc
    // comment) — this adapter's direct-HTTP path 429s for them, so route the
    // connection check through the same Agent SDK path agent-loop.ts uses.
    if (!isHaikuModel(modelId)) {
      const { testClaudeSubscriptionSdkConnection } = await import("./claude-subscription-cli-runner");
      return testClaudeSubscriptionSdkConnection(modelId);
    }
    try {
      await generateText({
        model: this.createModel(modelId),
        prompt: "Hi",
        maxOutputTokens: 5,
        abortSignal: AbortSignal.timeout(20_000),
      });
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }
}
