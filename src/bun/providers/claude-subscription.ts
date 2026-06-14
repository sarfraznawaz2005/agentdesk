import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig } from "./types";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

// Path candidates for the claude CLI — same dir as the app exe first, then PATH
const CLAUDE_CLI_CANDIDATES = [
  join(dirname(process.execPath), "claude"),
  join(dirname(process.execPath), "claude.exe"),
  "claude",
];

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

/**
 * Refresh the OAuth token by spawning the Claude CLI in non-interactive mode.
 * The CLI handles the full OAuth refresh flow (including Cloudflare-protected
 * endpoints) and writes fresh credentials back to ~/.claude/.credentials.json.
 * We then re-read the file to get the new access token.
 */
async function tryRefreshOAuthToken(): Promise<string | null> {
  for (const cli of CLAUDE_CLI_CANDIDATES) {
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
      // This candidate wasn't found — try the next
      continue;
    }
  }

  console.warn("[ClaudeSubscription] claude CLI not found; cannot refresh token automatically.");
  return null;
}

function loadOAuthToken(): string {
  let creds: CredentialsFile;
  try {
    creds = readCredentialsFile();
  } catch {
    throw new Error(
      "Claude credentials not found. Please authenticate by running `claude` in a terminal.",
    );
  }
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error(
      "No Claude OAuth token found. Please authenticate by running `claude` in a terminal.",
    );
  }
  return token;
}

/**
 * Provider adapter that uses Claude Code's stored OAuth credentials to call
 * the Anthropic API directly — no separate API key required. Enabled only when
 * a `claude` feature-flag file exists next to the app executable.
 *
 * Tokens are refreshed automatically on 401 responses, so no manual `claude`
 * invocation is needed after the token expires.
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
