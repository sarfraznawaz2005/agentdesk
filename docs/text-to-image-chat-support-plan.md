# Plan: Text-to-image generation in chat (main chat + Dashboard widget)

## Goal

When a user asks an agent (in the main project chat, or in a Dashboard chat
widget) to create an image, the agent should be able to call a real
text-to-image model, and the resulting image should render inline in the
chat — not just come back as a text description or raw JSON/base64 dump.

This plan is grounded in two things already verified empirically earlier in
this session, not guesswork:
- `scripts/list-provider-models.ts` — discovers which configured
  provider/model combinations are plausibly image-capable (this is the same
  classification engine [`model-type-badges-plan.md`](./model-type-badges-plan.md)
  formalizes into a cached DB table — this plan **depends on that work** to
  know which models to offer, rather than hardcoding).
- `scripts/test-image-generation.ts` — actually called each candidate
  model's real endpoint. Result: **only 2 of 14 candidates produced a real
  image** with this account's current credentials/balances
  (`nvidia/black-forest-labs/flux.1-dev`, and Mistral's FLUX tool via their
  Agents/Conversations API). The other providers were correctly wired but
  blocked by $0 account balance (zenmux, z.ai) or missing entitlement/host
  issues (nvidia SD3.5/qwen-image). **This means the implementation must
  treat "provider looks image-capable" and "provider will actually generate
  an image right now" as two different questions** — the tool has to handle
  billing/entitlement failures gracefully, they are not edge cases, they are
  the common case.

---

## 1. Current state (verified against the codebase)

### Tool system
- Tools use the AI SDK `tool()` helper with a Zod `inputSchema`. Reference:
  `src/bun/agents/tools/screenshot.ts:200-245` (`take_screenshot`) —
  `execute()` returns `JSON.stringify({ success, url, image: { type:
  "image", mimeType, base64 } })`; a `toModelOutput` transform
  (`imageToolModelOutput`, screenshot.ts:244) strips the base64 out of what
  actually gets sent back to the model as tool-call context (to avoid
  burning tokens / breaking non-vision backends), and instead re-delivers
  the real image bytes as a synthetic follow-up user message (see
  `media-followup.ts`). **The new `generate_image` tool should follow this
  exact pattern** — same output shape, same `toModelOutput` strategy — so it
  slots into existing rendering code with minimal new special-casing.
- Central registry: `src/bun/agents/tools/index.ts`. `toolRegistry` is
  assembled by spreading each tool module's exports
  (`...screenshotTools`, etc.) — a new `src/bun/agents/tools/image-gen.ts`
  exporting `imageGenTools: Record<string, ToolRegistryEntry>` plugs in the
  same way.
- Per-agent gating: `agent_tools` table + `getToolsForAgent(agentName)`
  (`index.ts:141-215`) — if an agent has explicit `agent_tools` rows, only
  enabled ones are exposed; if it has none, it gets everything (existing
  backward-compat default). `generate_image` needs no special-case here —
  just register it and let normal agent tool-permission config apply.

### Message persistence and streaming
- DB: `message_parts` table (`schema.ts:700-713`). In the live code path
  (`src/bun/agents/agent-loop.ts`, `onStepFinish`, lines ~1553-1703), a
  single `tool_call`-typed row is inserted with `toolState: "running"`, then
  updated in place with `toolOutput`/`toolState: "success"|"error"` once the
  result lands — there is no separate `tool_result` row in practice.
- **A hard blocker to fix**: `agent-loop.ts:1678-1683` truncates tool output
  to `10_000` chars by default, with a `500_000`-char allowance carved out
  only for `toolName === "read_image" || toolName === "take_screenshot" ||
  toolName.includes("screenshot")`. **`generate_image` will not match this
  and its base64 payload will be silently truncated/corrupted** unless this
  check is extended. Fix: broaden the condition (e.g. a shared
  `IMAGE_PAYLOAD_TOOL_NAMES` set imported by both this file and the
  frontend, see below) to also match `generate_image`.
- Bridging to the frontend: `src/bun/engine-manager.ts`'s
  `onPartCreated`/`onPartUpdated` callbacks broadcast `partCreated`/
  `partUpdated` over the existing Electrobun webview RPC push channel
  (`broadcastToProject` → `target.webview.rpc.send[...]`). No changes needed
  here — this plumbing is generic over tool name/output already.

