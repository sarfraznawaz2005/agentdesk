import * as React from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Shared unified-diff renderer. Used by chat tool-call cards (agent edits) and
// the Remote Sync push preview. Computes a line diff (LCS) with inline
// character highlights for changed regions.
// ---------------------------------------------------------------------------

interface DiffLine {
	type: "context" | "add" | "remove";
	content: string;
	/** Character ranges to highlight within this line (inline change). */
	highlights?: Array<[number, number]>;
}

function shortPath(p: unknown): string {
	if (typeof p !== "string") return "";
	const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.length <= 3 ? parts.join("/") : `.../${parts.slice(-2).join("/")}`;
}

function computeUnifiedDiff(
	oldStr: string,
	newStr: string,
): { lines: DiffLine[]; additions: number; deletions: number } {
	const oldLines = oldStr.split("\n");
	const newLines = newStr.split("\n");

	const m = oldLines.length;
	const n = newLines.length;

	// LCS table
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}

	// Backtrack
	const lines: DiffLine[] = [];
	let i = m, j = n;
	const stack: DiffLine[] = [];
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			stack.push({ type: "context", content: oldLines[i - 1] });
			i--; j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			stack.push({ type: "add", content: newLines[j - 1] });
			j--;
		} else {
			stack.push({ type: "remove", content: oldLines[i - 1] });
			i--;
		}
	}
	for (let k = stack.length - 1; k >= 0; k--) lines.push(stack[k]);

	computeInlineHighlights(lines);

	const additions = lines.filter((l) => l.type === "add").length;
	const deletions = lines.filter((l) => l.type === "remove").length;
	return { lines, additions, deletions };
}

function computeInlineHighlights(lines: DiffLine[]): void {
	let idx = 0;
	while (idx < lines.length) {
		const removeStart = idx;
		while (idx < lines.length && lines[idx].type === "remove") idx++;
		const removeEnd = idx;
		const addStart = idx;
		while (idx < lines.length && lines[idx].type === "add") idx++;
		const addEnd = idx;

		const removeCount = removeEnd - removeStart;
		const addCount = addEnd - addStart;

		if (removeCount > 0 && addCount > 0) {
			const pairCount = Math.min(removeCount, addCount);
			for (let p = 0; p < pairCount; p++) {
				const rmLine = lines[removeStart + p];
				const adLine = lines[addStart + p];
				const [rmHighlights, adHighlights] = computeCharHighlights(rmLine.content, adLine.content);
				if (rmHighlights.length > 0) rmLine.highlights = rmHighlights;
				if (adHighlights.length > 0) adLine.highlights = adHighlights;
			}
		}

		if (idx === removeStart) idx++;
	}
}

function computeCharHighlights(
	oldLine: string,
	newLine: string,
): [Array<[number, number]>, Array<[number, number]>] {
	if (oldLine === newLine) return [[], []];

	let prefixLen = 0;
	const minLen = Math.min(oldLine.length, newLine.length);
	while (prefixLen < minLen && oldLine[prefixLen] === newLine[prefixLen]) prefixLen++;

	let suffixLen = 0;
	while (
		suffixLen < minLen - prefixLen &&
		oldLine[oldLine.length - 1 - suffixLen] === newLine[newLine.length - 1 - suffixLen]
	) suffixLen++;

	const oldStart = prefixLen;
	const oldEnd = oldLine.length - suffixLen;
	const newStart = prefixLen;
	const newEnd = newLine.length - suffixLen;

	const oldHighlights: Array<[number, number]> = oldEnd > oldStart ? [[oldStart, oldEnd]] : [];
	const newHighlights: Array<[number, number]> = newEnd > newStart ? [[newStart, newEnd]] : [];
	return [oldHighlights, newHighlights];
}

/** Render line content with inline character highlights. */
function HighlightedContent({
	content,
	highlights,
	type,
}: {
	content: string;
	highlights?: Array<[number, number]>;
	type: "add" | "remove" | "context";
}) {
	if (!highlights || highlights.length === 0) return <>{content || " "}</>;

	const highlightClass = type === "add" ? "bg-emerald-200/70 rounded-sm" : "bg-red-200/70 rounded-sm";

	const parts: React.ReactNode[] = [];
	let cursor = 0;
	for (const [start, end] of highlights) {
		if (cursor < start) parts.push(content.slice(cursor, start));
		parts.push(<span key={start} className={highlightClass}>{content.slice(start, end)}</span>);
		cursor = end;
	}
	if (cursor < content.length) parts.push(content.slice(cursor));
	return <>{parts.length > 0 ? parts : " "}</>;
}

/** Unified diff card: a header (label + ± counts) over the colored diff body. */
export function UnifiedDiffCard({
	oldStr,
	newStr,
	filePath,
	editIndex,
	editTotal,
	maxHeightClass = "max-h-60",
}: {
	oldStr: string;
	newStr: string;
	filePath?: string;
	editIndex?: number;
	editTotal?: number;
	/** Tailwind max-height for the scroll body (default max-h-60). */
	maxHeightClass?: string;
}) {
	const { lines, additions, deletions } = computeUnifiedDiff(oldStr, newStr);
	const label = filePath ? shortPath(filePath) : "edit";

	return (
		<div className="rounded-lg overflow-hidden border border-border">
			<div className="flex items-center justify-between px-2.5 py-1 bg-muted border-b border-border">
				<span className="text-[10px] font-medium text-muted-foreground truncate">
					{editIndex != null ? `Edit ${editIndex}/${editTotal} — ` : ""}{label}
				</span>
				<div className="flex items-center gap-2 text-[10px] font-mono shrink-0">
					{additions > 0 && <span className="text-blue-600">+{additions}</span>}
					{deletions > 0 && <span className="text-red-600">-{deletions}</span>}
				</div>
			</div>
			<div className={cn("overflow-y-auto text-[11px] font-mono leading-relaxed", maxHeightClass)}>
				{lines.map((line, idx) => (
					<div
						key={idx}
						className={cn(
							"px-2.5 whitespace-pre-wrap break-all",
							line.type === "add" && "bg-emerald-50 text-emerald-800",
							line.type === "remove" && "bg-red-50 text-red-800",
							line.type === "context" && "text-muted-foreground",
						)}
					>
						<span className="inline-block w-4 text-right mr-2 text-muted-foreground/60 select-none shrink-0">
							{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
						</span>
						<HighlightedContent content={line.content} highlights={line.highlights} type={line.type} />
					</div>
				))}
			</div>
		</div>
	);
}
