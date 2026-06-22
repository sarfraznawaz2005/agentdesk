import { sqlite } from "../connection";

export const name = "freelance-listings-indexes";

/**
 * Add the missing indexes behind the freelance hot paths. `freelance_listings`
 * had only its primary key, so every Listings tab switch / page / search and
 * every background `listingsUpdated` refresh ran full table scans on the
 * synchronous bun:sqlite driver — serializing all other RPC replies while they
 * executed.
 *
 * 1. idx_freelance_listings_active — getListings()/getListingCounts() filter on
 *    (is_deleted, status) and order by fetched_at (rpc/freelance.ts).
 * 2. idx_freelance_outbox_listing — the "has a sent bid?" anti-join
 *    (... listing_id IN/NOT IN (SELECT listing_id FROM freelance_outbox
 *    WHERE kind='bid' AND status='sent')) hit on every listings page load, plus
 *    the per-page sentBid lookup and the auto-bid dup check.
 * 3/4. idx_freelance_listings_external / _title — the thread→listing correlation
 *    in session/ingest.ts looks up `external_id = ?` and `title = ?` per
 *    correlatable thread on every inbox sync.
 * 5. idx_freelance_inbox_threads_ctx — that same correlation pass selects
 *    threads by (platform, context_id).
 *
 * All CREATE INDEX IF NOT EXISTS — idempotent and safe for existing users
 * (purely additive; no data change).
 */
export function run(): void {
	sqlite.exec(
		`CREATE INDEX IF NOT EXISTS idx_freelance_listings_active
		 ON freelance_listings(is_deleted, status, fetched_at)`,
	);
	sqlite.exec(
		`CREATE INDEX IF NOT EXISTS idx_freelance_outbox_listing
		 ON freelance_outbox(listing_id, kind, status)`,
	);
	sqlite.exec(
		`CREATE INDEX IF NOT EXISTS idx_freelance_listings_external
		 ON freelance_listings(external_id, is_deleted)`,
	);
	sqlite.exec(
		`CREATE INDEX IF NOT EXISTS idx_freelance_listings_title
		 ON freelance_listings(title, is_deleted)`,
	);
	sqlite.exec(
		`CREATE INDEX IF NOT EXISTS idx_freelance_inbox_threads_ctx
		 ON freelance_inbox_threads(platform, context_id)`,
	);
}
