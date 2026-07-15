// Collections Chat — streaming, tool-calling assistant over the user's saved notes.
//
// Mirrors src/bun/rpc/dashboard.ts's dashboard PM chat: in-memory session history +
// abort controllers keyed by sessionId, streamText() + tool() + isStepCount, tokens/tool
// calls broadcast to the webview via broadcastToWebview. No DB persistence, no kanban
// AgentEngine — this is a single fixed built-in assistant, same positioning as the
// dashboard widgets, not a DB-configurable custom agent.
//
// Tool set is deliberately read-only (search/read/list + skills/web) — no note-creation
// tool. Saving a note stays a deliberate human UI action (docs/collections-plan.md §"Agent
// write access").

import { streamText, tool, isStepCount, type ModelMessage } from "ai";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { collectionNotes, aiProviders } from "../db/schema";
import { createProviderAdapter, getDefaultModel } from "../providers";
import { isHaikuModel } from "../providers/claude-subscription";
import { getStreamingMode } from "../agents/streaming-mode";
import { createThrottledAccumulator } from "../agents/throttled-accumulator";
import { embedText } from "./embeddings/embedder";
import { unpackVector, rankBySimilarity, type VectorEntry } from "./embeddings/similarity";
import { isEmbeddingModelDownloaded } from "./embeddings/model-manager";
// Note: rpc/collections.ts imports sendCollectionsChatMessage etc. from this file, so this
// is an intentional two-way ESM cycle — safe here because every use below is inside an
// async function body (evaluated after both modules finish loading), never at module scope.
import { searchCollectionNotes, getCollectionNote, listCollections } from "../rpc/collections";
import { getSetting } from "../rpc/settings";
import { webTools } from "../agents/tools/web";
import { skillTools } from "../agents/tools/skills";
import { skillRegistry } from "../skills/registry";
import { broadcastToWebview } from "../engine-manager";
import { buildUserProfileSection, SECURITY_RULES_SECTION } from "../agents/prompts";
import type {
	CollectionChatCitationDto,
	CollectionSearchScope,
} from "../../shared/rpc/collections";

const DEFAULT_TOP_K = 5;
// Below this cosine similarity, a note isn't meaningfully "about" the query — without this
// floor, rankBySimilarity always returns up to topK notes regardless of how weak the match
// is, which would cite unrelated notes just to fill the quota.
const DEFAULT_MIN_SEMANTIC_SIMILARITY = 0.35;

// User-adjustable via Settings → Collections → Search Tuning (settings.category "collections").
// Falls back to the defaults above, clamped to sane bounds against a corrupted/out-of-range
// stored value.
async function getSemanticSearchTuning(): Promise<{ topK: number; minSimilarity: number }> {
	const [storedTopK, storedThreshold] = await Promise.all([
		getSetting("semanticTopK", "collections"),
		getSetting("semanticSimilarityThreshold", "collections"),
	]);
	const topK = typeof storedTopK === "number" && storedTopK >= 1 && storedTopK <= 10 ? storedTopK : DEFAULT_TOP_K;
	const minSimilarity =
		typeof storedThreshold === "number" && storedThreshold >= 0 && storedThreshold <= 1 ? storedThreshold : DEFAULT_MIN_SEMANTIC_SIMILARITY;
	return { topK, minSimilarity };
}

// ---------------------------------------------------------------------------
// In-memory state — mirrors dashboard.ts:45-46
// ---------------------------------------------------------------------------

const sessionHistory = new Map<string, ModelMessage[]>();
const activeAborts = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

