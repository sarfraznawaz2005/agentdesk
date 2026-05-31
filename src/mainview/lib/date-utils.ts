import { formatDistanceToNow } from "date-fns";

/**
 * SQLite datetime('now') stores UTC without a timezone suffix, e.g. "2026-03-14 15:44:36".
 * JavaScript's Date constructor treats bare strings as LOCAL time, so we must append 'Z'
 * to force UTC parsing. Strings that already carry timezone info (ISO 8601 with Z or +offset)
 * are left untouched.
 */
function parseDbDate(dateStr: string): Date {
	const needsUtcHint = !/Z$|[+-]\d{2}:\d{2}$/.test(dateStr);
	return new Date(needsUtcHint ? dateStr.replace(" ", "T") + "Z" : dateStr);
}

/**
 * Returns a human-readable relative time string like "just now", "5m ago", "3h ago", "2d ago".
 * Falls back to a short date string for older timestamps.
 *
 * Handles null/invalid inputs gracefully by returning a dash.
 */
export function relativeTime(dateStr: string | null | undefined): string {
	if (!dateStr) return "—";

	const d = parseDbDate(dateStr);
	if (isNaN(d.getTime())) return "—";

	const diffMs = Date.now() - d.getTime();
	if (diffMs < 0) return "just now";

	const diffMins = Math.floor(diffMs / 60_000);
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;

	const diffHours = Math.floor(diffMs / 3_600_000);
	if (diffHours < 24) return `${diffHours}h ago`;

	const diffDays = Math.floor(diffMs / 86_400_000);
	if (diffDays < 7) return `${diffDays}d ago`;

	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Returns a natural-language relative time using date-fns (e.g., "about 5 minutes ago").
 * More descriptive than relativeTime() — best for chat message timestamps.
 */
export function relativeTimeVerbose(dateStr: string | null | undefined): string {
	if (!dateStr) return "";
	try {
		return formatDistanceToNow(parseDbDate(dateStr), { addSuffix: true });
	} catch {
		return "";
	}
}

/**
 * Returns a formatted date-time string like "Mar 7, 02:30 PM".
 * Returns a dash for null/invalid inputs.
 */
export function formatDateTime(dateStr: string | null | undefined): string {
	if (!dateStr) return "—";
	const d = parseDbDate(dateStr);
	if (isNaN(d.getTime())) return "—";
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Returns a relative time string that handles future dates (e.g., "in 5m", "in 3h").
 * Used for scheduler next-run times.
 */
export function relativeTimeFuture(dateStr: string | null | undefined): string {
	if (!dateStr) return "—";
	const d = parseDbDate(dateStr);
	if (isNaN(d.getTime())) return "—";

	const diffMs = d.getTime() - Date.now();
	const absDiffMs = Math.abs(diffMs);
	const past = diffMs < 0;

	const mins = Math.floor(absDiffMs / 60_000);
	const hours = Math.floor(absDiffMs / 3_600_000);
	const days = Math.floor(absDiffMs / 86_400_000);

	let label: string;
	if (mins < 1) label = "just now";
	else if (mins < 60) label = `${mins}m`;
	else if (hours < 24) label = `${hours}h`;
	else label = `${days}d`;

	if (label === "just now") return label;
	return past ? `${label} ago` : `in ${label}`;
}
