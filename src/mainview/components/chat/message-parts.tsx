/* eslint-disable react-refresh/only-export-components */
import { memo, useState, useMemo, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { MermaidDiagram } from "@/components/ui/mermaid-diagram";
import {
	ChevronDown,
	ChevronRight,
	Brain,
	FileText,
	Cpu,
	Square as StopIcon,
	RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCallCard, type ToolCallPartData } from "./tool-call-card";
import { rpc } from "@/lib/rpc";
import { useChatStore } from "@/stores/chat-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessagePartData {
	id: string;
	messageId: string;
	type: string; // 'text' | 'tool_call' | 'tool_result' | 'reasoning' | 'agent_start' | 'agent_end'
	content: string;
	toolName: string | null;
	toolInput: string | null;
	toolOutput: string | null;
	toolState: string | null;
	sortOrder: number;
	timeStart: string | null;
	timeEnd: string | null;
	createdAt: string;
	agentName?: string;
}

// Agent colors — deterministic from name
const AGENT_COLORS: Record<string, string> = {
	"backend-engineer": "border-l-blue-400",
	"frontend_engineer": "border-l-purple-400",
	"software-architect": "border-l-indigo-400",
	"code-reviewer": "border-l-pink-400",
	"qa-engineer": "border-l-teal-400",
	"task-planner": "border-l-amber-400",
	"debugging-specialist": "border-l-red-400",
	"performance-expert": "border-l-orange-400",
	"security-expert": "border-l-rose-400",
	"documentation-expert": "border-l-green-400",
	"devops-engineer": "border-l-cyan-400",
	"ui-ux-designer": "border-l-violet-400",
	"data-engineer": "border-l-lime-400",
	"refactoring-specialist": "border-l-yellow-400",
	"code-explorer": "border-l-sky-400",
	"playground-agent": "border-l-orange-400",
	"issue-fixer": "border-l-red-500",
};

function getAgentBorderColor(agentName?: string): string {
	if (!agentName) return "border-l-gray-300";
	return AGENT_COLORS[agentName] ?? "border-l-gray-400";
}

function formatAgentDisplayName(name: string): string {
	// Handle #N suffix: frontend_engineer#2 → Frontend Engineer 2
	const [base, suffix] = name.split("#");
	const display = base
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
	return suffix ? `${display} ${suffix}` : display;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Shared thinking/reasoning block used by sub-agents, live PM streaming, and persisted PM reasoning.
 * - `label`: button text (e.g. "Thinking...", "Thought for a moment")
 * - `defaultExpanded`: initial expand state
 * - `pulse`: animate the Brain icon (for live streaming)
 */
export const ThinkingBlock = memo(function ThinkingBlock({
	content,
	label = "Thinking...",
	defaultExpanded = false,
	pulse = false,
}: {
	content: string;
	label?: string;
	defaultExpanded?: boolean;
	pulse?: boolean;
}) {
	const [expanded, setExpanded] = useState(defaultExpanded);

	return (
		<div>
			<button
				className="flex items-center gap-1.5 text-xs text-foreground/80 hover:text-foreground transition-colors leading-none"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
			>
				{expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
				<Brain className={cn("w-3 h-3", pulse && "animate-pulse")} />
				<span className="italic">{label}</span>
			</button>
			{expanded && (
				<div className="mt-2.5 pl-5 text-sm text-foreground italic leading-relaxed whitespace-pre-wrap">
					{content}
				</div>
			)}
		</div>
	);
});

/** Ticking elapsed time display (e.g. "1m 23s"). Updates every second. */
function ElapsedTimer({ since }: { since: string }) {
	const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000)));
	useEffect(() => {
		const id = setInterval(() => {
			setElapsed(Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000)));
		}, 1000);
		return () => clearInterval(id);
	}, [since]);
	const m = Math.floor(elapsed / 60);
	const s = elapsed % 60;
	return <span>{m > 0 ? `${m}m ${s}s` : `${s}s`}</span>;
}

