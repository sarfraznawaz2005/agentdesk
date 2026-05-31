import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

const CLAUDE_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-20250514",
  "claude-sonnet-4-6",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
];

function loadOAuthToken(): string {
  let raw: string;
  try {
    raw = readFileSync(CREDENTIALS_PATH, "utf-8");
  } catch {
    throw new Error(
      "Claude credentials not found. Please authenticate by running `claude` in a terminal.",
    );
  }
  const data = JSON.parse(raw) as {
    claudeAiOauth?: { accessToken?: string; expiresAt?: number };
  };
  const token = data.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error(
      "No Claude OAuth token found. Please authenticate by running `claude` in a terminal.",
    );
  }
  if (data.claudeAiOauth?.expiresAt && data.claudeAiOauth.expiresAt < Date.now()) {
    console.warn(
      "[ClaudeSubscription] OAuth token is expired. Run `claude` to refresh credentials.",
    );
  }
  return token;
}

/**
 * Provider adapter that uses Claude Code's stored OAuth credentials to call
 * the Anthropic API directly — no separate API key required. Enabled only when
 * a `claude` feature-flag file exists next to the app executable.
 */
export class ClaudeSubscriptionAdapter implements ProviderAdapter {
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  createModel(modelId: string, _thinkingBudgetTokens?: number): LanguageModel {
    const token = loadOAuthToken();
    // authToken sets Authorization: Bearer <token>.
    // Headers mirror what Claude Code sends so the API applies the correct OAuth
    // rate limit tier. Without oauth-2025-04-20 the API returns generic 429s.
    // Custom fetch appends ?beta=true to the path, which Claude Code also does.
    // Cap max_tokens at 32000 — the Max subscription API quota is measured in
    // output tokens per minute, and 128K max_tokens per request exhausts it instantly.
    const MAX_OUTPUT_TOKENS = 8192;
    const interceptFetch = (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.href : (url as Request).url;
      const patched = u.includes("?") ? u : `${u}?beta=true`;
      if (init?.body && typeof init.body === "string") {
        try {
          const body = JSON.parse(init.body) as Record<string, unknown>;
          if (typeof body.max_tokens === "number" && body.max_tokens > MAX_OUTPUT_TOKENS) {
            body.max_tokens = MAX_OUTPUT_TOKENS;
            return globalThis.fetch(patched, { ...init, body: JSON.stringify(body) });
          }
        } catch { /* leave body as-is on parse error */ }
      }
      return globalThis.fetch(patched, init);
    };
    return createAnthropic({
      authToken: token,
      headers: {
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,prompt-caching-scope-2026-01-05",
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
        "user-agent": "claude-cli/2.1.158 (external, cli)",
      },
      fetch: interceptFetch as unknown as typeof fetch,
    })(modelId);
  }

  async listModels(): Promise<string[]> {
    try {
      const token = loadOAuthToken();
      const response = await fetch("https://api.anthropic.com/v1/models?beta=true", {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
          "x-app": "cli",
          "user-agent": "claude-cli/2.1.158 (external, cli)",
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
    try {
      const modelId = this.config.defaultModel ?? "claude-haiku-4-5-20251001";
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
