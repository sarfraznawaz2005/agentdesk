import { getSavedConfig } from "./config-store";
import { parseSelectedBuckets } from "./types";
import type { IssueSourceAdapter, NormalisedIssue, TestResult, IssueRef, CreateIssueInput, BucketGroup } from "./types";

const TRELLO_API = "https://api.trello.com/1";

// Cap on imported cards (mirrors the 100-limit of the other sources).
const MAX_CARDS = 100;

/** Trello object ids embed their creation time in the first 8 hex chars. */
function createdFromId(id: string): string | null {
	const secs = parseInt(id.substring(0, 8), 16);
	return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : null;
}

function authQuery(config: Record<string, string>): string {
	return `key=${encodeURIComponent(config.apiKey)}&token=${encodeURIComponent(config.token)}`;
}

async function trelloFetch(
	config: Record<string, string>,
	path: string,
	options: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
	const sep = path.includes("?") ? "&" : "?";
	const res = await fetch(`${TRELLO_API}${path}${sep}${authQuery(config)}`, {
		...options,
		headers: { Accept: "application/json", ...(options.headers ?? {}) },
	});
	let data: unknown;
	try {
		data = await res.json();
	} catch {
		data = {};
	}
	return { ok: res.ok, status: res.status, data };
}

interface TrelloCard {
	id: string;
	name: string;
	desc: string;
	url: string;
	closed: boolean;
	idList: string;
	dateLastActivity: string;
	due: string | null;
	labels: Array<{ name: string; color: string }>;
}

interface TrelloList {
	id: string;
	name: string;
}

async function fetchLists(config: Record<string, string>): Promise<Map<string, TrelloList>> {
	const res = await trelloFetch(config, `/boards/${config.boardId}/lists?fields=name`);
	if (!res.ok) return new Map();
	const lists = res.data as TrelloList[];
	return new Map(lists.map((l) => [l.id, l]));
}

// Buckets = board lists. A board is a single group. Throws on connection failure.
async function fetchTrelloBuckets(config: Record<string, string>): Promise<BucketGroup[]> {
	const boardRes = await trelloFetch(config, `/boards/${config.boardId}?fields=name`);
	if (!boardRes.ok) {
		const msg = typeof boardRes.data === "string" ? boardRes.data : `HTTP ${boardRes.status} — check API key, token and board ID.`;
		throw new Error(`Trello API error: ${msg}`);
	}
	const board = boardRes.data as { name?: string };
	const listsRes = await trelloFetch(config, `/boards/${config.boardId}/lists?fields=name&filter=open`);
	if (!listsRes.ok) throw new Error(`Trello API error: could not load lists (HTTP ${listsRes.status}).`);
	const lists = (listsRes.data as TrelloList[]) ?? [];
	return [
		{
			groupId: config.boardId,
			groupName: board.name ?? `Board ${config.boardId}`,
			buckets: lists.map((l) => ({ id: l.id, title: l.name })),
		},
	];
}

export const trelloAdapter: IssueSourceAdapter = {
	source: "trello",

	resolveConfig(projectId) {
		return getSavedConfig(projectId, "trello");
	},

	fetchBuckets(config) {
		return fetchTrelloBuckets(config);
	},

	async fetchIssues(config): Promise<NormalisedIssue[]> {
		const lists = await fetchLists(config);
		const selectedLists = parseSelectedBuckets(config);
		// filter=open excludes archived cards.
		const res = await trelloFetch(
			config,
			`/boards/${config.boardId}/cards?filter=open&fields=name,desc,url,closed,idList,dateLastActivity,due,labels`,
		);
		if (!res.ok) {
			const msg = typeof res.data === "string" ? res.data : `HTTP ${res.status}`;
			throw new Error(`Trello API error: ${msg}`);
		}
		const cards = (res.data as TrelloCard[])
			// Keep only cards in the user-selected lists (fall back to all open cards
			// if nothing is selected, for legacy configs).
			.filter((c) => !c.closed && (selectedLists.size === 0 || selectedLists.has(c.idList)));

		// Newest first (by card-id timestamp), capped to MAX_CARDS.
		cards.sort((a, b) => (createdFromId(b.id) ?? "").localeCompare(createdFromId(a.id) ?? ""));
		return cards.slice(0, MAX_CARDS).map<NormalisedIssue>((c) => {
			const listName = lists.get(c.idList)?.name ?? "";
			return {
				sourceId: c.id,
				title: c.name,
				body: c.desc || null,
				state: "open",
				url: c.url,
				labels: c.labels.map((l) => l.name || l.color).filter(Boolean),
				assignee: null,
				priority: null,
				dueDate: c.due ?? null,
				sourceCreatedAt: createdFromId(c.id),
				metadata: { listName, idList: c.idList },
			};
		});
	},

	async testConnection(config): Promise<TestResult> {
		try {
			const groups = await fetchTrelloBuckets(config);
			const lists = groups[0]?.buckets.length ?? 0;
			return { ok: true, detail: `Connected to board "${groups[0]?.groupName}" — ${lists} list(s)` };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : "Connection failed." };
		}
	},

	async closeIssue(config, ref: IssueRef) {
		// Archive the card (Trello has no "closed" state for cards beyond archiving).
		await trelloFetch(config, `/cards/${ref.sourceId}?closed=true`, { method: "PUT" });
	},

	async createIssue(config, input: CreateIssueInput): Promise<NormalisedIssue> {
		// Place the new card on the first list of the board.
		const lists = await fetchLists(config);
		const firstList = [...lists.values()][0];
		if (!firstList) throw new Error("Trello board has no lists to add a card to.");
		const params = new URLSearchParams({ idList: firstList.id, name: input.title, desc: input.body });
		const res = await trelloFetch(config, `/cards?${params.toString()}`, { method: "POST" });
		if (!res.ok) {
			const msg = typeof res.data === "string" ? res.data : `HTTP ${res.status}`;
			throw new Error(`Trello API error: ${msg}`);
		}
		const card = res.data as TrelloCard;
		return {
			sourceId: card.id,
			title: card.name,
			body: card.desc || null,
			state: "open",
			url: card.url,
			labels: [],
			assignee: null,
			priority: null,
			dueDate: card.due ?? null,
			sourceCreatedAt: createdFromId(card.id),
			metadata: { idList: firstList.id, listName: firstList.name },
		};
	},
};