// Badge color mapping for agent name pills
export const AGENT_BADGE_COLORS: Record<string, string> = {
	"backend-engineer": "bg-blue-50 text-blue-700 ring-blue-300",
	"frontend_engineer": "bg-purple-50 text-purple-700 ring-purple-300",
	"software-architect": "bg-indigo-50 text-indigo-700 ring-indigo-300",
	"code-reviewer": "bg-pink-50 text-pink-700 ring-pink-300",
	"qa-engineer": "bg-teal-50 text-teal-700 ring-teal-300",
	"task-planner": "bg-amber-50 text-amber-700 ring-amber-300",
	"debugging-specialist": "bg-red-50 text-red-700 ring-red-300",
	"performance-expert": "bg-orange-50 text-orange-700 ring-orange-300",
	"security-expert": "bg-rose-50 text-rose-700 ring-rose-300",
	"documentation-expert": "bg-green-50 text-green-700 ring-green-300",
	"devops-engineer": "bg-cyan-50 text-cyan-700 ring-cyan-300",
	"ui-ux-designer": "bg-violet-50 text-violet-700 ring-violet-300",
	"data-engineer": "bg-lime-50 text-lime-700 ring-lime-300",
	"refactoring-specialist": "bg-yellow-50 text-yellow-700 ring-yellow-300",
	"code-explorer": "bg-sky-50 text-sky-700 ring-sky-300",
	"playground-agent": "bg-orange-50 text-orange-700 ring-orange-300",
	"issue-fixer": "bg-red-50 text-red-700 ring-red-300",
};

export function getAgentBadgeColor(agentName?: string): string {
	if (!agentName) return "bg-muted text-muted-foreground ring-border";
	const [base] = agentName.split("#");
	return AGENT_BADGE_COLORS[base] ?? "bg-muted text-muted-foreground ring-border";
}

/** Collapsible task prompt sub-card — collapsed by default. */
function TaskPromptCard({ task }: { task: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="mx-2.5 mt-2 mb-1">
			<button
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1 text-[11px] text-foreground hover:text-foreground font-semibold transition-colors"
			>
				<ChevronRight className={cn("w-3 h-3 transition-transform", open && "rotate-90")} />
				Task prompt
			</button>
			{open && (
				<div className="mt-1 px-3 py-2 bg-background/80 border border-border rounded-md">
					<pre className="text-xs text-foreground leading-relaxed break-words whitespace-pre-wrap font-sans">{task}</pre>
				</div>
			)}
		</div>
	);
}

