import type { IssueSource } from "../../shared/rpc/issues";

/** A source-agnostic issue produced by an adapter's fetchIssues(). */
export interface NormalisedIssue {
	/** Platform-specific identifier (GitHub #, Jira key, Linear id, card id…). */
	sourceId: string;
	title: string;
	body: string | null;
	state: "open" | "closed";
	url: string | null;
	labels: string[];
	assignee: string | null;
	/** Normalised bucket: "critical" | "high" | "medium" | "low" | null. */
	priority: string | null;
	/** ISO date (YYYY-MM-DD or full ISO) if the source provides one, else null. */
	dueDate: string | null;
	sourceCreatedAt: string | null;
	/** Source-specific extras persisted to external_issues.metadata. */
	metadata?: Record<string, unknown>;
}

/** The minimal stored-issue shape an adapter needs to close/resolve it remotely. */
export interface IssueRef {
	sourceId: string;
	metadata: Record<string, unknown>;
}

export interface TestResult {
	ok: boolean;
	error?: string;
	/** Human-friendly success detail, e.g. "Connected as jane@acme — 12 issues". */
	detail?: string;
}

export interface CreateIssueInput {
	title: string;
	body: string;
	priority: string | null;
}

/**
 * A group of selectable "buckets" a source can filter imports by — Kanboard
 * columns, Trello lists, or Jira statuses. Groups let multi-project sources
 * (Kanboard) present buckets per project; single-scope sources use one group.
 */
export interface BucketGroup {
	groupId: string;
	groupName: string;
	buckets: Array<{ id: string; title: string }>;
}

/**
 * One adapter per external tracker. Config is a flat string map matching the
 * source's IssueSourceFieldDescriptor keys (resolved by the engine before any
 * of these methods are called).
 */
export interface IssueSourceAdapter {
	source: IssueSource;

	/**
	 * Resolve the usable config for a project, or null if not configured.
	 * Most sources read the saved JSON; GitHub overrides to read existing
	 * project repo URL + global token settings.
	 */
	resolveConfig(projectId: string): Promise<Record<string, string> | null>;

	/** Pull issues from the source's API. */
	fetchIssues(config: Record<string, string>): Promise<NormalisedIssue[]>;

	/** Validate connectivity + auth for a (possibly unsaved) config. */
	testConnection(config: Record<string, string>): Promise<TestResult>;

	/** Close/resolve an issue remotely. Optional — omitted when unsupported. */
	closeIssue?(config: Record<string, string>, ref: IssueRef): Promise<void>;

	/** Create a new issue/card from a kanban task. Returns the new issue. Optional. */
	createIssue?(config: Record<string, string>, input: CreateIssueInput): Promise<NormalisedIssue>;

	/**
	 * List the selectable buckets (columns/lists/statuses) for the given config,
	 * so the user can choose which to import. Throws on connection/auth failure.
	 * Only implemented by sources that support bucket selection.
	 */
	fetchBuckets?(config: Record<string, string>): Promise<BucketGroup[]>;
}

/**
 * Parse the user's selected bucket ids from config. Reads the generic `buckets`
 * key, falling back to the legacy Kanboard `columns` key for older saved config.
 */
export function parseSelectedBuckets(config: Record<string, string>): Set<string> {
	const raw = config.buckets ?? config.columns ?? "[]";
	try {
		const arr = JSON.parse(raw);
		return new Set(Array.isArray(arr) ? arr.map(String) : []);
	} catch {
		return new Set();
	}
}

/** Maps an arbitrary priority label/number to our normalised bucket. */
export function normalisePriority(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const s = String(raw).toLowerCase();
	if (/(critical|urgent|highest|blocker|p0|p1)/.test(s)) return "critical";
	if (/(high|p2)/.test(s)) return "high";
	if (/(medium|normal|moderate|p3)/.test(s)) return "medium";
	if (/(low|minor|lowest|trivial|p4|p5)/.test(s)) return "low";
	return null;
}