### Main chat rendering
- `src/mainview/components/chat/message-parts.tsx` routes any `tool_call`
  part to `<ToolCallCard part={toolPart} />` (`PartRenderer`,
  lines 524-619). No changes needed here.
- `src/mainview/components/chat/tool-call-card.tsx`:
  - `InlineImage` (lines 31-47) is a **generic, reusable** presentational
    component — `src` (a data-URL string) + optional `caption`, with a
    click-to-enlarge lightbox. No changes needed to this component itself.
  - **The trigger condition needs extending.** `ToolOutputDisplay` (lines
    341-426) only renders `InlineImage` when
    `toolName.includes("take_screenshot") || toolName.includes("screenshot")
    || toolName === "read_image"` (line 381). Add `generate_image` here.
  - **`IMAGE_TOOL_NAMES`** (lines 180-183), a second, separate name-list
    controlling auto-expand of the tool card — also needs `generate_image`
    added, or the generated image will render collapsed by default.
  - **Output shape accepted**: two JSON shapes are already parsed — the
    MCP content envelope (`{content:[{type:"image",data,mimeType}]}`) or the
    "built-in" shape (`{success, image:{type,mimeType,base64}, url?, path?}`).
    The new tool should emit the **built-in shape** (matches
    `screenshot.ts`'s own output exactly) — zero new parsing code needed on
    the frontend.

### Provider/model capability
- `src/bun/providers/types.ts` — `ProviderAdapter` interface only has
  `createModel()`, `listModels()`, `testConnection()`. Adding an **optional**
  `createImageModel?(modelId: string): ImageModel` (or a raw-fetch
  equivalent, see §2) is additive and backward-compatible — confirmed only
  3 call sites ever invoke adapter methods, none do exhaustive interface
  checks (`engine.ts:345`, `agent-loop.ts:902`, `providers.ts` x2, plus
  `preview.ts:186` for `createModel`).
- Installed `ai` version is **7.0.26**. The image-generation export is
  **`generateImage`** — `experimental_generateImage` does not exist in this
  version, don't use stale docs/examples that reference it.
- `@ai-sdk/openai-compatible@3.0.9` (what AgentDesk's `custom`/`openai`
  adapter — `src/bun/providers/openai.ts` — is built on) **does** expose
  `.imageModel(modelId)`, hitting `POST {baseURL}/images/generations`
  (standard OpenAI DALL-E-style contract). This is usable **only** for
  providers whose actual image endpoint matches that exact path/shape.

---

## 2. Per-provider image-generation strategy (grounded in live test results)

Not every provider can go through the clean AI-SDK `ImageModel` +
`generateImage()` path — this was proven empirically, not assumed. Two
strategies are needed:

### Strategy A — Standard AI SDK `ImageModel` (when the endpoint matches)
Providers whose adapter already wraps `@ai-sdk/openai-compatible` **and**
whose image endpoint is a real `POST {baseURL}/images/generations` (OpenAI
shape). Confirmed candidate: **zenmux** (`openai/gpt-image-1.5`,
`openai/gpt-image-2` — docs-confirmed shape; blocked only by account balance
in testing, not by endpoint mismatch). Implementation:
```ts
// src/bun/providers/openai.ts — OpenAIAdapter (covers "openai" and "custom")
createImageModel(modelId: string): ImageModel {
  return this.provider.imageModel(modelId); // reuses the existing createOpenAICompatible() instance
}
```
Then the tool calls the standard `generateImage({ model, prompt })` from
`"ai"`.

### Strategy B — Raw fetch, provider-specific (everything else)
Providers whose real image endpoint uses a different host, path, or request
shape than their chat endpoint — this is the norm, not the exception, per
our research:
- **nvidia**: image NIMs live at `ai.api.nvidia.com/v1/genai/{model}` — a
  **different host** than the configured chat `baseUrl`
  (`integrate.api.nvidia.com`) — and a different request shape
  (`prompt/height/width/steps` → base64, not OpenAI's `images/generations`).
  Confirmed working live for `black-forest-labs/flux.1-dev` in
  `test-image-generation.ts`.
- **z.ai**: `POST https://api.z.ai/api/paas/v4/images/generations` — same
  host as chat, OpenAI-shaped body, but the `zai.ts` adapter uses the
  `zhipu-ai-provider` package (not `@ai-sdk/openai-compatible`), which is
  not confirmed to expose an `.imageModel()` helper — treat as raw-fetch
  unless verified otherwise.
- **Mistral**: no single-call image endpoint exists at all. Generation only
  happens via their beta Agents/Conversations flow (create an agent with the
  `image_generation` tool → start a conversation → poll for a `tool_file`
  chunk → download via `/files/{id}/content`) — a **multi-step orchestration**,
  not something `ImageModel.doGenerate()` can model as a single call.

**Implementation**: port the already-working logic from
`scripts/test-image-generation.ts` (`tryNvidiaGenai`, `tryOpenAIImagesEndpoint`
for z.ai, `tryMistralImageTool`) directly into the corresponding provider
adapter files as the `createImageModel`-equivalent raw path. That script is
the tested reference implementation — this is a port, not a new design.

```ts
// src/bun/providers/types.ts
export interface ProviderAdapter {
  createModel(modelId: string, thinkingBudgetTokens?: number): LanguageModel;
  listModels(): Promise<string[]>;
  testConnection(): Promise<{ success: boolean; error?: string }>;
  // New, optional — providers without image support simply omit it.
  generateImage?(modelId: string, prompt: string): Promise<{ base64: string; mimeType: string }>;
}
```
Using a dedicated `generateImage()` method (rather than forcing everything
through AI SDK's `ImageModel` interface) is deliberate — it lets Strategy A
providers implement it as a one-line wrapper around `generateImage()` from
`"ai"`, while Strategy B providers implement it as the raw multi-step fetch
logic already proven in the test script, without fighting the `ImageModel`
abstraction for providers that don't actually fit it (Mistral in
particular — its multi-step flow has no analogue in `ImageModel.doGenerate()`).

---

## 3. The `generate_image` tool

New file `src/bun/agents/tools/image-gen.ts`:

```ts
export const imageGenTools: Record<string, ToolRegistryEntry> = {
  generate_image: {
    category: "media",
    tool: tool({
      description: "Generate an image from a text prompt and show it in the chat.",
      inputSchema: z.object({
        prompt: z.string().describe("What to generate, e.g. 'a cute cat, simple illustration'"),
      }),
      execute: async ({ prompt }) => {
        // 1. Resolve which configured provider+model to use — query
        //    model_capabilities_cache (from model-type-badges-plan.md)
        //    for rows with model_type = 'image', preferring the user's
        //    default provider if it qualifies, else the first match.
        // 2. Call adapter.generateImage(modelId, prompt).
        // 3. On success: JSON.stringify({ success: true, image: { type: "image", mimeType, base64 }, prompt }).
        // 4. On failure (no balance, not entitled, network error): JSON.stringify({ success: false, error: <human-readable> })
        //    — surfaced as a normal failed tool result, not a crash. Given the live
        //    test results, this WILL happen routinely (insufficient balance etc.)
        //    and must read as an actionable message, not a stack trace.
      },
      toModelOutput: ({ output }) => imageToolModelOutput(output), // reuse screenshot.ts's existing helper
    }),
  },
};
```

Register in `src/bun/agents/tools/index.ts` by spreading `...imageGenTools`
into `toolRegistry`, same as every other tool module.

**Step resolving "which model to use" is why this plan depends on
`model-type-badges-plan.md`**: without a cached, classified list of which
provider/model combinations are actually image-capable, the tool would have
to either hardcode model ids (fragile, exactly the problem this whole
investigation started from) or re-run live capability detection on every
call (slow, wasteful). The `model_capabilities_cache` table gives it a fast,
already-invalidated-on-provider-change source of truth.

**Backend fix required**: extend the truncation allowlist at
`agent-loop.ts:1678-1683` to include `generate_image` (see §1).

---

## 4. Frontend fix required (main chat)

In `src/mainview/components/chat/tool-call-card.tsx`:
- Add `generate_image` to the image-render trigger condition (~line 381).
- Add `"generate_image"` to `IMAGE_TOOL_NAMES` (~lines 180-183) for
  auto-expand.

No other frontend changes needed for the main chat — `InlineImage` and the
output-shape parsing are already generic enough.

---

## 5. Dashboard chat widget — a materially separate effort

Confirmed by direct investigation: the Dashboard's `PmChatWidget` /
`CustomAgentChatWidget` (`src/mainview/components/dashboard/*.tsx`) are
**not** built on `message-parts.tsx`/`tool-call-card.tsx` at all. They have
their own flat `{ id, role, content: string }` message model, their own
backend loop (`sendDashboardMessage()` in `src/bun/rpc/dashboard.ts`,
in-memory-only `sessionHistory`, not persisted to `message_parts`), their
own tool set (`createDashboardTools()`, currently no image tools), and their
own broadcast channels (`dashboardPMChunk`/`dashboardPMToolCall`/
`dashboardPMComplete`/`dashboardPMError`) — and critically, tool call events
today only ever broadcast `{ sessionId, toolName, args }`, **never the tool
result** (explicit code comment: `"no tool-result broadcast today, matching
the streamText path"`).

To support inline generated images here without a full rebuild:

1. **Register `generate_image`** into `createDashboardTools()`
   (`dashboard.ts:119-546`) — same tool implementation from §3, reused
   as-is.
2. **New broadcast event**, e.g. `dashboardPMToolResult`, fired from the
   `onToolCallEnd` hook (currently a no-op at `dashboard.ts:~676`) —
   carrying `{ sessionId, toolName, output }` when the tool is
   `generate_image` and succeeded (avoid broadcasting every tool's raw
   output by default, to not blow up widget state for unrelated tools).
3. **Widget-side**: add a small `images: Record<string, GeneratedImage>`
   piece of state to `pm-chat-widget.tsx`/`custom-agent-chat-widget.tsx`,
   populated by a new listener for `dashboardPMToolResult`. Extend the
   existing tool-call row UI (`pm-chat-widget.tsx:727-741`, which today just
   shows a spinner + tool name) to render the image once available — **reuse
   `InlineImage` from `tool-call-card.tsx` directly** (it's a small,
   dependency-free presentational component: `src` + `caption` props only),
   rather than re-implementing image rendering a second time.
4. **Known limitation, explicitly a trade-off not an oversight**: Dashboard
   chat is in-memory and non-persisted by design — a generated image will
   not survive a reload/session-expiry, consistent with how the rest of that
   widget already behaves. If persistence is wanted later, that's a
   separate, larger change (would mean giving Dashboard chat a real
   `message_parts`-backed history, which today it deliberately does not
   have) — flagging this rather than silently scoping it in.

---

## 6. Error handling — not optional, given the live test data

From this session's actual testing, out of 14 image-capable candidates only
2 worked; the rest failed with clear, distinct causes: `402`/`429`
insufficient-balance, `404` not-entitled, and one plain timeout. The tool's
`execute()` must translate these into a short, human-readable error string
returned as a **normal unsuccessful tool result** (`{success:false,
error:"..."}`), not an uncaught exception — so the agent can relay something
like "I tried to generate that with nvidia/flux.1-dev but the provider
returned an error: <reason>" instead of the conversation breaking. This
mirrors how every other tool in the codebase already reports failure.

---

## 7. Implementation phases

1. **Phase 0 (prerequisite)**: `model-type-badges-plan.md`'s
   `model_capabilities_cache` table + classification service — needed so
   the tool can discover eligible models without hardcoding.
2. **Phase 1 (main chat, backend)**: `ProviderAdapter.generateImage()` on
   the adapters that support it (openai/custom via Strategy A; nvidia, zai
   via Strategy B, ported from `test-image-generation.ts`); the
   `generate_image` tool; the `agent-loop.ts` truncation-allowlist fix.
3. **Phase 2 (main chat, frontend)**: the two `tool-call-card.tsx`
   name-list additions. This is the smallest phase — verify end-to-end in
   the main chat before touching the Dashboard widget.
4. **Phase 3 (Mistral, optional/separate)**: the multi-step Agents/
   Conversations flow — isolate as its own adapter method since it doesn't
   fit the single-call `generateImage()` shape other providers use; lower
   priority since it's a materially different code path for one provider.
5. **Phase 4 (Dashboard widget)**: the new broadcast event, tool
   registration in `createDashboardTools()`, and the widget-side rendering
   reuse of `InlineImage`.

## 8. Verification plan

- Reuse `scripts/test-image-generation.ts` as the backend contract test —
  once ported into real adapters, the same "generate a cat" calls should
  keep succeeding/failing identically to the standalone script's results.
- Manual chat test: ask the PM/an agent in the main chat to "generate an
  image of a cat" and confirm it calls `generate_image` (not just describes
  an image in text), and that the image renders inline, expanded by
  default, with click-to-enlarge.
- Manual Dashboard-widget test: same prompt in the Dashboard chat widget,
  confirm the image renders there too, and confirm it does *not* survive a
  widget/session reset (expected, per §5's documented limitation).
- Confirm a deliberately-failing case (e.g. temporarily point at a
  zero-balance provider) surfaces a readable error in chat rather than a
  broken/blank tool card.
