import { useMemo } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DiffLineKind = "added" | "removed" | "unchanged";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the old file (1-based), null for added lines */
  oldLineNo: number | null;
  /** Line number in the new file (1-based), null for removed lines */
  newLineNo: number | null;
}

interface SeparatorEntry {
  kind: "separator";
  hiddenCount: number;
}

type CollapsedEntry = DiffLine | SeparatorEntry;

// ---------------------------------------------------------------------------
// LCS-based line diff algorithm
// ---------------------------------------------------------------------------

/**
 * Compute the Longest Common Subsequence (LCS) lengths table for two string
 * arrays. Returns a 2-D array where lcs[i][j] is the LCS length of
 * oldLines[0..i-1] and newLines[0..j-1].
 */
function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  // Allocate a flat (m+1)*(n+1) array for efficiency
  const table = new Array<number[]>(m + 1);
  for (let i = 0; i <= m; i++) {
    table[i] = new Array<number>(n + 1).fill(0);
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }
  return table;
}

/**
 * Backtrack through the LCS table to produce a sequence of DiffLine entries.
 */
function buildDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const table = buildLcsTable(oldLines, newLines);
  const result: DiffLine[] = [];

  let i = oldLines.length;
  let j = newLines.length;

  // Accumulate in reverse then flip
  const reversed: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversed.push({ kind: "unchanged", text: oldLines[i - 1], oldLineNo: i, newLineNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      reversed.push({ kind: "added", text: newLines[j - 1], oldLineNo: null, newLineNo: j });
      j--;
    } else {
      reversed.push({ kind: "removed", text: oldLines[i - 1], oldLineNo: i, newLineNo: null });
      i--;
    }
  }

  for (let k = reversed.length - 1; k >= 0; k--) {
    result.push(reversed[k]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Context collapsing
// ---------------------------------------------------------------------------

const CONTEXT_LINES = 3;
const COLLAPSE_THRESHOLD = 6; // collapse runs longer than this many unchanged lines

/**
 * Given a flat list of DiffLine entries, collapse long runs of unchanged lines
 * that are not adjacent to any changed line into a single SeparatorEntry.
 *
 * Rules:
 *  - Keep up to CONTEXT_LINES unchanged lines immediately before/after a change.
 *  - Any run of unchanged lines longer than COLLAPSE_THRESHOLD that is not
 *    covered by the context window becomes a separator.
 */
function collapseContext(lines: DiffLine[]): CollapsedEntry[] {
  const n = lines.length;
  // Build a boolean mask: true means "keep this line visible".
  const keep = new Array<boolean>(n).fill(false);

  for (let i = 0; i < n; i++) {
    if (lines[i].kind !== "unchanged") {
      // Mark CONTEXT_LINES before and after this changed line.
      for (let c = Math.max(0, i - CONTEXT_LINES); c <= Math.min(n - 1, i + CONTEXT_LINES); c++) {
        keep[c] = true;
      }
    }
  }

  const result: CollapsedEntry[] = [];
  let hiddenRun = 0;

  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      // Flush any pending hidden run as a separator (only if it exceeds the threshold).
      if (hiddenRun > COLLAPSE_THRESHOLD) {
        result.push({ kind: "separator", hiddenCount: hiddenRun });
      } else {
        // Not worth collapsing — emit the hidden lines individually.
        // Walk back and add them. We know they are all "unchanged".
        const startIdx = i - hiddenRun;
        for (let b = startIdx; b < i; b++) {
          result.push(lines[b]);
        }
      }
      hiddenRun = 0;
      result.push(lines[i]);
    } else {
      hiddenRun++;
    }
  }

  // Handle any trailing hidden run.
  if (hiddenRun > COLLAPSE_THRESHOLD) {
    result.push({ kind: "separator", hiddenCount: hiddenRun });
  } else {
    const startIdx = n - hiddenRun;
    for (let b = startIdx; b < n; b++) {
      result.push(lines[b]);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface PlanDiffProps {
  oldContent: string;
  newContent: string;
  className?: string;
}

export function PlanDiff({ oldContent, newContent, className }: PlanDiffProps) {
  const diffLines = useMemo(() => {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    return buildDiff(oldLines, newLines);
  }, [oldContent, newContent]);

  // Collapsed view: unchanged lines far from any change are replaced with separators.
  const collapsedLines = useMemo(() => collapseContext(diffLines), [diffLines]);

  // Count stats for the header badge
  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const line of diffLines) {
      if (line.kind === "added") added++;
      else if (line.kind === "removed") removed++;
    }
    return { added, removed };
  }, [diffLines]);

  // Max line numbers for column width calculation
  const maxOldLineNo = useMemo(
    () => Math.max(0, ...diffLines.map((l) => l.oldLineNo ?? 0)),
    [diffLines],
  );
  const maxNewLineNo = useMemo(
    () => Math.max(0, ...diffLines.map((l) => l.newLineNo ?? 0)),
    [diffLines],
  );
  const lineNoWidth = Math.max(String(maxOldLineNo).length, String(maxNewLineNo).length, 2);

  return (
    <div className={cn("rounded-lg border border-border overflow-hidden text-xs", className)}>
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-1.5 bg-muted/50 border-b border-border">
        <span className="font-medium text-muted-foreground">Changes</span>
        {stats.added > 0 && (
          <span className="font-mono text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">
            +{stats.added}
          </span>
        )}
        {stats.removed > 0 && (
          <span className="font-mono text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
            -{stats.removed}
          </span>
        )}
      </div>

      {/* Diff body */}
      <div
        className="overflow-y-auto max-h-64 font-mono"
        role="region"
        aria-label="Plan diff"
      >
        <table className="w-full border-collapse">
          <thead className="sr-only">
            <tr>
              <th scope="col">Old line</th>
              <th scope="col">New line</th>
              <th scope="col">Change type</th>
              <th scope="col">Content</th>
            </tr>
          </thead>
          <tbody>
            {collapsedLines.map((entry, idx) => {
              if (entry.kind === "separator") {
                return (
                  <tr key={idx} className="bg-muted/50">
                    <td
                      colSpan={4}
                      className="py-0.5 text-muted-foreground/60 text-center italic select-none"
                      aria-label={`${entry.hiddenCount} unchanged lines hidden`}
                    >
                      ... {entry.hiddenCount} unchanged {entry.hiddenCount === 1 ? "line" : "lines"} ...
                    </td>
                  </tr>
                );
              }

              const line = entry;
              const isAdded = line.kind === "added";
              const isRemoved = line.kind === "removed";

              return (
                <tr
                  key={idx}
                  className={cn(
                    "leading-5",
                    isAdded && "bg-green-50 dark:bg-green-950/30",
                    isRemoved && "bg-red-50 dark:bg-red-950/30",
                    !isAdded && !isRemoved && "bg-background",
                  )}
                >
                  {/* Old line number */}
                  <td
                    className={cn(
                      "select-none text-right px-2 border-r border-border text-muted-foreground/60 w-0 whitespace-nowrap",
                      isRemoved && "text-red-400",
                    )}
                    style={{ minWidth: `${lineNoWidth + 1}ch` }}
                    aria-hidden="true"
                  >
                    {line.oldLineNo ?? ""}
                  </td>

                  {/* New line number */}
                  <td
                    className={cn(
                      "select-none text-right px-2 border-r border-border text-muted-foreground/60 w-0 whitespace-nowrap",
                      isAdded && "text-green-500",
                    )}
                    style={{ minWidth: `${lineNoWidth + 1}ch` }}
                    aria-hidden="true"
                  >
                    {line.newLineNo ?? ""}
                  </td>

                  {/* Change indicator */}
                  <td
                    className={cn(
                      "select-none px-1.5 w-0 text-center font-bold",
                      isAdded && "text-green-600",
                      isRemoved && "text-red-600",
                      !isAdded && !isRemoved && "text-muted-foreground/40",
                    )}
                    aria-hidden="true"
                  >
                    {isAdded ? "+" : isRemoved ? "-" : " "}
                  </td>

                  {/* Line content */}
                  <td
                    className={cn(
                      "px-2 py-0 whitespace-pre-wrap break-all",
                      isAdded && "text-green-900",
                      isRemoved && "text-red-900",
                      !isAdded && !isRemoved && "text-foreground/80",
                    )}
                  >
                    {line.text || " "}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
