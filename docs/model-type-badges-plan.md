# Plan: Model-type badges on Settings → AI → Models

## Goal

On the existing Settings → AI → Models tab, show a small colored badge next to
each model's name indicating its type — language, embedding, image
generation, video generation, transcription (speech-to-text), speech
(text-to-speech), realtime, or reranking. Same type always renders with the
same color, app-wide. **No filtering, no hiding** — this is a decoration on
the existing list, not a new control.

Type must be resolved via API/catalog lookups (see
[`list-provider-models.ts`](./list-provider-models.ts) for the working
reference implementation of the same classification logic), not hardcoded
guesses. Detection must be **batched** (a small constant number of network
calls regardless of how many providers/models exist) and the result must be
**cached until the user adds, edits, or deletes an AI provider** — not
re-fetched on every Models-tab open.

---

## 1. Current state (verified against the codebase)

- **Component**: `src/mainview/pages/settings/models.tsx` → `ModelsSettings()`
  — a single-file component, no sub-tree. Reached via
  `src/mainview/pages/settings.tsx`'s `SubTabs` under the "AI" tab
  (`{ value: "models", label: "Models", content: <ModelsSettings /> }`).
- **Data fetch** (`models.tsx:39-67`, on mount):
  ```ts
  const [models, prefRows] = await Promise.all([
    rpc.getConnectedProviderModels(),
    rpc.getModelPreferences(),
  ]);
  ```
  `getConnectedProviderModels()` → `getConnectedProviderModelsHandler()` in
  `src/bun/rpc/providers.ts:256-290` — loops every row in `ai_providers`,
  calls `adapter.listModels()`, returns
  `Array<{ providerId, providerName, providerType, models: string[] }>`.
- **Mutations**: `setModelEnabled`, `setModelsEnabled`, `setModelFavorite`,
  `recordModelUsage` — each backed by `upsertModelPreference()` in
  `rpc/providers.ts:422-435`, and each broadcasts
  `broadcastToWebview("modelPreferencesChanged", ...)`, which the page
  listens for via a `window` event (`agentdesk:model-preferences-changed`,
  `models.tsx:71-86`) to re-fetch and stay in sync across windows.
- **`model_preferences` table** (`src/bun/db/schema.ts:1052-1076`, migration
  `src/bun/db/migrations/v52_model-preferences.ts`):
  `id, provider_id, model_id, is_enabled, is_favorite, last_used_at,
  created_at, updated_at`. Rows are **sparse by design** — no row means
  enabled/not-favorite/never-used. No `type` column exists, and the table
  has never been altered since v52.
- **Existing UI patterns to match**: a plain bordered `<div>` + `<input>`
  search box (`models.tsx:187-206`, not the shared `search-input.tsx` or
  Radix), `Switch` for enable toggles, an icon `<button>` with a `Star` icon
  for favorites, `Card`/`CardContent`/`Separator` for per-provider sections.
  No `Select` or filter-chip pattern is used on this page today.
- **RPC wiring path** (for adding new endpoints): handler function in
  `src/bun/rpc/providers.ts` → new key in the `handlers` object in
  `src/bun/rpc-groups/settings-providers.ts` → automatically merged by
  `src/bun/remote/rpc-handlers.ts` → registered in
  `src/bun/rpc-registration.ts`. No other wiring needed. Frontend caller
  added to `src/mainview/lib/rpc.ts` near the existing
  `getConnectedProviderModels`/`getModelPreferences` entries (~line 510-522).
- **Important pre-existing filter to know about**: two provider adapters
  already **strip non-chat models out** of `listModels()` before they ever
  reach this page —
  `src/bun/providers/openai.ts:142-152` excludes ids containing `embed`,
  `whisper`, `tts`, `dall-e`, `moderation`, `realtime`, `audio`, `search`;
  `src/bun/providers/groq.ts:42` excludes `whisper`, `tool-use`, `guard`.
  Every other adapter (google, zai, custom/openai-compatible, etc.) returns
  whatever the provider gives it, unfiltered. **This means today, OpenAI's
  own image/TTS/embedding models never even reach the Models page** — see
  Decision 1 below.

---

## 2. Type taxonomy and color mapping

Use the same 8-value taxonomy the Vercel AI Gateway's `/v1/models` already
returns natively (see §3, tier 1), so no local re-invention of categories is
needed:

| Type            | Badge label | Color (Tailwind)                              |
| ---------------- | ----------- | ----------------------------------------------- |
| `language`        | *(no badge)* | — treated as the default/majority case, unbadged to reduce visual noise |
| `embedding`        | `EMBED`     | `bg-violet-500/10 text-violet-600 dark:text-violet-400` |
| `image`            | `IMAGE`     | `bg-pink-500/10 text-pink-600 dark:text-pink-400` |
| `video`            | `VIDEO`     | `bg-orange-500/10 text-orange-600 dark:text-orange-400` |
| `transcription`    | `STT`       | `bg-cyan-500/10 text-cyan-600 dark:text-cyan-400` |
| `speech`           | `TTS`       | `bg-emerald-500/10 text-emerald-600 dark:text-emerald-400` |
| `realtime`         | `LIVE`      | `bg-amber-500/10 text-amber-600 dark:text-amber-400` |
| `reranking`        | `RERANK`    | `bg-indigo-500/10 text-indigo-600 dark:text-indigo-400` |
| `unknown`          | *(no badge)* | — classification failed/no data; fail silent rather than mislabel |

Colors are fixed constants in one shared map (`MODEL_TYPE_BADGE_STYLES`) so
"same color always = same type" holds everywhere the badge is ever reused
(e.g. later in a chat model picker), not just on this page.

---

## 3. Classification strategy (batched, layered, cheap)

This reuses exactly the sources validated live in this session (see the
conversation history / `list-provider-models.ts`):

1. **Tier 1 — Vercel AI Gateway catalog.** `GET
   https://ai-gateway.vercel.sh/v1/models` (no auth, verified live: 301
   models with a clean `type` field). Best match for the models this app's
   own `ai` v7 SDK ecosystem already knows about.
2. **Tier 2 — models.dev catalog.** `GET https://models.dev/api.json` (no
   auth, verified live: 166 provider keys incl. long-tail aggregators like
   zenmux/opencode). Use `modalities.output` — `"image"` → `image`,
   `"audio"` → `speech`, `"video"` → `video`, else `language`. This is the
   fallback for models Gateway doesn't carry.
3. **Tier 3 — native provider hints, where available.** Google's
   `supportedGenerationMethods` (`predict` → image), Mistral's `capabilities`
   object (confirms `vision`/`completion_chat`, doesn't add new type
   information beyond what tiers 1-2 already give for image/embedding).
   Low priority — only consulted if tiers 1-2 have no entry, since it needs
   a live authenticated call per provider rather than one shared static
   catalog fetch.
4. **Default**: if nothing matches, classify as `language` (matches today's
   reality: the two adapters that strip non-chat models already remove most
   of what would otherwise be misclassified) — or `unknown` if the id looks
   unusual (safe fallback, renders no badge).

Both network catalogs (tiers 1-2) are fetched **once**, in-memory, module-level,
regardless of provider/model count — not once per model, not once per
provider:

```ts
// src/bun/providers/model-classification.ts
let gatewayCatalogCache: { data: GatewayModel[]; fetchedAt: number } | null = null;
let modelsDevCatalogCache: { data: Record<string, ModelsDevProvider>; fetchedAt: number } | null = null;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 24h — these catalogs change rarely

async function getGatewayCatalog(): Promise<GatewayModel[]> { /* fetch-or-reuse, see list-provider-models.ts precedent */ }
async function getModelsDevCatalog(): Promise<Record<string, ModelsDevProvider>> { /* fetch-or-reuse */ }

export async function classifyModels(
  providerType: string,
  baseUrl: string | null,
  modelIds: string[],
): Promise<Record<string, { type: ModelType; source: "gateway" | "models-dev" | "native" | "default" }>> {
  const gateway = await getGatewayCatalog();       // one shared fetch (or cache hit)
  const modelsDev = await getModelsDevCatalog();   // one shared fetch (or cache hit)
  // ... classify each id against both in-memory datasets, no further network calls
}
```

This satisfies "fetch this once... single initial call" — for the entire
app process, not per provider, not per model.

---

## 4. Persistent caching (survives restarts, invalidated on provider CRUD)

A new table, separate from `model_preferences` (which is deliberately sparse
user-preference data, not classification metadata):

