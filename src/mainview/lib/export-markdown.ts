// ---------------------------------------------------------------------------
// Shared Markdown export helpers.
//
// One blob+anchor download primitive (`downloadMarkdown`) with a chat-transcript
// builder on top (`exportChatMarkdown`). Used by the dashboard PM/agent chat
// widgets, the freelance listing chat modal, and the AI-analysis panel — so the
// "export to markdown" behavior lives in exactly one place.
// ---------------------------------------------------------------------------

/** Trigger a browser download of `content` as a `.md` file. */
export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safe = filename.replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "export";
  a.download = safe.endsWith(".md") ? safe : `${safe}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ExportableChatMessage {
  /** "user" maps to the user heading; anything else uses the assistant label. */
  role: string;
  content: string;
}

/**
 * Build a Markdown transcript (one `##` heading per turn) from chat messages.
 * Callers pre-filter anything they don't want included (e.g. error bubbles);
 * empty-content messages are dropped here. Returns `null` when there's nothing
 * to render — used by both the export (download) and copy-to-clipboard paths.
 */
export function buildChatMarkdown(opts: {
  title: string;
  messages: ExportableChatMessage[];
  assistantLabel?: string;
  userLabel?: string;
}): string | null {
  const { title, messages, assistantLabel = "Assistant", userLabel = "User" } = opts;
  const exportable = messages.filter((m) => m.content.trim());
  if (exportable.length === 0) return null;
  const lines = [`# ${title}\n`];
  for (const msg of exportable) {
    lines.push(`## ${msg.role === "user" ? userLabel : assistantLabel}\n`);
    lines.push(msg.content);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Build a Markdown transcript and download it. Returns `false` (and skips the
 * download) when there's nothing exportable — let the caller suppress its
 * success toast in that case.
 */
export function exportChatMarkdown(opts: {
  title: string;
  messages: ExportableChatMessage[];
  assistantLabel?: string;
  userLabel?: string;
  /** Defaults to `title` (sanitized) when omitted. */
  filename?: string;
}): boolean {
  const content = buildChatMarkdown(opts);
  if (content === null) return false;
  downloadMarkdown(opts.filename ?? opts.title, content);
  return true;
}
