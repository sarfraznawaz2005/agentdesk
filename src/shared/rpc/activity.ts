// RPC contract for per-project "unread agent activity" tracking.

export interface UnreadActivityEntry {
	projectId: string;
	location: string;
}

export type ActivityRequests = {
	getUnreadActivity: {
		params: Record<string, never>;
		// `entries` = per-tab leaf unreads; `cards` = projectIds whose card dot shows.
		response: { entries: UnreadActivityEntry[]; cards: string[] };
	};
	markActivitySeen: {
		params: { projectId: string; location: string };
		response: { ok: boolean };
	};
};
