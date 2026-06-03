import { useState, memo, lazy, Suspense, useRef, useCallback } from "react";
import { ImageLightbox } from "./image-lightbox";
import {
	ChevronRight,
	ChevronDown,
	Loader2,
	Check,
	X,
	FileText,
	Pencil,
	Play,
	Cpu,
	FolderTree,
	Search,
	GitBranch,
	GitCompare,
	Globe,
	Wrench,
	Trash2,
	Copy as CopyIcon,
	FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { UnifiedDiffCard } from "@/components/ui/unified-diff";

const LazyCodeBlock = lazy(() => import("./code-block").then((m) => ({ default: m.CodeBlock })));

// ---------------------------------------------------------------------------
// Inline image with click-to-lightbox
// ---------------------------------------------------------------------------

function InlineImage({ src, caption }: { src: string; caption?: string }) {
	const [lightboxOpen, setLightboxOpen] = useState(false);
	return (
		<div className="flex flex-col gap-1.5">
			<img
				src={src}
				alt="Screenshot"
				className="rounded-lg border border-border shadow-sm max-w-full object-contain cursor-zoom-in"
				style={{ maxHeight: 400 }}
				onClick={() => setLightboxOpen(true)}
				title="Click to enlarge"
			/>
			{caption && <p className="text-[11px] text-muted-foreground/60 font-mono truncate">{caption}</p>}
			{lightboxOpen && <ImageLightbox src={src} alt="Screenshot" onClose={() => setLightboxOpen(false)} />}
		</div>
	);
}

export interface ToolCallPartData {
	id: string;
	toolName: string | null;
	toolInput: string | null;
	toolOutput: string | null;
	toolState: string | null;
	content: string;
	timeStart: string | null;
	timeEnd: string | null;
}

// Tool metadata registry — icon + collapsed summary builder
const TOOL_META: Record<string, { Icon: React.ElementType; summary: (input: Record<string, unknown>) => string }> = {
	// File operations
	read_file: { Icon: FileText, summary: (a) => { const p = shortPath(a.path ?? a.file_path); const ln = a.startLine ? `:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}` : ""; return `read_file ${p}${ln}`; } },
	write_file: { Icon: FileText, summary: (a) => `write_file ${shortPath(a.path ?? a.file_path)}` },
	edit_file: { Icon: Pencil, summary: (a) => `edit_file ${shortPath(a.path ?? a.file_path)}` },
	multi_edit_file: { Icon: Pencil, summary: (a) => `multi_edit_file ${shortPath(a.path ?? a.file_path)}` },
	append_file: { Icon: FileText, summary: (a) => `append_file ${shortPath(a.path ?? a.file_path)}` },
	delete_file: { Icon: Trash2, summary: (a) => `delete_file ${shortPath(a.path ?? a.file_path)}` },
	move_file: { Icon: FileText, summary: (a) => `move_file ${shortPath(a.source)} → ${shortPath(a.destination)}` },
	copy_file: { Icon: CopyIcon, summary: (a) => `copy_file ${shortPath(a.source)}` },
	patch_file: { Icon: Pencil, summary: (a) => `patch_file ${shortPath(a.path ?? a.file_path)}` },
	file_info: { Icon: FileText, summary: (a) => `file_info ${shortPath(a.path)}` },
	diff_text: { Icon: GitCompare, summary: () => "diff_text" },
	find_dead_code: { Icon: Search, summary: (a) => `find_dead_code ${shortPath(a.directory)}` },
	is_binary: { Icon: FileText, summary: (a) => `is_binary ${shortPath(a.path)}` },
	download_file: { Icon: Globe, summary: (a) => `download_file ${truncate(String(a.url ?? ""), 50)}` },
	checksum: { Icon: FileText, summary: (a) => `checksum ${shortPath(a.path)}` },
	batch_rename: { Icon: Pencil, summary: () => "batch_rename" },
	archive: { Icon: FileText, summary: (a) => `archive ${shortPath(a.output_path)}` },

	// Directory operations
	list_directory: { Icon: FolderOpen, summary: (a) => `list_directory ${shortPath(a.directory ?? a.path) || ""}`.trimEnd() },
	directory_tree: { Icon: FolderTree, summary: (a) => `directory_tree ${shortPath(a.path) || ""}`.trimEnd() },
	search_files: { Icon: Search, summary: (a) => `search_files ${truncate(String(a.pattern ?? ""), 50)}` },
	search_content: { Icon: Search, summary: (a) => `search_content ${truncate(String(a.query ?? a.pattern ?? ""), 50)}` },
	create_directory: { Icon: FolderOpen, summary: (a) => `create_directory ${shortPath(a.path)}` },

	// Shell
	run_shell: { Icon: Play, summary: (a) => `run_shell ${truncate(String(a.command ?? ""), 80)}` },

	// Git
	git_status: { Icon: GitBranch, summary: () => "git_status" },
	git_diff: { Icon: GitCompare, summary: () => "git_diff" },
	git_commit: { Icon: GitBranch, summary: (a) => `git_commit ${truncate(String(a.message ?? ""), 60)}` },
	git_push: { Icon: GitBranch, summary: () => "git_push" },
	git_pull: { Icon: GitBranch, summary: () => "git_pull" },
	git_fetch: { Icon: GitBranch, summary: () => "git_fetch" },
	git_log: { Icon: GitBranch, summary: () => "git_log" },
	git_branch: { Icon: GitBranch, summary: (a) => `git_branch ${a.name ?? a.action ?? ""}`.trimEnd() },
	git_stash: { Icon: GitBranch, summary: (a) => `git_stash ${a.action ?? ""}`.trimEnd() },
	git_reset: { Icon: GitBranch, summary: () => "git_reset" },
	git_cherry_pick: { Icon: GitBranch, summary: (a) => `git_cherry_pick ${truncate(String(a.commit ?? ""), 12)}` },
	git_pr: { Icon: GitBranch, summary: (a) => `git_pr ${a.action ?? ""}`.trimEnd() },

	// Web
	web_search: { Icon: Globe, summary: (a) => `web_search ${truncate(String(a.query ?? ""), 60)}` },
	enhanced_web_search: { Icon: Globe, summary: (a) => `enhanced_web_search ${truncate(String(a.query ?? ""), 60)}` },
	web_fetch: { Icon: Globe, summary: (a) => `web_fetch ${truncate(String(a.url ?? ""), 60)}` },
	http_request: { Icon: Globe, summary: (a) => `http_request ${a.method ?? "GET"} ${truncate(String(a.url ?? ""), 50)}` },

	// Kanban
	create_task: { Icon: Pencil, summary: (a) => `create_task ${truncate(String(a.title ?? ""), 40)}` },
	move_task: { Icon: FolderOpen, summary: (a) => `move_task → ${a.column ?? ""}` },
	update_task: { Icon: Pencil, summary: (a) => `update_task ${truncate(String(a.title ?? a.id ?? ""), 30)}` },
	get_task: { Icon: FileText, summary: (a) => `get_task ${truncate(String(a.id ?? ""), 12)}` },
	delete_task: { Icon: Trash2, summary: (a) => `delete_task ${truncate(String(a.id ?? ""), 12)}` },
	list_tasks: { Icon: FolderOpen, summary: () => "list_tasks" },
	get_kanban_stats: { Icon: FolderOpen, summary: () => "get_kanban_stats" },
	submit_review: { Icon: Search, summary: (a) => `submit_review ${a.verdict ?? ""}`.trimEnd() },
	verify_implementation: { Icon: Search, summary: () => "verify_implementation" },

	// Notes / docs
	list_docs: { Icon: FileText, summary: () => "list_docs" },
	get_doc: { Icon: FileText, summary: (a) => `get_doc ${truncate(String(a.id ?? a.title ?? ""), 30)}` },
	create_doc: { Icon: Pencil, summary: (a) => `create_doc ${truncate(String(a.title ?? ""), 30)}` },
	update_doc: { Icon: Pencil, summary: (a) => `update_doc ${truncate(String(a.title ?? a.id ?? ""), 30)}` },
	create_note: { Icon: Pencil, summary: (a) => `create_note ${truncate(String(a.title ?? ""), 30)}` },
	update_note: { Icon: Pencil, summary: (a) => `update_note ${truncate(String(a.title ?? a.id ?? ""), 30)}` },

	// System
	environment_info: { Icon: Cpu, summary: () => "environment_info" },
	sleep: { Icon: Cpu, summary: (a) => `sleep ${a.seconds ?? a.ms ?? ""}s` },
	run_background: { Icon: Play, summary: (a) => `run_background ${truncate(String(a.command ?? ""), 50)}` },
	check_process: { Icon: Play, summary: (a) => `check_process ${a.pid ?? ""}`.trimEnd() },
	kill_process: { Icon: Play, summary: (a) => `kill_process ${a.pid ?? ""}`.trimEnd() },

	// Agent
	run_agent: { Icon: Wrench, summary: (a) => `run_agent ${a.agent ?? ""}`.trimEnd() },
	run_agents_parallel: { Icon: Wrench, summary: (a) => `run_agents_parallel ${Array.isArray(a.tasks) ? `(${a.tasks.length})` : ""}`.trimEnd() },
	request_human_input: { Icon: Wrench, summary: () => "request_human_input" },
	get_agent_status: { Icon: Wrench, summary: () => "get_agent_status" },
	define_tasks: { Icon: Pencil, summary: (a) => `define_tasks ${Array.isArray(a.tasks) ? `(${a.tasks.length})` : ""}`.trimEnd() },
};

function shortPath(p: unknown): string {
	if (typeof p !== "string") return "";
	const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.length <= 3 ? parts.join("/") : `.../${parts.slice(-2).join("/")}`;
}

function truncate(s: string, maxLen: number): string {
	return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}

function parseInput(toolInput: string | null): Record<string, unknown> {
	if (!toolInput) return {};
	try { return JSON.parse(toolInput); } catch { return {}; }
}

function StateIcon({ state }: { state: string | null }) {
	switch (state) {
		case "pending":
		case "running":
			return <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />;
		case "success":
			return <Check className="w-3.5 h-3.5 text-emerald-500" />;
		case "error":
			return <X className="w-3.5 h-3.5 text-red-500" />;
		default:
			return <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground/60" />;
	}
}

const IMAGE_TOOL_NAMES = new Set(["take_screenshot", "read_image"]);
function isImageTool(name: string) {
	return IMAGE_TOOL_NAMES.has(name) || name.includes("screenshot");
}

export const ToolCallCard = memo(function ToolCallCard({ part }: { part: ToolCallPartData }) {
	const toolName = part.toolName ?? "unknown";
	// Auto-expand image tools so the screenshot is visible without clicking
	const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
	const expanded = userExpanded ?? (isImageTool(toolName) && part.toolState === "success");
	const cardRef = useRef<HTMLDivElement>(null);
	const meta = TOOL_META[toolName];
	const Icon = meta?.Icon ?? Wrench;
	const input = parseInput(part.toolInput);
	const summary = meta?.summary(input) ?? toolName;

	const isError = part.toolState === "error";
	const isDone = part.toolState === "success" || part.toolState === "error";

	const toggle = useCallback(() => {
		setUserExpanded((prev) => !(prev ?? (isImageTool(toolName) && part.toolState === "success")));
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		});
	}, [toolName, part.toolState]);

	return (
		<div ref={cardRef} className={cn(
			"rounded-lg border text-xs my-1",
			isError ? "border-red-200 bg-red-50/60" : "border-border bg-muted/60",
		)}>
			<button
				className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left hover:bg-muted/50 rounded-lg transition-colors"
				onClick={toggle}
				aria-expanded={expanded}
			>
				{expanded ? (
					<ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" strokeWidth={3} />
				) : (
					<ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" strokeWidth={3} />
				)}
				<Icon className="w-3.5 h-3.5 text-blue-500 shrink-0" />
				<span className="truncate flex-1">
					{(() => {
						const spaceIdx = summary.indexOf(" ");
						if (spaceIdx < 0) return <span className="font-semibold text-blue-600">{summary}</span>;
						return <><span className="font-semibold text-blue-600">{summary.slice(0, spaceIdx)}</span><span className="font-bold text-muted-foreground"> {summary.slice(spaceIdx + 1)}</span></>;
					})()}
				</span>
				<StateIcon state={part.toolState} />
				{isDone && part.timeStart && part.timeEnd && (
					<span className="text-muted-foreground tabular-nums font-semibold ml-1">
						{formatDuration(part.timeStart, part.timeEnd)}
					</span>
				)}
			</button>

			{expanded && (
				<div className="px-2.5 pb-2 space-y-1.5 border-t border-border/60">
					{part.toolInput && (
						<div className="mt-1.5">
							<div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-0.5">Input</div>
							<ToolInputDisplay toolName={toolName} rawInput={part.toolInput} />
						</div>
					)}
					{part.toolOutput && (
						<div>
							<div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-0.5">Output</div>
							<ToolOutputDisplay toolName={toolName} rawOutput={part.toolOutput} rawInput={part.toolInput} isError={isError} />
						</div>
					)}
				</div>
			)}
		</div>
	);
});