async function buildCollectionsSystemPrompt(): Promise<string> {
	let prompt = `You are the AgentDesk Collections assistant — a personal knowledge-base Q&A helper over the user's saved notes.

You can help with:
- Finding and summarizing notes relevant to a question (use \`search_notes\`, and \`semantic_search_notes\` if available, for fuzzier/conceptual queries)
- Reading a specific note in full once you have its id (\`read_note\`)
- Listing the user's collections/folders (\`list_collections\`)
- Browsing installed skills and reading their instructions
- Answering general questions or searching the web when the answer isn't in the user's notes

You do NOT have a tool to create, edit, tag, or delete notes — saving is always a deliberate action the user takes in the UI, never something you do on their behalf. If asked to "save this" or "create a note", explain that you can't do that directly and suggest they use the Save button.

Always search before answering a question about the user's notes — don't guess from general knowledge when the answer might be in their saved notes. Cite which notes you used by referring to their titles naturally in your answer; the UI will surface clickable citations separately.

If the user's message is short, ambiguous, or just a bare word/name/phrase rather than a clear conversational question, do NOT reply with a generic greeting or capability list — assume they want you to search their notes for it. Call \`search_notes\` (and \`semantic_search_notes\` if available) with that term first, then answer from whatever you find. Only fall back to asking what they'd like help with if the search comes back empty and the message truly gives you nothing to search for.

Be concise and helpful.

${SECURITY_RULES_SECTION}`;

	const userSection = await buildUserProfileSection();
	if (userSection) {
		prompt += `\n\n${userSection}`;
	}

	const skills = skillRegistry.getAll();
	if (skills.length > 0) {
		const lines = skills.map((s) => {
			const agentTag = s.preferredAgent ? ` [agent: ${s.preferredAgent}]` : "";
			return `- **${s.name}**: ${s.description.slice(0, 120)}${agentTag}`;
		});
		prompt += `\n\n## Available Skills\n\nThe following skills are installed. Use \`read_skill\` to load a skill's full instructions. Use \`find_skills\` to search by keyword.\n\n${lines.join("\n")}`;
	}

	return prompt;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type NoteRow = {
	id: string;
	title: string;
	collectionId: string;
	embedding: Buffer | null;
};

function createCollectionsChatTools(
	scope: CollectionSearchScope,
	citationSink: Map<string, CollectionChatCitationDto>,
	tuning: { topK: number; minSimilarity: number },
) {
	return {
		search_notes: tool({
			description: "Keyword/full-text search over the user's saved notes (title + content). Always available — try this first.",
			inputSchema: z.object({
				query: z.string().describe("Search text"),
			}),
			execute: async (args) => {
				const results = await searchCollectionNotes({ query: args.query, scope });
				for (const r of results) citationSink.set(r.id, { noteId: r.id, title: r.title, collectionId: r.collectionId });
				return JSON.stringify({
					results: results.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet, collectionId: r.collectionId })),
					count: results.length,
				});
			},
		}),

		...(isEmbeddingModelDownloaded()
			? {
					semantic_search_notes: tool({
						description: "Meaning-based search over notes using embeddings — better than search_notes for fuzzy/conceptual queries with no exact keyword match.",
						inputSchema: z.object({
							query: z.string().describe("Natural-language query"),
						}),
						execute: async (args) => {
							const conditions = [eq(collectionNotes.isDeleted, 0)];
							if (scope !== "all") conditions.push(eq(collectionNotes.collectionId, scope));
							const rows: NoteRow[] = await db
								.select({
									id: collectionNotes.id,
									title: collectionNotes.title,
									collectionId: collectionNotes.collectionId,
									embedding: collectionNotes.embedding,
								})
								.from(collectionNotes)
								.where(and(...conditions));

							const byId = new Map(rows.map((r) => [r.id, r]));
							const corpus: VectorEntry[] = rows
								.filter((r) => r.embedding !== null)
								.map((r) => ({ id: r.id, vector: unpackVector(r.embedding as Buffer) }));
							if (corpus.length === 0) {
								return JSON.stringify({ results: [], count: 0, note: "No indexed notes in this scope yet." });
							}

							const queryVector = await embedText(args.query);
							const topNotes = rankBySimilarity(queryVector, corpus, tuning.topK)
								.filter((r) => r.similarity >= tuning.minSimilarity)
								.map((r) => byId.get(r.id))
								.filter((n): n is NoteRow => n !== undefined);
							for (const n of topNotes) citationSink.set(n.id, { noteId: n.id, title: n.title, collectionId: n.collectionId });
							return JSON.stringify({
								results: topNotes.map((n) => ({ id: n.id, title: n.title, collectionId: n.collectionId })),
								count: topNotes.length,
								note: topNotes.length === 0 ? "No sufficiently relevant notes found by meaning — try search_notes for an exact keyword instead." : undefined,
							});
						},
					}),
				}
			: {}),

		read_note: tool({
			description: "Read a note's full content by id. Use an id from search_notes/semantic_search_notes results.",
			inputSchema: z.object({
				note_id: z.string().describe("The note's id, from a prior search result"),
			}),
			execute: async (args) => {
				const note = await getCollectionNote(args.note_id);
				if (!note) return JSON.stringify({ error: "Note not found" });
				citationSink.set(note.id, { noteId: note.id, title: note.title, collectionId: note.collectionId });
				return JSON.stringify({
					id: note.id,
					title: note.title,
					contentMarkdown: note.contentMarkdown,
					collectionId: note.collectionId,
					tags: note.tags,
				});
			},
		}),

		list_collections: tool({
			description: "List the user's collections (folders) with names and note counts.",
			inputSchema: z.object({}),
			execute: async () => {
				const collections = await listCollections();
				return JSON.stringify({
					collections: collections.map((c) => ({ id: c.id, name: c.name, noteCount: c.noteCount, isDefault: c.isDefault })),
				});
			},
		}),

		// Skill tools (read-only — browse and read installed skills)
		read_skill: skillTools.read_skill.tool,
		find_skills: skillTools.find_skills.tool,

		// Web tools (reuse existing implementations)
		web_search: webTools.web_search.tool,
		web_fetch: webTools.web_fetch.tool,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getDefaultProviderAndModel(): Promise<{ adapter: ReturnType<typeof createProviderAdapter>; providerType: string; modelId: string } | null> {
	const defaultRows = await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1);
	const row = defaultRows[0] ?? (await db.select().from(aiProviders).limit(1))[0];
	if (!row) return null;

	const adapter = createProviderAdapter({
		id: row.id,
		name: row.name,
		providerType: row.providerType,
		apiKey: row.apiKey,
		baseUrl: row.baseUrl ?? null,
		defaultModel: row.defaultModel ?? null,
	});
	return { adapter, providerType: row.providerType, modelId: row.defaultModel ?? getDefaultModel(row.providerType) };
}

