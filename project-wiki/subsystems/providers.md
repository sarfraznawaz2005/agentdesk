---
title: AI Providers
type: subsystem
status: verified
verified_at: 2026-06-14
sources:
  - src/bun/providers/index.ts
  - src/bun/providers/types.ts
  - src/bun/providers/models.ts
  - src/bun/providers/headers.ts
  - src/bun/providers/anthropic.ts
  - src/bun/providers/openai.ts
  - src/bun/providers/openrouter.ts
  - src/bun/providers/ollama.ts
  - src/bun/providers/google.ts
  - src/bun/providers/claude-subscription.ts
  - src/bun/agents/engine-types.ts
tags: [ai, providers]
---

# AI Providers

**One-paragraph what-and-why.** `src/bun/providers/` is the provider-agnostic seam
between AgentDesk and every LLM vendor. Every adapter implements the same tiny
`ProviderAdapter` interface (`src/bun/providers/types.ts:12`) — `createModel`,
`listModels`, `testConnection` — and `createProviderAdapter()`
(`src/bun/providers/index.ts:31`) is the single factory that turns a stored
provider config into a Vercel AI SDK `LanguageModel`. The single most important
thing to understand: **the adapters only build the model handle. They do NOT run
inference, apply prompt caching, or set thinking budgets** — that translation
happens one layer up in the agents layer (`src/bun/agents/engine-types.ts`), so
the providers layer stays thin and uniform.

## Key idea: one interface, many backends

The interface is deliberately minimal (`src/bun/providers/types.ts:12-24`):

- `createModel(modelId, thinkingBudgetTokens?)` → returns an AI SDK `LanguageModel`.
- `listModels()` → live model discovery (with a hardcoded fallback list).
- `testConnection()` → a 5-token "Hi" probe used by the settings UI.

Because callers only ever see a `LanguageModel`, the rest of the codebase
(`[[agent-engine]]`, `[[summarizer]]`, scheduler, freelance pipelines) is fully
provider-agnostic — it calls `streamText`/`generateText` from the `ai` package
and never branches on vendor, except for the few SDK-shaped knobs noted below.

## How it works

1. **Config in, adapter out.** A `ProviderConfig` (id/name/providerType/apiKey/
   baseUrl/defaultModel — `src/bun/providers/types.ts:3-10`) is built from the
   `ai_providers` DB row and passed to `createProviderAdapter()`. The factory is
   a plain `switch` on `providerType` (`src/bun/providers/index.ts:32-61`).
   Twelve supported types map to ten adapter classes:
   `openai` and `custom` both → `OpenAIAdapter`; `anthropic` and
   `claude-subscription` are distinct classes. Unknown types throw with the
   supported-type list.

2. **The consumer wiring.** `[[agent-engine]]` calls `createProviderAdapter(...)`
   then `adapter.createModel(modelId, thinkingTokens)` to get the model handle
   (`src/bun/agents/engine.ts:286-299`). The returned model is what gets handed
   to the AI SDK.