// ---------------------------------------------------------------------------
// Smart input display — syntax highlight write_file content, pretty-print JSON
// ---------------------------------------------------------------------------

function ToolInputDisplay({ toolName, rawInput }: { toolName: string; rawInput: string }) {
	const parsed = parseInput(rawInput);

	// write_file / append_file: show content with syntax highlighting + file type header + line count
	if ((toolName === "write_file" || toolName === "append_file") && typeof parsed.content === "string") {
		const filePath = String(parsed.path ?? parsed.file_path ?? "");
		const lang = extToLang(filePath);
		const lineCount = (parsed.content as string).split("\n").length;
		const { content: _content, ...rest } = parsed;
		return (
			<div className="space-y-1">
				{Object.keys(rest).length > 0 && (
					<pre className="text-[11px] text-muted-foreground bg-background rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-32 overflow-y-auto border border-border/50">
						{JSON.stringify(rest, null, 2)}
					</pre>
				)}
				<Suspense fallback={<pre className="text-[11px] bg-gray-900 text-gray-300 rounded px-2 py-1.5 max-h-48 overflow-y-auto">{truncate(parsed.content as string, 3000)}</pre>}>
					<LazyCodeBlock language={lang} code={truncate(parsed.content as string, 5000)} maxHeight={240} lineCount={lineCount} />
				</Suspense>
			</div>
		);
	}

	// edit_file: unified diff view (handles both old_string/new_string and old_text/new_text param names)
	if (toolName === "edit_file") {
		const oldStr = parsed.old_string ?? parsed.old_text;
		const newStr = parsed.new_string ?? parsed.new_text;
		if (oldStr != null && newStr != null) {
			const filePath = String(parsed.path ?? parsed.file_path ?? "");
			return (
				<UnifiedDiffCard
					oldStr={String(oldStr)}
					newStr={String(newStr)}
					filePath={filePath}
				/>
			);
		}
	}

	// multi_edit_file: show each edit as a diff
	if (toolName === "multi_edit_file" && Array.isArray(parsed.edits)) {
		const filePath = String(parsed.path ?? parsed.file_path ?? "");
		return (
			<div className="space-y-1.5">
				{(parsed.edits as Array<Record<string, unknown>>).map((edit, i) => (
					<UnifiedDiffCard
						key={i}
						oldStr={String(edit.old_string ?? edit.old_text ?? "")}
						newStr={String(edit.new_string ?? edit.new_text ?? "")}
						filePath={filePath}
						editIndex={i + 1}
						editTotal={(parsed.edits as unknown[]).length}
					/>
				))}
			</div>
		);
	}

	// patch_file: show patch content as diff-highlighted text
	if (toolName === "patch_file" && typeof parsed.patch === "string") {
		return <PatchDiffCard patch={parsed.patch} filePath={String(parsed.path ?? parsed.file_path ?? "")} />;
	}

	// run_shell: show command in terminal style
	if (toolName === "run_shell" && typeof parsed.command === "string") {
		return (
			<pre className="text-[11px] bg-gray-900 text-green-400 font-mono rounded px-2.5 py-1.5 whitespace-pre break-words overflow-x-auto border border-gray-700"><span className="text-gray-500 select-none">$ </span>{parsed.command}</pre>
		);
	}

	// Default: pretty-print JSON
	return (
		<pre className="text-[11px] text-muted-foreground bg-background rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-48 overflow-y-auto border border-border/50">{formatJson(rawInput)}</pre>
	);
}