// The SDK's query() takes a single prompt, not a ModelMessage[] — flatten the
// conversation history into a text transcript, same approach engine.ts uses
// for the PM's own CLI/SDK-routed transcript.
function flattenHistoryForCli(history: ModelMessage[]): string {
	return history.map((m) => {
		const text = typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content.map((p) => (p && typeof p === "object" && "text" in p ? (p as { text?: string }).text ?? "" : "")).filter(Boolean).join("\n")
				: "";
		return `[${m.role}]\n${text}`;
	}).join("\n\n");
}

// ---------------------------------------------------------------------------
// Exported RPC handlers
// ---------------------------------------------------------------------------

export async function sendCollectionsChatMessage(params: {
	sessionId: string;
	content: string;
	scope: CollectionSearchScope;
}): Promise<{ messageId: string }> {
	const { sessionId, content, scope } = params;

	// Cancel any existing stream for this session
	activeAborts.get(sessionId)?.abort();

	const messageId = crypto.randomUUID();
	const abortController = new AbortController();
	activeAborts.set(sessionId, abortController);

	const history = sessionHistory.get(sessionId) ?? [];
	const newHistory: ModelMessage[] = [...history, { role: "user", content }];
	sessionHistory.set(sessionId, newHistory);

	const citationSink = new Map<string, CollectionChatCitationDto>();

	(async () => {
		let fullText = "";
		try {
			const providerAndModel = await getDefaultProviderAndModel();
			if (!providerAndModel) {
				throw new Error("No AI provider is configured yet. Add one in Settings → AI → AI Providers.");
			}
			const { adapter, providerType, modelId } = providerAndModel;
			const tuning = await getSemanticSearchTuning();
			const tools = createCollectionsChatTools(scope, citationSink, tuning);
			const systemPrompt = await buildCollectionsSystemPrompt();
			const streamingMode = await getStreamingMode();
			const isFullStreaming = streamingMode === "full";
			const isNoStreaming = streamingMode === "none";

			// Claude Subscription's direct-HTTP OAuth path 429s for anything but
			// Haiku — non-Haiku models route through the official Agent SDK
			// instead (see providers/claude-subscription.ts / claude-subscription-cli-runner.ts).
			if (providerType === "claude-subscription" && !isHaikuModel(modelId)) {
				const { runClaudeCliTask } = await import("../providers/claude-subscription-cli-runner");
				// Full Streaming only — broadcastToWebview appends client-side, so
				// only the slice new since the last throttled flush is ever sent.
				let flushedLength = 0;
				const textAcc = isFullStreaming ? createThrottledAccumulator((acc) => {
					const delta = acc.slice(flushedLength);
					flushedLength = acc.length;
					if (delta) broadcastToWebview("collectionsChatChunk", { sessionId, messageId, token: delta });
				}) : null;
				const cliResult = await runClaudeCliTask({
					task: flattenHistoryForCli(newHistory),
					systemPrompt,
					tools,
					modelId,
					timeoutMs: 900_000,
					abortSignal: abortController.signal,
					verifyToolCall: false, // Collections chat is Q&A over notes — a turn may legitimately need zero tool calls
					onText: (text) => {
						fullText += text;
						if (!isFullStreaming) broadcastToWebview("collectionsChatChunk", { sessionId, messageId, token: text });
					},
					onReasoning: () => { /* Collections chat doesn't surface reasoning today (same as the streamText path, which ignores 'reasoning' parts) */ },
					onTextToken: (delta) => textAcc?.push(delta),
					onRetract: () => { textAcc?.cancel(); flushedLength = 0; },
					onToolCallStart: (toolName, args) => {
						broadcastToWebview("collectionsChatToolCall", { sessionId, toolName, args: args as Record<string, unknown> });
						return crypto.randomUUID();
					},
					onToolCallEnd: () => { /* no tool-result broadcast today, matching the streamText path */ },
				});
				textAcc?.flushNow();

				if (abortController.signal.aborted) return;
				if (cliResult.status === "cancelled") return;
				if (cliResult.status === "timeout") {
					throw Object.assign(new Error("This request hit the 15-minute time limit and was stopped. Send a follow-up to continue."), { name: "TimeoutError" });
				}
				if (cliResult.status === "failed") {
					throw new Error(cliResult.summary);
				}
				if (!fullText.trim()) fullText = cliResult.summary;
			} else {
				const model = adapter.createModel(modelId);

				const result = streamText({
					model,
					instructions: systemPrompt,
					messages: newHistory,
					tools,
					stopWhen: [isStepCount(20)],
					abortSignal: AbortSignal.any([abortController.signal, AbortSignal.timeout(900_000)]),
				});

				for await (const part of result.stream) {
					if (part.type === "text-delta") {
						const text = (part as { text?: string }).text ?? "";
						fullText += text;
						if (!isNoStreaming) broadcastToWebview("collectionsChatChunk", { sessionId, messageId, token: text });
					} else if (part.type === "tool-call") {
						const tcInput = (part as Record<string, unknown>).input ?? (part as Record<string, unknown>).args;
						broadcastToWebview("collectionsChatToolCall", { sessionId, toolName: part.toolName, args: tcInput as Record<string, unknown> });
					} else if (part.type === "error") {
						const err = (part as { error: unknown }).error;
						throw err instanceof Error ? err : new Error(String(err));
					}
				}

				if (!fullText.trim()) {
					let finalText = "";
					try { finalText = await result.text; } catch { /* not available */ }
					if (finalText.trim()) {
						fullText = finalText;
						if (!isNoStreaming) broadcastToWebview("collectionsChatChunk", { sessionId, messageId, token: fullText });
					}
				}
			}

			if (!fullText.trim()) {
				throw new Error("The AI model returned an empty response. Check your provider quota or switch to a different model.");
			}

			if (fullText) {
				const updatedHistory = sessionHistory.get(sessionId) ?? newHistory;
				sessionHistory.set(sessionId, [...updatedHistory, { role: "assistant", content: fullText }]);
			}

			broadcastToWebview("collectionsChatComplete", {
				sessionId,
				messageId,
				content: fullText,
				citations: [...citationSink.values()],
			});
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") return;
			if (err instanceof Error && err.name === "AbortError") return;
			const isTimeout = err instanceof Error && err.name === "TimeoutError";
			const errMsg = isTimeout
				? "This request hit the 15-minute time limit and was stopped. Send a follow-up to continue."
				: err instanceof Error ? err.message : String(err);
			broadcastToWebview("collectionsChatError", { sessionId, error: errMsg });
		} finally {
			activeAborts.delete(sessionId);
		}
	})();

	return { messageId };
}

export function abortCollectionsChatMessage(params: { sessionId: string }): { success: boolean } {
	const ctrl = activeAborts.get(params.sessionId);
	if (ctrl) {
		ctrl.abort();
		activeAborts.delete(params.sessionId);
		return { success: true };
	}
	return { success: false };
}

export function clearCollectionsChatSession(params: { sessionId: string }): { success: boolean } {
	sessionHistory.delete(params.sessionId);
	activeAborts.get(params.sessionId)?.abort();
	activeAborts.delete(params.sessionId);
	return { success: true };
}