3. **Two adapter "shapes".** Native-SDK adapters wrap a vendor SDK
   (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`). OpenAI-compatible
   adapters wrap `@ai-sdk/openai-compatible` against a Chat Completions base URL
   — this covers OpenRouter (`src/bun/providers/openrouter.ts:31`), Ollama
   (`src/bun/providers/ollama.ts:29`), and any `custom` provider. DeepSeek, Groq,
   xAI, and Z.AI follow the same OpenAI-compatible pattern in their own files.

4. **The OpenAI Responses-API trap.** `OpenAIAdapter` deliberately avoids the AI
   SDK v6 default. For standard OpenAI it calls `provider.chat(modelId)` to force
   the Chat Completions API (`src/bun/providers/openai.ts:91-94`); for a custom
   base URL it switches to `@ai-sdk/openai-compatible` entirely
   (`src/bun/providers/openai.ts:57-89`). The comment explains why: v6's default
   Responses API breaks tool calling on third-party endpoints (Z.AI, LM Studio).

5. **Model discovery with graceful fallback.** Each `listModels()` hits the
   vendor's models endpoint and falls back to a hardcoded array on any error or
   empty result (e.g. `src/bun/providers/anthropic.ts:38-54`,
   `src/bun/providers/ollama.ts:46-62`). OpenAI additionally filters out
   non-chat models (embed/whisper/tts/dall-e/etc.) before sorting
   (`src/bun/providers/openai.ts:107-120`). OpenRouter skips the network call and
   just returns its curated list (`src/bun/providers/openrouter.ts:43-45`).

6. **Defaults and context limits** live in `src/bun/providers/models.ts`:
   - `getDefaultModel(providerType)` looks up `PROVIDER_DEFAULT_MODELS`
     (`models.ts:8-19`), falling back to `gpt-4o` for anything unknown
     (`models.ts:71-73`).
   - `getContextLimit(modelId?, projectId?)` ignores the model entirely — the
     `_modelId` arg is unused. It reads a **user-configured** window from the
     `settings` table (`project:<id>:contextWindowLimit`, else global
     `contextWindowLimit`), defaulting to **1,000,000** tokens
     (`models.ts:29-60`). Results are cached per project; `clearContextLimitCache()`
     must be called when the setting changes (`models.ts:62-65`). This is the
     number `[[agent-engine]]` divides `lastPromptTokens` by to decide compaction.

## Where caching and thinking actually happen

This is the most common misread of this subsystem. The adapters take a
`thinkingBudgetTokens` param but **most ignore it** (Anthropic/OpenRouter/Ollama/
Google sign it `_thinkingBudgetTokens`). The real wiring is in
`src/bun/agents/engine-types.ts`:

- **Thinking budgets** → `buildPMThinkingOptions()` (`engine-types.ts:34-64`)
  maps `low/medium/high` to `2000/8000/16000` tokens (`engine-types.ts:28-32`)
  and emits SDK-shaped `providerOptions`. Anthropic + claude-subscription get
  `providerOptions.anthropic.thinking` (`engine-types.ts:39-46`); OpenRouter
  forwards the same anthropic shape because it proxies Claude
  (`engine-types.ts:48-56`); `custom` providers instead inject
  `enable_thinking`/`thinking_budget` into the HTTP body — and THIS is the one
  case the adapter handles, via a fetch interceptor in `OpenAIAdapter.createModel`
  (`src/bun/providers/openai.ts:58-81`).
- **Prompt caching** → `applyAnthropicCaching()` (`engine-types.ts:100-120`)
  only rewrites the system prompt into a cache-controlled system message for
  `anthropic` and `openrouter`; all other providers pass through unchanged.
  This yields ~90% cheaper cache hits on Anthropic.
- **Reasoning extraction** → `extractPMReasoning()` (`engine-types.ts:66-87`)
  normalizes reasoning text across `step.reasoningText`, anthropic `thinking`
  blocks, and openai `reasoningContent` in provider metadata.

## Two non-obvious adapters

- **Spoofed identity headers.** `PROVIDER_HEADERS` (`src/bun/providers/headers.ts:7-11`)
  injects `User-Agent: opencode/...`, `HTTP-Referer`, and `X-Title: opencode`
  into **every** provider request. This is required for some gateways
  (notably to satisfy OpenRouter attribution / opencode-keyed routing).
- **`claude-subscription`** (`src/bun/providers/claude-subscription.ts`) is the
  outlier. It uses no API key — it reads Claude Code's OAuth token from
  `~/.claude/.credentials.json` (`claude-subscription.ts:9,94-110`), sends
  Claude-CLI-mimicking `anthropic-beta` headers and a `?beta=true` query
  (`claude-subscription.ts:170-179`), auto-refreshes the token on a 401 by
  spawning the `claude` CLI (`claude-subscription.ts:55-92,157-165`), and caps
  `max_tokens` at 8192 to protect the Max subscription's output-tokens-per-minute
  quota (`claude-subscription.ts:135,146-152`).

## Connection fallback

`createProviderAdapterWithFallback(primary, fallback?)`
(`src/bun/providers/index.ts:71-95`) builds the primary adapter, runs
`testConnection()`, and on failure (or thrown error) swaps to the fallback
config. With no fallback it returns the primary anyway and lets the caller
surface the error.

## Key files

| File | Role |
|---|---|
| `src/bun/providers/index.ts` | `createProviderAdapter()` factory + `createProviderAdapterWithFallback()`; re-exports `getContextLimit`/`getDefaultModel` |
| `src/bun/providers/types.ts` | `ProviderConfig` + `ProviderAdapter` interface (the seam) |
| `src/bun/providers/models.ts` | Default-model map, `getDefaultModel`, settings-driven `getContextLimit` (+ cache) |
| `src/bun/providers/headers.ts` | `PROVIDER_HEADERS` injected into every request |
| `src/bun/providers/anthropic.ts` | Native `@ai-sdk/anthropic` adapter |
| `src/bun/providers/openai.ts` | OpenAI **and** `custom` adapter; Chat-Completions forcing + thinking-budget fetch interceptor |
| `src/bun/providers/openrouter.ts` | OpenAI-compatible adapter, curated model list |
| `src/bun/providers/ollama.ts` | Local OpenAI-compatible adapter; `/api/tags` discovery + reachability probe |
| `src/bun/providers/google.ts` | Native `@ai-sdk/google` (Gemini) adapter |
| `src/bun/providers/{deepseek,groq,xai,zai,opencode}.ts` | OpenAI-compatible adapters for each vendor |
| `src/bun/providers/claude-subscription.ts` | OAuth-token (no API key) Claude adapter with CLI-based refresh |
| `src/bun/agents/engine-types.ts` | Where thinking budgets, prompt caching, and reasoning extraction actually apply (NOT the adapters) |

## Gotchas / Constraints

- **CLAUDE.md undercounts the providers.** The directory contains
  twelve `providerType`s and ten adapter classes (incl. `deepseek`, `groq`,
  `xai`, `zai`, `opencode`, `claude-subscription`), not just the four named in
  older docs.
- **`getContextLimit` is model-agnostic.** It does NOT look up a per-model
  context window; the `modelId` argument is unused. It returns whatever the user
  set in settings, default 1M. Don't assume it reflects the actual model's
  window.
- **Context-limit cache is not auto-invalidated.** Callers must invoke
  `clearContextLimitCache()` after changing the setting, or stale limits persist
  for the process lifetime (`models.ts:62-65`).
- **`createModel(thinkingBudget)` is mostly a no-op.** Only `OpenAIAdapter`'s
  `custom` path consumes it (via fetch interception). For Anthropic/OpenRouter
  the budget is applied as `providerOptions` by the *caller*, not the adapter —
  passing it to `createModel` alone does nothing.
- **`openai` vs `custom` share a class but diverge sharply.** `custom` uses
  `@ai-sdk/openai-compatible`; standard `openai` uses `provider.chat()`. Editing
  one path without the other is a common bug source.
- **`claude-subscription` is feature-flagged.** It depends on a local `claude`
  CLI + stored OAuth credentials; absent those, `loadOAuthToken()` throws a
  user-facing "authenticate by running `claude`" error
  (`claude-subscription.ts:98-109`).
- **Forced tool choice is NOT portable across providers.** The AI SDK's
  `toolChoice: 'required'` / `toolChoice: { type: 'tool', toolName }` is honored
  by some backends (Anthropic, OpenAI) but silently ignored or rejected by others
  (Ollama and many OpenAI-compatible / OpenRouter-proxied models). Because the
  providers layer is deliberately uniform, the engine MUST NOT depend on forced
  tool calling to guarantee a transition — any "force the PM to call `run_agent`"
  design must keep a non-forcing fallback (the post-hoc hallucination guard at
  `engine.ts:710`) for providers that don't support it. Treat `toolChoice` as a
  best-effort hint, never a hard guarantee.

## Related
- [[agent-engine]]
- [[summarizer]]
- [[context-management]]
- [[tech-stack]]

## Open questions
- The DeepSeek/Groq/xAI/Z.AI/OpenCode adapters were confirmed present and follow
  the OpenAI-compatible pattern, but their exact base URLs / curated model lists
  were not individually read for this page.
- Which exact `claude` feature-flag file enables `claude-subscription` at runtime
  (the gating check) lives outside `src/bun/providers/` and was not traced here.