// ---------------------------------------------------------------------------
// Smart output display — terminal for shell, syntax highlight for file reads
// ---------------------------------------------------------------------------

function ToolOutputDisplay({ toolName, rawOutput, rawInput, isError }: { toolName: string; rawOutput: string; rawInput?: string | null; isError: boolean }) {
	const display = rawOutput.length > 5000 ? rawOutput.slice(0, 5000) + "\n... (truncated)" : rawOutput;
	const input = parseInput(rawInput ?? null);

	// read_file: syntax-highlighted code block with file type + line count
	if (toolName === "read_file" && !isError && display.length > 20) {
		const filePath = String(input.path ?? input.file_path ?? "");
		const lang = extToLang(filePath);
		const lineCount = display.split("\n").length;
		return (
			<Suspense fallback={<pre className="text-[11px] bg-gray-900 text-gray-300 rounded px-2 py-1.5 max-h-64 overflow-y-auto">{display.slice(0, 3000)}</pre>}>
				<LazyCodeBlock language={lang} code={display} maxHeight={256} lineCount={lineCount} />
			</Suspense>
		);
	}

	// Shell commands: terminal-style output — extract stdout/stderr from JSON envelope
	if (toolName === "run_shell") {
		const { text: shellText, exitCode } = extractShellOutput(display);
		return (
			<div className="w-full rounded-lg overflow-hidden border border-gray-700">
				<div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 border-b border-gray-700">
					<span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
					<span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
					<span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
					<span className="text-[10px] text-gray-500 ml-1.5 font-mono">terminal</span>
					{exitCode != null && (
						<span className={cn("text-[10px] ml-auto font-mono font-semibold", exitCode === 0 ? "text-green-400" : "text-red-400")}>exit {exitCode}</span>
					)}
				</div>
				<pre
				className="text-[11px] bg-gray-900 text-gray-100 font-mono px-3 py-2 whitespace-pre-wrap break-words max-h-64 overflow-auto leading-[1.6]"
				dangerouslySetInnerHTML={{ __html: ansiToHtml(shellText) }}
			/>
			</div>
		);
	}

	// Image tools: render inline image for screenshot and read_image tools.
	// Handles two formats:
	//   1. MCP content envelope: {"content":[{"type":"image","data":"base64...","mimeType":"..."}]}
	//   2. Built-in tool format: {"success":true,"image":{"type":"image","mimeType":"...","base64":"..."},"url":"...","path":"..."}
	if (!isError && (toolName.includes("take_screenshot") || toolName.includes("screenshot") || toolName === "read_image")) {
		try {
			const parsed = JSON.parse(rawOutput) as {
				content?: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
				image?: { type?: string; mimeType?: string; base64?: string };
				url?: string;
				path?: string;
			};

			// Format 1: MCP content envelope (chrome-devtools MCP server)
			const mcpImageItem = parsed.content?.find((c) => c.type === "image" && c.data);
			if (mcpImageItem?.data) {
				const mime = mcpImageItem.mimeType ?? "image/jpeg";
				const caption = parsed.content?.find((c) => c.type === "text")?.text;
				return <InlineImage src={`data:${mime};base64,${mcpImageItem.data}`} caption={caption} />;
			}

			// Format 2: built-in tool format (take_screenshot / read_image)
			if (parsed.image?.base64) {
				const mime = parsed.image.mimeType ?? "image/jpeg";
				const caption = parsed.url ?? parsed.path;
				return <InlineImage src={`data:${mime};base64,${parsed.image.base64}`} caption={caption} />;
			}
		} catch { /* fall through to default */ }
	}

	// Error output
	if (isError) {
		return (
			<pre className="text-[11px] bg-red-50 text-red-700 rounded px-2 py-1.5 whitespace-pre-wrap break-words max-h-64 overflow-y-auto border border-red-100">{display}</pre>
		);
	}

	// Try to pretty-print JSON output
	const jsonFormatted = tryFormatJson(display);
	if (jsonFormatted) {
		return (
			<pre className="text-[11px] text-muted-foreground bg-background rounded px-2 py-1.5 whitespace-pre-wrap break-words max-h-64 overflow-y-auto border border-border/50">{jsonFormatted}</pre>
		);
	}

	// Default output
	return (
		<pre className="text-[11px] text-muted-foreground bg-background rounded px-2 py-1.5 whitespace-pre-wrap break-words max-h-64 overflow-y-auto border border-border/50">{display}</pre>
	);
}


