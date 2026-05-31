import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface DiffLine {
  type: "context" | "added" | "removed" | "hunk" | "noNewline";
  content: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  header: string; // "diff --git a/foo b/foo"
  fromFile: string;
  toFile: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
}

function parseGitDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git")) { i++; continue; }

    const header = lines[i];
    let fromFile = "";
    let toFile = "";
    let isBinary = false;
    let isNew = false;
    let isDeleted = false;
    i++;

    // Consume file metadata lines until first hunk or next diff
    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git")) {
      const l = lines[i];
      if (l.startsWith("--- ")) fromFile = l.slice(4).replace(/^a\//, "");
      else if (l.startsWith("+++ ")) toFile = l.slice(4).replace(/^b\//, "");
      else if (l.startsWith("new file")) isNew = true;
      else if (l.startsWith("deleted file")) isDeleted = true;
      else if (l.includes("Binary files")) isBinary = true;
      i++;
    }

    // Derive display name from diff header when --- / +++ are /dev/null
    if (!fromFile || fromFile === "/dev/null") fromFile = header.replace("diff --git a/", "").split(" ")[0];
    if (!toFile || toFile === "/dev/null") toFile = fromFile;

    const hunks: DiffHunk[] = [];

    while (i < lines.length && !lines[i].startsWith("diff --git")) {
      if (!lines[i].startsWith("@@")) { i++; continue; }

      const hunkHeader = lines[i];
      i++;

      // Parse @@ -oldStart,oldCount +newStart,newCount @@
      const m = hunkHeader.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      let oldNo = m ? parseInt(m[1], 10) : 1;
      let newNo = m ? parseInt(m[2], 10) : 1;

      const hunkLines: DiffLine[] = [];

      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git")) {
        const l = lines[i];
        if (l.startsWith("+") && !l.startsWith("+++")) {
          hunkLines.push({ type: "added", content: l.slice(1), oldLineNo: null, newLineNo: newNo++ });
        } else if (l.startsWith("-") && !l.startsWith("---")) {
          hunkLines.push({ type: "removed", content: l.slice(1), oldLineNo: oldNo++, newLineNo: null });
        } else if (l.startsWith("\\ No newline")) {
          hunkLines.push({ type: "noNewline", content: l, oldLineNo: null, newLineNo: null });
        } else {
          hunkLines.push({ type: "context", content: l.slice(1), oldLineNo: oldNo++, newLineNo: newNo++ });
        }
        i++;
      }

      hunks.push({ header: hunkHeader, lines: hunkLines });
    }

    files.push({ header, fromFile, toFile, hunks, isBinary, isNew, isDeleted });
  }

  return files;
}

// ---------------------------------------------------------------------------
// File badge
// ---------------------------------------------------------------------------

function FileBadge({ isNew, isDeleted }: { isNew: boolean; isDeleted: boolean }) {
  if (isNew) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">NEW</span>;
  if (isDeleted) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">DELETED</span>;
  return null;
}

// ---------------------------------------------------------------------------
// Single file diff
// ---------------------------------------------------------------------------

function FileDiff({ file }: { file: DiffFile }) {
  const [collapsed, setCollapsed] = useState(true);

  const displayName = file.toFile !== "/dev/null" ? file.toFile : file.fromFile;

  return (
    <div className="border border-border rounded-md overflow-hidden text-xs font-mono">
      {/* File header */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/60 hover:bg-muted text-left"
      >
        {collapsed ? <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />}
        <span className="font-medium text-foreground truncate flex-1">{displayName}</span>
        <FileBadge isNew={file.isNew} isDeleted={file.isDeleted} />
      </button>

      {!collapsed && (
        file.isBinary ? (
          <div className="px-4 py-3 text-muted-foreground italic">Binary file — no diff available</div>
        ) : file.hunks.length === 0 ? (
          <div className="px-4 py-3 text-muted-foreground italic">No changes</div>
        ) : (
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full border-collapse">
              <tbody>
                {file.hunks.map((hunk, hi) => (
                  <>
                    {/* Hunk header */}
                    <tr key={`hunk-${hi}`} className="bg-blue-50 dark:bg-blue-950/30">
                      <td className="w-10 select-none" />
                      <td className="w-10 select-none" />
                      <td className="px-3 py-0.5 text-blue-600 dark:text-blue-400">{hunk.header}</td>
                    </tr>
                    {hunk.lines.map((line, li) => {
                      const isAdded = line.type === "added";
                      const isRemoved = line.type === "removed";
                      const isNoNl = line.type === "noNewline";
                      return (
                        <tr
                          key={`${hi}-${li}`}
                          className={
                            isAdded ? "bg-green-50 dark:bg-green-950/30" :
                            isRemoved ? "bg-red-50 dark:bg-red-950/30" :
                            isNoNl ? "bg-muted/30" : ""
                          }
                        >
                          {/* Old line number */}
                          <td className="w-10 px-2 py-0.5 text-right text-muted-foreground/60 select-none border-r border-border/50">
                            {line.oldLineNo ?? ""}
                          </td>
                          {/* New line number */}
                          <td className="w-10 px-2 py-0.5 text-right text-muted-foreground/60 select-none border-r border-border/50">
                            {line.newLineNo ?? ""}
                          </td>
                          {/* Content */}
                          <td className={`px-3 py-0.5 whitespace-pre ${isAdded ? "text-green-700 dark:text-green-400" : isRemoved ? "text-red-700 dark:text-red-400" : isNoNl ? "text-muted-foreground italic" : "text-foreground"}`}>
                            <span className="select-none mr-1 text-muted-foreground/50">
                              {isAdded ? "+" : isRemoved ? "−" : " "}
                            </span>
                            {isNoNl ? line.content : line.content}
                          </td>
                        </tr>
                      );
                    })}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function DiffViewer({ diff }: { diff: string }) {
  if (!diff?.trim()) {
    return <p className="text-sm text-muted-foreground text-center py-4">No diff to show</p>;
  }

  const files = parseGitDiff(diff);

  if (files.length === 0) {
    return (
      <div className="overflow-auto max-h-64 font-mono text-xs rounded border bg-muted/30 p-2">
        {diff.split("\n").map((line, i) => (
          <div key={i} className="text-muted-foreground">{line || " "}</div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {files.map((file, i) => <FileDiff key={i} file={file} />)}
    </div>
  );
}
