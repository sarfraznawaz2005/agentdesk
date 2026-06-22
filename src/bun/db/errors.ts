// ---------------------------------------------------------------------------
// Query-error predicates
//
// SQLite surfaces constraint failures as a generic SQLiteError whose `message`
// carries the specific constraint (e.g. "UNIQUE constraint failed: table.col").
// These helpers translate that opaque error into a typed question callers can
// branch on — so a check-then-write race resolves to a friendly, domain-specific
// message instead of leaking a raw SQLiteError into the error log.
// ---------------------------------------------------------------------------

/** True if `err` is SQLite's UNIQUE / PRIMARY KEY constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
	return (
		err instanceof Error &&
		/UNIQUE constraint failed|PRIMARY KEY( constraint)? must be unique/i.test(err.message)
	);
}