const AgentStartBlock = memo(function AgentStartBlock({
	agentName,
	task,
	timeStart,
	timeEnd,
	isRunning,
	onStop,
	collapsed,
	onToggle,
}: {
	agentName: string;
	task: string;
	timeStart: string | null;
	timeEnd?: string | null;
	isRunning?: boolean;
	onStop?: () => void;
	collapsed?: boolean;
	onToggle?: () => void;
}) {
	const displayName = formatAgentDisplayName(agentName);
	const badgeColor = getAgentBadgeColor(agentName);

	return (
		<div className="bg-muted/50 rounded-t-lg pb-1">
			{/* Header: agent badge + status + controls */}
			<div className="flex items-center gap-2 py-1.5 px-2.5">
				{/* Collapse/expand toggle — only when agent is not running */}
				{!isRunning ? (
					<button
						onClick={onToggle}
						className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
						aria-label={collapsed ? "Expand agent card" : "Collapse agent card"}
						aria-expanded={!collapsed}
					>
						{collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
					</button>
				) : (
					<div className="w-5 shrink-0" /> /* Spacer to keep layout aligned */
				)}
				<Cpu className={cn("w-3.5 h-3.5 shrink-0", isRunning ? "text-indigo-500 animate-pulse" : "text-muted-foreground")} />
				<span className={cn("text-[13px] font-semibold px-2 py-0.5 rounded-md ring-1 ring-inset", badgeColor)}>
					{displayName}
				</span>
					<span className="flex-1" />
				{isRunning && onStop && (
					<button
						onClick={onStop}
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-red-600 bg-red-50 hover:bg-red-100 transition-colors shrink-0"
						aria-label={`Stop ${displayName}`}
					>
						<StopIcon className="w-2.5 h-2.5 fill-red-500 stroke-red-500" />
						Stop{timeStart && <> (<ElapsedTimer since={timeStart} />)</>}
					</button>
				)}
				{timeStart && !isRunning && (
					<span className="text-[11px] text-muted-foreground font-bold flex items-center gap-1 shrink-0">
						{new Date(timeStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
						{timeEnd && (() => {
							const ms = new Date(timeEnd).getTime() - new Date(timeStart).getTime();
							const secs = Math.round(ms / 1000);
							const dur = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
							return <span className="ml-1">({dur})</span>;
						})()}
					</span>
				)}
			</div>
			<hr className="border-t border-border" />
			{/* Task prompt — collapsible sub-card with preserved whitespace */}
			{task && <TaskPromptCard task={task} />}
		</div>
	);
});

const AgentEndBlock = memo(function AgentEndBlock({
	content,
	toolState,
	timeEnd,
	onRetry,
}: {
	content: string;
	toolState: string | null;
	timeEnd: string | null;
	onRetry?: () => Promise<void>;
}) {
	const isError = toolState === "error";
	const [expanded, setExpanded] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const isLong = content.length > 300;
	const blockRef = useRef<HTMLDivElement>(null);

	const toggle = useCallback(() => {
		setExpanded((v) => !v);
		// Double rAF: first lets React commit the DOM update, second scrolls to correct position
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				blockRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		});
	}, []);

	return (
		<div ref={blockRef} className={cn(
			"py-2 px-2.5 rounded-b-lg text-xs",
			isError ? "bg-red-50/60 dark:bg-red-950/40" : "bg-emerald-50/60 dark:bg-emerald-950/40",
		)}>
			<div className="flex items-center gap-1.5 mb-1">
				<FileText className={cn("w-3 h-3 shrink-0", isError ? "text-red-500" : "text-emerald-500")} />
				<span className={cn("text-[10px] font-semibold uppercase tracking-wide", isError ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>
					{isError ? "Failed" : "Completed"}
				</span>
				<span className="flex-1" />
				{timeEnd && (
					<span className="text-[11px] text-foreground font-semibold shrink-0">
						{new Date(timeEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
					</span>
				)}
			</div>
			{content && (
				<div
					className={cn(isLong && "cursor-pointer")}
					onClick={isLong ? toggle : undefined}
				>
					<div className={cn(
						"text-xs leading-relaxed break-words whitespace-pre-wrap",
						isError ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300",
						!expanded && isLong && "line-clamp-4",
					)}>
						{content}
					</div>
					{isLong && (
						<span className={cn("text-[10px] font-medium mt-1 inline-block", isError ? "text-red-500" : "text-emerald-500")}>
							{expanded ? "Show less" : "Show more"}
						</span>
					)}
				</div>
			)}
			{isError && onRetry && (
				<div className="mt-2 pt-2 border-t border-red-200/60 dark:border-red-800/40">
					<button
						onClick={async () => {
							setRetrying(true);
							try { await onRetry(); } finally { setRetrying(false); }
						}}
						disabled={retrying}
						className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium text-red-700 dark:text-red-300 bg-red-100/70 dark:bg-red-900/30 hover:bg-red-200/70 dark:hover:bg-red-800/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						<RefreshCw className={cn("w-3 h-3", retrying && "animate-spin")} />
						{retrying ? "Retrying…" : "Retry"}
					</button>
				</div>
			)}
		</div>
	);
});

export const TextBlock = memo(function TextBlock({ content }: { content: string }) {
	const mdComponents = useMemo(() => ({
		p: ({ children }: { children: React.ReactNode }) => (
			<p className="text-sm text-foreground italic leading-relaxed mb-1.5 last:mb-0">{children}</p>
		),
		code: ({ className, children }: { className?: string; children: React.ReactNode }) => {
			const match = /language-(\w+)/.exec(className ?? "");
			if (match?.[1] === "mermaid") {
				return <MermaidDiagram code={String(children).trim()} />;
			}
			if (className) {
				return (
					<pre className="text-xs bg-gray-900 text-gray-100 rounded-lg px-3 py-2 my-2 overflow-x-auto">
						<code>{children}</code>
					</pre>
				); // bg-gray-900: intentional dark surface for code blocks
			}
			return <code className="text-xs text-rose-600 dark:text-orange-300 font-mono">{children}</code>;
		},
		ul: ({ children }: { children: React.ReactNode }) => (
			<ul className="text-sm text-foreground list-disc pl-5 space-y-0.5 mb-1.5">{children}</ul>
		),
		ol: ({ children }: { children: React.ReactNode }) => (
			<ol className="text-sm text-foreground list-decimal pl-5 space-y-0.5 mb-1.5">{children}</ol>
		),
		li: ({ children }: { children: React.ReactNode }) => (
			<li className="text-sm text-foreground leading-relaxed">{children}</li>
		),
		h1: ({ children }: { children: React.ReactNode }) => (
			<h1 className="text-xl font-semibold text-foreground mt-3 mb-1.5">{children}</h1>
		),
		h2: ({ children }: { children: React.ReactNode }) => (
			<h2 className="text-lg font-semibold text-foreground mt-2.5 mb-1">{children}</h2>
		),
		h3: ({ children }: { children: React.ReactNode }) => (
			<h3 className="text-base font-semibold text-foreground mt-2 mb-1">{children}</h3>
		),
		strong: ({ children }: { children: React.ReactNode }) => (
			<strong className="font-semibold text-foreground">{children}</strong>
		),
		blockquote: ({ children }: { children: React.ReactNode }) => (
			<blockquote className="border-l-2 border-border pl-3 italic text-muted-foreground mb-1.5">{children}</blockquote>
		),
		a: ({ href, children }: { href?: string; children: React.ReactNode }) => (
			<a
				href={href}
				className="text-blue-800 hover:text-blue-600 font-semibold underline cursor-pointer"
				onClick={(e) => {
					e.preventDefault();
					if (href) rpc.openExternalUrl(href).catch(() => {});
				}}
			>
				{children}
			</a>
		),
		hr: () => <hr className="my-3 border-t border-border" />,
		table: ({ children }: { children: React.ReactNode }) => <div className="my-2 overflow-x-auto rounded-lg border border-border"><table className="min-w-full text-xs">{children}</table></div>,
		thead: ({ children }: { children: React.ReactNode }) => <thead className="bg-muted/50 border-b border-border">{children}</thead>,
		th: ({ children }: { children: React.ReactNode }) => <th className="px-3 py-1.5 text-left font-semibold text-foreground/80">{children}</th>,
		td: ({ children }: { children: React.ReactNode }) => <td className="px-3 py-1.5 text-foreground/80 border-t border-border/50">{children}</td>,
	}), []);

	return (
		<div className="my-1 break-words overflow-hidden">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeSanitize]}
				components={mdComponents as never}
			>
				{content}
			</ReactMarkdown>
		</div>
	);
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface MessagePartsProps {
	parts: MessagePartData[];
	onStopAgent?: (agentName: string) => void;
	/** Whether any agent is currently running. Used to distinguish "missing end part" (crashed/old session) from "actively running". */
	hasRunningAgents?: boolean;
	onRetryAgent?: (agentName: string, task: string) => Promise<void>;
}

/**
 * Renders an array of message parts for inline agent execution.
 * Groups parts between agent_start/agent_end into indented agent blocks.
 */
export const MessageParts = memo(function MessageParts({ parts, onStopAgent, hasRunningAgents, onRetryAgent }: MessagePartsProps) {
	// Hooks must run unconditionally on every render — keep them above any early return.
	// Track which agent blocks are collapsed (by their start part id) — persisted in Zustand so it survives tab switches
	const collapsedAgentBlocks = useChatStore((s) => s.collapsedAgentBlocks);
	const toggleCollapsedAgent = useChatStore((s) => s.toggleCollapsedAgent);

	if (!parts || parts.length === 0) return null;

	const sorted = [...parts].sort((a, b) => a.sortOrder - b.sortOrder);

	// Group into segments: agent blocks (start → end) and consecutive runs of
	// the PM's own top-level parts (grouped so they render as one bordered card,
	// same shape as an agent block).
	const segments: Array<
		| { type: "agent_block"; agentName: string; start: MessagePartData; end?: MessagePartData; children: MessagePartData[] }
		| { type: "pm_group"; parts: MessagePartData[] }
	> = [];

	let currentBlock: { agentName: string; start: MessagePartData; children: MessagePartData[] } | null = null;
	let pmGroup: MessagePartData[] = [];

	const flushPmGroup = () => {
		if (pmGroup.length > 0) {
			segments.push({ type: "pm_group", parts: pmGroup });
			pmGroup = [];
		}
	};

	for (const part of sorted) {
		if (part.type === "agent_start") {
			flushPmGroup();
			// Close any open block
			if (currentBlock) {
				segments.push({ type: "agent_block", ...currentBlock, end: undefined });
			}
			currentBlock = { agentName: part.content, start: part, children: [] };
		} else if (part.type === "agent_end") {
			if (currentBlock) {
				segments.push({ type: "agent_block", ...currentBlock, end: part });
				currentBlock = null;
			} else {
				pmGroup.push(part);
			}
		} else if (currentBlock) {
			currentBlock.children.push(part);
		} else {
			pmGroup.push(part);
		}
	}
	// Close any trailing open block
	if (currentBlock) {
		segments.push({ type: "agent_block", ...currentBlock, end: undefined });
	}
	flushPmGroup();

	return (
		<div className="space-y-0.5">
			{segments.map((seg) => {
				if (seg.type === "agent_block") {
					const borderColor = getAgentBorderColor(seg.start.agentName ?? seg.agentName);
					const agentRunning = !seg.end && !!hasRunningAgents;
					const rawName = seg.start.agentName ?? seg.agentName;
					const isCollapsed = !!collapsedAgentBlocks[seg.start.id];
					// Full Streaming: the most-recent text/reasoning child of a still-
					// running agent block is the one currently being live-updated —
					// give it a pulse/cursor treatment. A cheap, message-scoped
					// heuristic (highest sortOrder of that type, block has no
					// agent_end part yet) rather than a dedicated "isLive" field.
					const liveChildId = agentRunning
						? [...seg.children].reverse().find((c) => c.type === "text" || c.type === "reasoning")?.id
						: undefined;
					return (
						<div key={seg.start.id} className={cn("border border-border border-l-[3px] rounded-lg my-2 overflow-hidden", borderColor)}>
							<AgentStartBlock
								agentName={rawName}
								task={seg.start.content}
								timeStart={seg.start.timeStart}
								timeEnd={seg.end?.timeEnd ?? null}
								isRunning={agentRunning}
								onStop={agentRunning && onStopAgent ? () => onStopAgent(rawName) : undefined}
								collapsed={isCollapsed}
								onToggle={() => toggleCollapsedAgent(seg.start.id)}
							/>
							{!isCollapsed && (
								<>
									<div className="pl-3 pr-2 py-1 overflow-hidden">
										{seg.children.map((child) => (
											<PartRenderer key={child.id} part={child} isLive={child.id === liveChildId} />
										))}
									</div>
									{seg.end && seg.end.toolState === "error" && (
										<AgentEndBlock
											content={seg.end.content}
											toolState={seg.end.toolState}
											timeEnd={seg.end.timeEnd}
											onRetry={onRetryAgent ? () => onRetryAgent(rawName, seg.start.content) : undefined}
										/>
									)}
								</>
							)}
						</div>
					);
				}
				return (
					<div
						key={seg.parts[0].id}
						className="border border-border border-l-[3px] border-l-slate-600 rounded-lg my-2 overflow-hidden pl-3 pr-2 py-1"
					>
						{seg.parts.map((p) => (
							<PartRenderer key={p.id} part={p} />
						))}
					</div>
				);
			})}
		</div>
	);
});

const PartRenderer = memo(function PartRenderer({ part, isLive }: { part: MessagePartData; isLive?: boolean }) {
	switch (part.type) {
		case "text": {
			if (!part.content?.trim()) return null;
			// Detect shell/tool JSON output and render as terminal
			const textTrimmed = part.content.trim();
			if (textTrimmed.startsWith("{") && textTrimmed.includes('"stdout"')) {
				let shellOutput: { output: string; exitCode: unknown } | null = null;
				try {
					const parsed = JSON.parse(textTrimmed);
					if (parsed && typeof parsed === "object" && ("stdout" in parsed || "stderr" in parsed)) {
						const stdout = typeof parsed.stdout === "string" ? parsed.stdout : "";
						const stderr = typeof parsed.stderr === "string" ? parsed.stderr : "";
						const output = stderr ? (stdout ? stdout + "\n" + stderr : stderr) : stdout;
						shellOutput = { output, exitCode: parsed.exitCode };
					}
				} catch { /* not valid JSON, render as text */ }
				if (shellOutput) {
					const { output, exitCode } = shellOutput;
					return (
						<div className="my-2 w-full rounded-lg overflow-hidden border border-gray-700">
							<div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 border-b border-gray-700">
								<span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
								<span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
								<span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
								<span className="text-[10px] text-gray-500 ml-1.5 font-mono">output</span>
								{exitCode != null && (
									<span className={cn("text-[10px] ml-auto font-mono font-semibold", exitCode === 0 ? "text-green-400" : "text-red-400")}>
										exit {String(exitCode)}
									</span>
								)}
							</div>
							<pre className="text-[11px] bg-gray-900 text-gray-100 font-mono px-3 py-2 whitespace-pre-wrap break-words max-h-64 overflow-auto leading-[1.6]">
								{output || "(no output)"}
							</pre>
						</div>
					);
				}
			}
			return <div className="my-2"><TextBlock content={isLive ? part.content + "▍" : part.content} /></div>;
		}

		case "tool_call": {
			const toolPart: ToolCallPartData = {
				id: part.id,
				toolName: part.toolName,
				toolInput: part.toolInput,
				toolOutput: part.toolOutput,
				toolState: part.toolState,
				content: part.content,
				timeStart: part.timeStart,
				timeEnd: part.timeEnd,
			};
			return <ToolCallCard part={toolPart} />;
		}

		case "reasoning":
			return (
				<div className="text-sm text-foreground/80 italic leading-snug whitespace-pre-wrap my-1 py-2 flex items-start gap-1.5">
					{isLive && <Brain className="w-3 h-3 mt-1 shrink-0 animate-pulse" />}
					<span>{part.content.trim()}{isLive && "▍"}</span>
				</div>
			);

		case "agent_start":
			return (
				<AgentStartBlock
					agentName={part.agentName ?? "unknown"}
					task={part.content}
					timeStart={part.timeStart}
				/>
			);

		case "agent_end":
			if (part.toolState !== "error") return null;
			return (
				<AgentEndBlock
					content={part.content}
					toolState={part.toolState}
					timeEnd={part.timeEnd}
					// No onRetry here: orphaned agent_end parts have no start context (task/agentName)
				/>
			);

		case "tool_result":
			// tool_result parts are typically consumed by ToolCallCard — render standalone if orphaned
			return (
				<div className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 my-0.5 max-h-32 overflow-y-auto overflow-x-hidden">
					<pre className="whitespace-pre-wrap break-words">{part.content || part.toolOutput || "(no result)"}</pre>
				</div>
			);

		default:
			return null;
	}
});