```ts
// src/bun/db/schema.ts — new table
export const modelCapabilitiesCache = sqliteTable("model_capabilities_cache", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  providerId: text("provider_id").notNull().references(() => aiProviders.id, { onDelete: "cascade" }),
  modelId: text("model_id").notNull(),
  modelType: text("model_type").notNull(), // ModelType enum value
  source: text("source").notNull(),        // "gateway" | "models-dev" | "native" | "default"
  computedAt: text("computed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({
  uniqProviderModel: uniqueIndex("idx_model_caps_provider_model").on(t.providerId, t.modelId),
}));
```

New migration file `src/bun/db/migrations/vNN_model-capabilities-cache.ts`
mirroring the v52 raw-SQL-mirrors-Drizzle convention already used for
`model_preferences`.

**Read path** (`getModelTypesHandler`, new function in `rpc/providers.ts`):
1. For each configured provider, check which of its live `listModels()`
   ids already have a row in `model_capabilities_cache`.
2. Only classify the **missing** ids (first run: all of them; subsequent
   runs: only newly-appeared model ids) via `classifyModels()` from §3.
3. Upsert newly-classified rows into the cache table.
4. Return the full `Record<providerId, Record<modelId, ModelType>>` map.

So on every normal Models-tab open **after the first**, this is a pure DB
read with zero network calls — the two catalog fetches only happen again
when a genuinely new model id shows up that isn't cached yet, or when the
in-memory 24h TTL (§3) has expired *and* a cache miss actually occurs.

**Invalidation — exactly on provider add/edit/delete**, per your
requirement:
- `saveProviderHandler()` (`rpc/providers.ts:76-156`) — both the
  update-existing branch (~line 81) and the insert-new branch (~line 141):
  after a successful write, delete any existing
  `model_capabilities_cache` rows for that `providerId` (only relevant for
  edits — a new provider has no rows yet). This forces a full reclassify on
  the provider's next fetch, since an edited `baseUrl`/`apiKey` can change
  which models are even reachable.
- `deleteProviderHandler()` (`rpc/providers.ts:244-250`) — the existing
  `ON DELETE CASCADE` on `provider_id` already cleans up automatically once
  the FK is in place; no extra code needed beyond the migration.

---

## 5. Frontend implementation

- **New RPC call**: `rpc.getModelTypes()` in `src/mainview/lib/rpc.ts`
  (same pattern as the two existing calls), added as a **third** parallel
  fetch alongside the existing `Promise.all([...])` in `models.tsx:39-67`.
- **New shared component**: `src/mainview/components/ui/model-type-badge.tsx`
  — `<ModelTypeBadge type={modelType} />`, rendering nothing for
  `language`/`unknown`, a small pill (`text-[10px] font-medium px-1.5 py-0.5
  rounded`) otherwise, using the shared `MODEL_TYPE_BADGE_STYLES` map from
  §2 (defined once, e.g. in `src/mainview/lib/model-types.ts`, so it can be
  reused later by a chat model picker without duplicating the color map).
- **Integration**: in `models.tsx`'s per-model row render (inside the
  `Card`/`CardContent` per-provider block, ~line 218-292), place
  `<ModelTypeBadge type={typesByProviderAndModel[providerId]?.[modelId]} />`
  next to the model id text. No changes to the enable/favorite/search logic.

---

## 6. Decisions to make before implementing

1. **Should `openai.ts`/`groq.ts` stop excluding non-chat models from
   `listModels()`?** Today those two adapters actively hide
   embedding/TTS/image/whisper models from ever reaching this page. Now
   that we can badge (not just hide) them, the badge feature is only useful
   for OpenAI/Groq if that blocklist is relaxed — otherwise their non-chat
   models simply never appear to badge. Recommend relaxing it (the badge
   *is* the new way to communicate "this isn't a chat model") while keeping
   a `disabled`-by-default preference for those rows via the existing
   `model_preferences.is_enabled` mechanism so they don't clutter the chat
   model picker elsewhere in the app.
2. **In-memory catalog TTL** — 24h proposed; adjust if models.dev/Gateway
   are expected to change faster/slower than that in practice.
3. **Unknown-type models** — render no badge (silent) vs. a neutral `?`
   badge. Recommend silent, to avoid implying every model was checked and
   failed, when really it's "we don't have data."

---

## 7. Rollout / existing users

No backfill needed: `model_capabilities_cache` starts empty and lazily
populates on first Models-tab view per provider, same sparse-table pattern
already used for `model_preferences`. No behavior changes for any existing
provider/model until this ships.