function PatchDiffCard({ patch, filePath }: { patch: string; filePath?: string }) {
	const patchLines = patch.split("\n");
	let additions = 0;
	let deletions = 0;
	for (const line of patchLines) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) deletions++;
	}

	return (
		<div className="rounded-lg overflow-hidden border border-border">
			<div className="flex items-center justify-between px-2.5 py-1 bg-muted border-b border-border">
				<span className="text-[10px] font-medium text-muted-foreground truncate">
					{filePath ? shortPath(filePath) : "patch"}
				</span>
				<div className="flex items-center gap-2 text-[10px] font-mono shrink-0">
					{additions > 0 && <span className="text-blue-600">+{additions}</span>}
					{deletions > 0 && <span className="text-red-600">-{deletions}</span>}
				</div>
			</div>
			<div className="max-h-60 overflow-y-auto text-[11px] font-mono leading-relaxed">
				{patchLines.map((line, idx) => (
					<div
						key={idx}
						className={cn(
							"px-2.5 whitespace-pre-wrap break-all",
							line.startsWith("+") && !line.startsWith("+++") && "bg-emerald-50 text-emerald-800",
							line.startsWith("-") && !line.startsWith("---") && "bg-red-50 text-red-800",
							line.startsWith("@@") && "bg-blue-50 text-blue-600 font-semibold",
							!line.startsWith("+") && !line.startsWith("-") && !line.startsWith("@@") && "text-muted-foreground",
						)}
					>
						{line || " "}
					</div>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

// Map file extension to shiki language id
function extToLang(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
		py: "python", rs: "rust", go: "go", rb: "ruby",
		java: "java", kt: "kotlin", swift: "swift", c: "c", cpp: "cpp",
		cs: "csharp", php: "php", html: "html", css: "css", scss: "scss",
		json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
		md: "markdown", sql: "sql", sh: "bash", bash: "bash",
		xml: "xml", svg: "xml", vue: "vue", svelte: "svelte",
	};
	if (map[ext]) return map[ext];
	return detectLanguageFromContent(filePath);
}

/** Heuristic language detection from content when extension is unknown */
function detectLanguageFromContent(content: string): string {
	const s = content.slice(0, 1000);
	if (/^#!\s*\/.*\b(bash|sh)\b/.test(s)) return "bash";
	if (/^#!\s*\/.*\bpython/.test(s)) return "python";
	if (/^#!\s*\/.*\bnode/.test(s)) return "javascript";
	if (/^\s*<(!DOCTYPE\s+)?html/i.test(s)) return "html";
	if (/^\s*<\?xml/i.test(s)) return "xml";
	if (/^\s*\{[\s\n]*"/.test(s)) return "json";
	if (/^---\n/.test(s)) return "yaml";
	if (/^\s*import\s+.*\bfrom\b/.test(s)) return "typescript";
	if (/^\s*from\s+\w+\s+import\b/.test(s)) return "python";
	if (/^\s*def\s+\w+|^\s*class\s+\w+.*:$/m.test(s)) return "python";
	if (/^\s*(const|let|var|function|export|import)\b/.test(s)) return "javascript";
	if (/^\s*package\s+\w+/.test(s)) return "go";
	if (/^\s*use\s+\w+::|^\s*fn\s+\w+|^\s*pub\s+(fn|struct|enum)\b/.test(s)) return "rust";
	if (/^\s*#include\s*[<"]/.test(s)) return "cpp";
	if (/^\s*SELECT\s|^\s*CREATE\s+(TABLE|INDEX|VIEW)\b/i.test(s)) return "sql";
	return "plaintext";
}

function formatDuration(start: string, end: string): string {
	const ms = new Date(end).getTime() - new Date(start).getTime();
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatJson(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

/** Normalize whitespace in terminal output (replace tab chars with spaces) */
function unescapeTerminal(s: string): string {
	return s.replace(/\t/g, "  ");
}

/** Convert ANSI color codes to HTML spans */
function ansiToHtml(s: string): string {
	const COLORS: Record<string, string> = {
		"30": "#4a4a4a", "31": "#e55561", "32": "#8cc265", "33": "#d18f52",
		"34": "#4d9de0", "35": "#c162de", "36": "#42b3c2", "37": "#d4d4d4",
		"90": "#6a6a6a", "91": "#ff6b6b", "92": "#98e024", "93": "#e0d561",
		"94": "#6bb3ff", "95": "#d68fd6", "96": "#61dafb", "97": "#ffffff",
	};
	let html = s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	// Replace ANSI codes: \x1b[Nm or \x1b[N;Nm
	// eslint-disable-next-line no-control-regex
	html = html.replace(/\x1b\[([0-9;]+)m/g, (_match, codes: string) => {
		const parts = codes.split(";");
		for (const code of parts) {
			if (code === "0" || code === "39") return "</span>";
			if (code === "1") return '<span style="font-weight:bold">';
			if (code === "2") return '<span style="opacity:0.7">';
			if (COLORS[code]) return `<span style="color:${COLORS[code]}">`;
		}
		return "";
	});
	// Also handle escaped versions that come through JSON: \\x1b or \\u001b or literal \e[
	html = html.replace(/(?:\\x1b|\\u001b|\\e)\[([0-9;]+)m/g, (_match, codes: string) => {
		const parts = codes.split(";");
		for (const code of parts) {
			if (code === "0" || code === "39") return "</span>";
			if (code === "1") return '<span style="font-weight:bold">';
			if (COLORS[code]) return `<span style="color:${COLORS[code]}">`;
		}
		return "";
	});
	return html;
}

/** Extract stdout/stderr from shell tool JSON output, or return raw text */
function extractShellOutput(raw: string): { text: string; exitCode?: number } {
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && ("stdout" in parsed || "stderr" in parsed)) {
			const stdout = typeof parsed.stdout === "string" ? parsed.stdout : "";
			const stderr = typeof parsed.stderr === "string" ? parsed.stderr : "";
			const combined = stderr ? (stdout ? stdout + "\n" + stderr : stderr) : stdout;
			return { text: unescapeTerminal(combined || "(no output)"), exitCode: parsed.exitCode };
		}
	} catch { /* not JSON, use raw */ }
	return { text: unescapeTerminal(raw) };
}

/** Try to parse and pretty-print JSON. Returns formatted string or null if not valid JSON. */
function tryFormatJson(raw: string): string | null {
	const trimmed = raw.trim();
	// Quick check: must start with { or [ to be JSON
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
	try {
		const parsed = JSON.parse(trimmed);
		const formatted = JSON.stringify(parsed, null, 2);
		// Only format if it actually changes something (avoid reformatting already-pretty JSON)
		if (formatted === trimmed) return null;
		return formatted;
	} catch {
		return null;
	}
}
