import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
	X,
	Send,
	Square,
	Trash2,
	Loader2,
	Wrench,
	Sparkles,
	RefreshCw,
	Check,
	Copy,
	Download,
	ZoomIn,
	ZoomOut,
	Maximize2,
	MessageSquareText,
	FileText,
} from "lucide-react";
import { useConvFontSize } from "@/lib/use-conv-font-size";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { exportChatMarkdown } from "@/lib/export-markdown";
import { Tip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useCollectionsStore } from "@/stores/collections-store";
import type { CollectionChatCitationDto } from "../../../shared/rpc/collections";
import { useVoiceInput } from "@/lib/use-voice-input";
import { VoiceInputButton } from "@/components/chat/voice-input-button";

// Streaming, tool-calling Collections chat widget — mirrors
// src/mainview/components/dashboard/pm-chat-widget.tsx's feature set (zoom, expand,
// export, clear, copy/regenerate, stop-generating, tool-call indicators) scoped down
// for a notes Q&A assistant. Backend: src/bun/collections/chat.ts.

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	streaming?: boolean;
	isError?: boolean;
	citations?: CollectionChatCitationDto[];
}

// ---------------------------------------------------------------------------
// Markdown components for assistant bubbles — same shape as pm-chat-widget.tsx's
// MD_COMPONENTS (each chat surface in this codebase keeps its own small copy).
// ---------------------------------------------------------------------------

const MD_COMPONENTS = {
	code({ className, children, ref: _ref, ...props }: Record<string, unknown>) {
		const isBlock = /language-/.test((className as string) ?? "");
		if (isBlock) {
			return (
				<pre className="my-3 max-w-full overflow-x-auto rounded-md bg-muted/80 px-3 py-2 text-xs font-mono">
					<code {...props}>{children as React.ReactNode}</code>
				</pre>
			);
		}
		return (
			<code className="break-all rounded bg-muted/80 px-1 py-0.5 text-xs font-mono" {...props}>
				{children as React.ReactNode}
			</code>
		);
	},
	p: ({ children }: { children: React.ReactNode }) => <p className="mb-3 break-words last:mb-0">{children}</p>,
	ul: ({ children }: { children: React.ReactNode }) => <ul className="mb-3 list-disc pl-5 space-y-1 last:mb-0">{children}</ul>,
	ol: ({ children }: { children: React.ReactNode }) => <ol className="mb-3 list-decimal pl-5 space-y-1 last:mb-0">{children}</ol>,
	li: ({ children }: { children: React.ReactNode }) => <li className="break-words leading-relaxed">{children}</li>,
	a: ({ href, children }: { href?: string; children: React.ReactNode }) => (
		<a
			href={href}
			className="break-all text-blue-800 hover:text-blue-600 font-semibold underline cursor-pointer"
			onClick={(e) => {
				e.preventDefault();
				if (href) rpc.openExternalUrl(href).catch(() => {});
			}}
		>
			{children}
		</a>
	),
	blockquote: ({ children }: { children: React.ReactNode }) => (
		<blockquote className="my-3 border-l-2 border-muted-foreground/30 pl-3 italic text-muted-foreground last:mb-0">{children}</blockquote>
	),
	hr: () => <hr className="my-4 border-border" />,
	table: ({ children }: { children: React.ReactNode }) => (
		<div className="my-3 overflow-x-auto">
			<table className="min-w-full border-collapse text-xs">{children}</table>
		</div>
	),
	th: ({ children }: { children: React.ReactNode }) => (
		<th className="border border-border bg-muted/50 px-2 py-1 text-left font-medium">{children}</th>
	),
	td: ({ children }: { children: React.ReactNode }) => <td className="border border-border px-2 py-1">{children}</td>,
};

// ---------------------------------------------------------------------------
// localStorage helpers — ChatPanel stays mounted (hidden, not unmounted) while
// closed so streaming/listeners survive, but persistence also lets a fresh app
// launch restore the last conversation.
// ---------------------------------------------------------------------------

const LS_SESSION_KEY = "collections-chat-sessionId-v1";
const LS_MESSAGES_KEY = "collections-chat-messages-v1";

function loadPersistedSession(): { sessionId: string; messages: ChatMessage[] } {
	try {
		let sid = localStorage.getItem(LS_SESSION_KEY);
		if (!sid) {
			sid = `collections-chat-${crypto.randomUUID()}`;
			localStorage.setItem(LS_SESSION_KEY, sid);
		}
		const raw = localStorage.getItem(LS_MESSAGES_KEY);
		const messages: ChatMessage[] = raw ? (JSON.parse(raw) as ChatMessage[]).map((m) => ({ ...m, streaming: false })) : [];
		return { sessionId: sid, messages };
	} catch {
		const sid = `collections-chat-${crypto.randomUUID()}`;
		try { localStorage.setItem(LS_SESSION_KEY, sid); } catch { /* ignore */ }
		return { sessionId: sid, messages: [] };
	}
}

function persistMessages(messages: ChatMessage[]) {
	try { localStorage.setItem(LS_MESSAGES_KEY, JSON.stringify(messages)); } catch { /* quota / private browsing */ }
}

function persistSessionId(sessionId: string) {
	try { localStorage.setItem(LS_SESSION_KEY, sessionId); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Shared message-thread + input-bar renderers — used by both the docked panel
// and the expanded modal so there's one source of truth (pm-chat-widget.tsx
// duplicates this JSX wholesale between the two; avoiding that here).
// ---------------------------------------------------------------------------

function MessageThread({
	messages,
	toolCalls,
	isStreaming,
	copiedId,
	onCopy,
	onRegenerate,
	onRetry,
	onNavigateCitation,
	endRef,
}: {
	messages: ChatMessage[];
	toolCalls: Array<{ id: string; toolName: string; isSkill: boolean }>;
	isStreaming: boolean;
	copiedId: string | null;
	onCopy: (id: string, text: string) => void;
	onRegenerate: () => void;
	onRetry: () => void;
	onNavigateCitation: (c: CollectionChatCitationDto) => void;
	endRef: React.RefObject<HTMLDivElement | null>;
}) {
	const assistantMsgs = messages.filter((m) => m.role === "assistant" && !m.isError && !m.streaming);
	const lastAssistantId = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].id : null;

	return (
		<>
			{messages.length === 0 && !isStreaming && (
				<div className="flex flex-col items-center justify-center flex-1 text-center gap-2 py-6">
					<MessageSquareText className="h-8 w-8 text-muted-foreground/40" strokeWidth={3.5} aria-hidden="true" />
					<p className="text-sm text-muted-foreground">Ask a question about your saved notes.</p>
				</div>
			)}
			{messages.map((msg, index) => (
				<div key={msg.id} className={cn("flex flex-col group gap-0.5", msg.role === "user" ? "items-end" : "items-start")}>
					{msg.role === "user" ? (
						<div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground whitespace-pre-wrap break-words">
							{msg.content}
						</div>
					) : msg.isError ? (
						<div className="w-full rounded-2xl rounded-bl-sm bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm leading-relaxed text-destructive overflow-hidden">
							<div>{msg.content}</div>
							{index === messages.length - 1 && (
								<button
									type="button"
									onClick={onRetry}
									disabled={isStreaming}
									className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-destructive bg-destructive/10 hover:bg-destructive/20 border border-destructive/30 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
								>
									<RefreshCw className={cn("w-3 h-3", isStreaming && "animate-spin")} strokeWidth={3.5} aria-hidden="true" />
									{isStreaming ? "Retrying…" : "Retry"}
								</button>
							)}
						</div>
					) : (
						<div className="w-full rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-foreground overflow-hidden">
							<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={MD_COMPONENTS as never}>
								{msg.content + (msg.streaming ? "▍" : "")}
							</ReactMarkdown>
						</div>
					)}

					{msg.citations && msg.citations.length > 0 && (
						<div className="flex flex-wrap gap-1.5 max-w-[85%] mt-1.5">
							{msg.citations.map((c) => (
								<button
									key={c.noteId}
									type="button"
									onClick={() => onNavigateCitation(c)}
									className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60 hover:bg-muted text-xs text-foreground transition-colors max-w-[240px]"
									title={c.title}
								>
									<FileText className="w-3 h-3 shrink-0 text-muted-foreground" />
									<span className="truncate">{c.title}</span>
								</button>
							))}
						</div>
					)}

					{!msg.isError && !msg.streaming && (
						<div className="flex items-center gap-0.5 px-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
							<Tip content={copiedId === msg.id ? "Copied!" : "Copy"} side="top">
								<button
									type="button"
									onClick={() => onCopy(msg.id, msg.content)}
									aria-label="Copy message"
									className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								>
									{copiedId === msg.id ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
								</button>
							</Tip>
							{msg.role === "assistant" && msg.id === lastAssistantId && (
								<Tip content="Regenerate response" side="top">
									<button
										type="button"
										onClick={onRegenerate}
										disabled={isStreaming}
										aria-label="Regenerate response"
										className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed"
									>
										<RefreshCw className="size-3.5" />
									</button>
								</Tip>
							)}
						</div>
					)}
				</div>
			))}

			{isStreaming && toolCalls.length > 0 && (
				<div className="flex flex-col gap-1">
					{toolCalls.map((tc) => (
						<div key={tc.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
							{tc.isSkill ? <Sparkles className="h-3 w-3 text-primary/70 shrink-0" /> : <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />}
							<span className="font-mono truncate">{tc.toolName}</span>
						</div>
					))}
				</div>
			)}

			{isStreaming && !messages.some((m) => m.streaming) && (
				<div className="flex justify-start">
					<div className="rounded-2xl rounded-bl-sm bg-muted px-4 py-3">
						<div className="flex items-center gap-1">
							<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
							<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
							<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
						</div>
					</div>
				</div>
			)}

			<div ref={endRef} />
		</>
	);
}

function ChatInputBar({
	inputRef,
	value,
	onChange,
	onKeyDown,
	isStreaming,
	onSend,
	onStop,
	voiceSupported,
	voiceListening,
	voiceError,
	onVoiceToggle,
}: {
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	value: string;
	onChange: (v: string) => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	isStreaming: boolean;
	onSend: () => void;
	onStop: () => void;
	voiceSupported: boolean;
	voiceListening: boolean;
	voiceError: string | null;
	onVoiceToggle: () => void;
}) {
	return (
		<div className="px-3 pb-3 pt-2 border-t border-border shrink-0">
			<div className="flex items-end gap-2">
				<div className="flex flex-1 items-center gap-0.5 rounded-lg border border-input bg-background pl-2 pr-2 py-1 focus-within:ring-1 focus-within:ring-ring">
					<textarea
						ref={inputRef}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						onKeyDown={onKeyDown}
						placeholder="Ask about your notes…"
						rows={1}
						className={cn(
							"flex-1 resize-none bg-transparent px-1 py-1",
							"text-sm placeholder:text-muted-foreground",
							"focus-visible:outline-none",
							"max-h-28 overflow-y-auto",
						)}
						style={{ minHeight: "1.75rem" }}
						disabled={isStreaming}
					/>
					{voiceSupported && (
						<VoiceInputButton listening={voiceListening} error={voiceError} onClick={onVoiceToggle} disabled={isStreaming} />
					)}
				</div>
				{isStreaming ? (
					<Tip content="Stop generating" side="top">
						<Button type="button" size="icon" variant="destructive" onClick={onStop} className="shrink-0 h-9 w-9">
							<Square className="h-3.5 w-3.5" strokeWidth={3.5} fill="currentColor" aria-hidden="true" />
						</Button>
					</Tip>
				) : (
					<Button type="button" size="icon" onClick={onSend} disabled={!value.trim()} className="shrink-0 h-9 w-9">
						<Send className="h-4 w-4" strokeWidth={3.5} aria-hidden="true" />
					</Button>
				)}
			</div>
			<p className="text-[10px] text-muted-foreground mt-1 px-1">Enter to send · Shift+Enter for newline</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// ChatPanel
// ---------------------------------------------------------------------------

export function ChatPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
	const { percent: fontSizePercent, zoomIn, zoomOut, atMin: zoomAtMin, atMax: zoomAtMax } = useConvFontSize("conv-font-size-collections");
	const [showZoomHint, setShowZoomHint] = useState(false);
	const zoomHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const triggerZoomHint = useCallback(() => {
		setShowZoomHint(true);
		if (zoomHintTimer.current) clearTimeout(zoomHintTimer.current);
		zoomHintTimer.current = setTimeout(() => setShowZoomHint(false), 1500);
	}, []);

	const selectedCollectionId = useCollectionsStore((s) => s.selectedCollectionId);
	const setSelectedCollection = useCollectionsStore((s) => s.setSelectedCollection);
	const setSelectedNote = useCollectionsStore((s) => s.setSelectedNote);

	const [expandedOpen, setExpandedOpen] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const [input, setInput] = useState("");
	const [lastSent, setLastSent] = useState("");
	const [toolCalls, setToolCalls] = useState<Array<{ id: string; toolName: string; isSkill: boolean }>>([]);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [scopeToCollection, setScopeToCollection] = useState(false);
	const [embeddingReady, setEmbeddingReady] = useState(true);

	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const sessionId = useRef("");
	const initialised = useRef(false);
	const messagesRef = useRef<ChatMessage[]>(messages);
	messagesRef.current = messages; // eslint-disable-line react-hooks/refs

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const modalMessagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const modalInputRef = useRef<HTMLTextAreaElement>(null);
	const expandedOpenRef = useRef(false);
	const widgetRef = useRef<HTMLDivElement>(null);

	const canScopeToCollection =
		selectedCollectionId !== null && selectedCollectionId !== "favorites" && selectedCollectionId !== "trash";
	const effectiveScope = scopeToCollection && canScopeToCollection ? (selectedCollectionId as string) : "all";

	useEffect(() => {
		if (initialised.current) return;
		initialised.current = true;
		const { sessionId: sid, messages: msgs } = loadPersistedSession();
		sessionId.current = sid;
		setMessages(msgs);
	}, []);

	useEffect(() => {
		rpc.getEmbeddingModelStatus()
			.then((s) => setEmbeddingReady(s.status === "ready"))
			.catch(() => setEmbeddingReady(false));
	}, []);
	useEffect(() => {
		const handler = (e: Event) => {
			const status = (e as CustomEvent<{ status: string }>).detail.status;
			if (status === "ready") setEmbeddingReady(true);
		};
		window.addEventListener("agentdesk:collection-embedding-model-status", handler);
		return () => window.removeEventListener("agentdesk:collection-embedding-model-status", handler);
	}, []);

	useEffect(() => { expandedOpenRef.current = expandedOpen; }, [expandedOpen]);

	// Close when clicking outside the widget (docked panel only)
	useEffect(() => {
		if (!open || expandedOpen) return;
		const handleMouseDown = (e: MouseEvent) => {
			const target = e.target as Element;
			if (target.closest('[role="dialog"], [data-radix-popper-content-wrapper]')) return;
			if (widgetRef.current && !widgetRef.current.contains(target)) onClose();
		};
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	}, [open, expandedOpen, onClose]);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
		modalMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, open, expandedOpen]);

	useEffect(() => {
		if (open) setTimeout(() => inputRef.current?.focus(), 50);
	}, [open]);
	useEffect(() => {
		if (!isStreaming) requestAnimationFrame(() => (expandedOpenRef.current ? modalInputRef : inputRef).current?.focus());
	}, [isStreaming]);

	// Streaming event listeners — this component stays mounted (hidden, not
	// unmounted) while closed so a stream survives the panel being closed.
	useEffect(() => {
		const onChunk = (e: Event) => {
			const { sessionId: sid, messageId, token } = (e as CustomEvent<{ sessionId: string; messageId: string; token: string }>).detail;
			if (sid !== sessionId.current) return;
			setIsStreaming(true);
			setMessages((prev) => {
				const existing = prev.find((m) => m.id === messageId);
				if (existing) return prev.map((m) => (m.id === messageId ? { ...m, content: m.content + token } : m));
				return [...prev, { id: messageId, role: "assistant", content: token, streaming: true }];
			});
		};

		const onToolCall = (e: Event) => {
			const { sessionId: sid, toolName } = (e as CustomEvent<{ sessionId: string; toolName: string }>).detail;
			if (sid !== sessionId.current) return;
			setIsStreaming(true);
			const isSkill = toolName === "read_skill" || toolName === "find_skills";
			setToolCalls((prev) => [...prev, { id: crypto.randomUUID(), toolName, isSkill }]);
		};

		const onComplete = (e: Event) => {
			const { sessionId: sid, messageId, citations } = (e as CustomEvent<{ sessionId: string; messageId: string; content: string; citations: CollectionChatCitationDto[] }>).detail;
			if (sid !== sessionId.current) return;
			setMessages((prev) => {
				const next = prev.map((m) => (m.id === messageId ? { ...m, streaming: false, citations } : m));
				persistMessages(next);
				return next;
			});
			setToolCalls([]);
			setIsStreaming(false);
		};

		const onError = (e: Event) => {
			const { sessionId: sid, error } = (e as CustomEvent<{ sessionId: string; error: string }>).detail;
			if (sid !== sessionId.current) return;
			setMessages((prev) => {
				const next = [
					...prev.filter((m) => !m.streaming),
					{ id: crypto.randomUUID(), role: "assistant" as const, content: `Error: ${error}`, isError: true },
				];
				persistMessages(next);
				return next;
			});
			setToolCalls([]);
			setIsStreaming(false);
		};

		window.addEventListener("agentdesk:collections-chat-chunk", onChunk);
		window.addEventListener("agentdesk:collections-chat-tool-call", onToolCall);
		window.addEventListener("agentdesk:collections-chat-complete", onComplete);
		window.addEventListener("agentdesk:collections-chat-error", onError);
		return () => {
			window.removeEventListener("agentdesk:collections-chat-chunk", onChunk);
			window.removeEventListener("agentdesk:collections-chat-tool-call", onToolCall);
			window.removeEventListener("agentdesk:collections-chat-complete", onComplete);
			window.removeEventListener("agentdesk:collections-chat-error", onError);
		};
	}, []);

	function navigateToCitation(citation: CollectionChatCitationDto) {
		setSelectedCollection(citation.collectionId);
		setSelectedNote(citation.noteId);
	}

	const voice = useVoiceInput(input, setInput, () =>
		requestAnimationFrame(() => (expandedOpenRef.current ? modalInputRef : inputRef).current?.focus()),
	);

	const sendMessage = useCallback(async () => {
		const content = input.trim();
		if (!content || isStreaming) return;

		voice.stop();
		setInput("");
		requestAnimationFrame(() => (expandedOpenRef.current ? modalInputRef : inputRef).current?.focus());
		setLastSent(content);
		setIsStreaming(true);
		setToolCalls([]);

		const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content };
		setMessages((prev) => {
			const next = [...prev, userMsg];
			persistMessages(next);
			return next;
		});

		try {
			await rpc.sendCollectionsChatMessage(sessionId.current, content, effectiveScope);
		} catch {
			setMessages((prev) => {
				const next = [...prev, { id: crypto.randomUUID(), role: "assistant" as const, content: "Failed to send message. Please try again." }];
				persistMessages(next);
				return next;
			});
			setIsStreaming(false);
		}
	}, [input, isStreaming, effectiveScope, voice]);

	const retryLastMessage = useCallback(async () => {
		if (isStreaming) return;
		const lastUserMsg = [...messagesRef.current].reverse().find((m) => m.role === "user");
		if (!lastUserMsg) return;

		setMessages((prev) => {
			const next = prev.filter((m) => !m.isError);
			persistMessages(next);
			return next;
		});
		setIsStreaming(true);
		setToolCalls([]);

		try {
			await rpc.sendCollectionsChatMessage(sessionId.current, lastUserMsg.content, effectiveScope);
		} catch {
			setMessages((prev) => {
				const next = [...prev, { id: crypto.randomUUID(), role: "assistant" as const, content: "Failed to send message. Please try again.", isError: true }];
				persistMessages(next);
				return next;
			});
			setIsStreaming(false);
		}
	}, [isStreaming, effectiveScope]);

	const handleStop = useCallback(async () => {
		await rpc.abortCollectionsChatMessage(sessionId.current);
		setIsStreaming(false);
	}, []);

	const handleCopy = useCallback((id: string, text: string) => {
		void navigator.clipboard.writeText(text).then(() => {
			setCopiedId(id);
			setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
		});
	}, []);

	const handleRegenerate = useCallback(async () => {
		if (isStreaming) return;
		const lastUserMsg = [...messagesRef.current].reverse().find((m) => m.role === "user");
		if (!lastUserMsg) return;

		setMessages((prev) => {
			const lastAssistIdx = [...prev].reverse().findIndex((m) => m.role === "assistant" && !m.isError);
			const actualIdx = lastAssistIdx === -1 ? -1 : prev.length - 1 - lastAssistIdx;
			const next = actualIdx === -1 ? prev : prev.filter((_, i) => i !== actualIdx);
			persistMessages(next);
			return next;
		});
		setIsStreaming(true);
		setToolCalls([]);

		try {
			await rpc.sendCollectionsChatMessage(sessionId.current, lastUserMsg.content, effectiveScope);
		} catch {
			setMessages((prev) => {
				const next = [...prev, { id: crypto.randomUUID(), role: "assistant" as const, content: "Failed to regenerate response. Please try again.", isError: true }];
				persistMessages(next);
				return next;
			});
			setIsStreaming(false);
		}
	}, [isStreaming, effectiveScope]);

	const handleExportMarkdown = useCallback(() => {
		exportChatMarkdown({
			title: "Collections Chat",
			messages: messages.filter((m) => !m.isError),
			assistantLabel: "Collections Assistant",
			filename: "collections-chat",
		});
	}, [messages]);

	const handleClear = useCallback(async () => {
		if (isStreaming) {
			await rpc.abortCollectionsChatMessage(sessionId.current);
			setIsStreaming(false);
		}
		rpc.clearCollectionsChatSession(sessionId.current).catch(() => {});
		const newSid = `collections-chat-${crypto.randomUUID()}`;
		sessionId.current = newSid;
		persistSessionId(newSid);
		try { localStorage.removeItem(LS_MESSAGES_KEY); } catch { /* ignore */ }
		setMessages([]);
		setToolCalls([]);
	}, [isStreaming]);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
			return;
		}
		if (e.key === "ArrowUp" && input === "" && lastSent) {
			e.preventDefault();
			setInput(lastSent);
		}
	};

	const scopeToggle = (
		<div className="flex items-center gap-1.5 px-4 py-2 border-b border-border shrink-0 text-xs">
			<button
				type="button"
				onClick={() => setScopeToCollection(false)}
				className={cn(
					"px-2 py-1 rounded-md transition-colors",
					!scopeToCollection ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted",
				)}
			>
				All collections
			</button>
			<button
				type="button"
				onClick={() => canScopeToCollection && setScopeToCollection(true)}
				disabled={!canScopeToCollection}
				title={canScopeToCollection ? undefined : "Select a collection in the Library first"}
				className={cn(
					"px-2 py-1 rounded-md transition-colors",
					scopeToCollection && canScopeToCollection
						? "bg-primary/10 text-primary font-medium"
						: "text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent",
				)}
			>
				This collection
			</button>
			{!embeddingReady && (
				<span className="ml-auto text-[10px] text-muted-foreground/70">
					Keyword search only — download the embedding model in Settings for smarter search
				</span>
			)}
		</div>
	);

	function header(opts: { expanded: boolean }) {
		return (
			<div className={cn("flex items-center px-4 py-3 border-b border-border shrink-0 bg-primary", opts.expanded ? "rounded-t-lg" : "rounded-t-xl")}>
				<div className="flex items-center gap-2 flex-1">
					<MessageSquareText className="h-4 w-4 text-primary-foreground" strokeWidth={3.5} aria-hidden="true" />
					<span className="text-sm font-semibold text-primary-foreground">Collections Chat</span>
					{isStreaming && <Loader2 className="h-3.5 w-3.5 text-primary-foreground/70 animate-spin" strokeWidth={3.5} aria-hidden="true" />}
				</div>
				<div className="flex items-center gap-1">
					<div className="relative flex items-center">
						<div
							className={cn(
								"absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-0.5 rounded-full text-[11px] font-mono font-medium bg-foreground text-background shadow-md pointer-events-none transition-opacity duration-300 whitespace-nowrap z-50",
								showZoomHint ? "opacity-100" : "opacity-0",
							)}
						>
							{fontSizePercent}%
						</div>
						<Tip content="Decrease font size" side="bottom">
							<button
								type="button"
								onClick={() => { zoomOut(); triggerZoomHint(); }}
								disabled={zoomAtMin}
								className="p-1.5 rounded-md text-primary-foreground/70 hover:text-primary-foreground hover:bg-white/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
							>
								<ZoomOut className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
							</button>
						</Tip>
						<Tip content="Increase font size" side="bottom">
							<button
								type="button"
								onClick={() => { zoomIn(); triggerZoomHint(); }}
								disabled={zoomAtMax}
								className="p-1.5 rounded-md text-primary-foreground/70 hover:text-primary-foreground hover:bg-white/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
							>
								<ZoomIn className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
							</button>
						</Tip>
					</div>
					{!opts.expanded && (
						<Tip content="Expand conversation" side="bottom">
							<button type="button" onClick={() => setExpandedOpen(true)} className="p-1.5 rounded-md text-primary-foreground/70 hover:text-primary-foreground hover:bg-white/20 transition-colors max-md:hidden">
								<Maximize2 className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
							</button>
						</Tip>
					)}
					<Tip content="Export as markdown" side="bottom">
						<button
							type="button"
							onClick={handleExportMarkdown}
							disabled={messages.length === 0}
							className="p-1.5 rounded-md text-primary-foreground/70 hover:text-primary-foreground hover:bg-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						>
							<Download className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
						</button>
					</Tip>
					<Tip content="Clear conversation" side="bottom">
						<button type="button" onClick={handleClear} className="p-1.5 rounded-md text-primary-foreground/70 hover:text-primary-foreground hover:bg-white/20 transition-colors">
							<Trash2 className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
						</button>
					</Tip>
					<Tip content={opts.expanded ? "Collapse" : "Close"} side="bottom">
						<button
							type="button"
							onClick={() => (opts.expanded ? setExpandedOpen(false) : onClose())}
							className="p-1.5 rounded-md text-primary-foreground/70 hover:text-primary-foreground hover:bg-white/20 transition-colors"
						>
							<X className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden="true" />
						</button>
					</Tip>
				</div>
			</div>
		);
	}

	return (
		<>
			{open && !expandedOpen && (
				<div
					ref={widgetRef}
					className={cn(
						"fixed bottom-[19px] right-6 z-[57]",
						"flex flex-col w-[504px] h-[540px]",
						"max-md:left-3 max-md:right-3 max-md:bottom-3 max-md:w-auto max-md:h-[82dvh]",
						"bg-background border border-border rounded-xl shadow-2xl overflow-hidden",
					)}
				>
					{header({ expanded: false })}
					{scopeToggle}
					<div
						className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 gap-3"
						style={fontSizePercent !== 100 ? { zoom: fontSizePercent / 100 } : undefined}
					>
						<MessageThread
							messages={messages}
							toolCalls={toolCalls}
							isStreaming={isStreaming}
							copiedId={copiedId}
							onCopy={handleCopy}
							onRegenerate={handleRegenerate}
							onRetry={retryLastMessage}
							onNavigateCitation={navigateToCitation}
							endRef={messagesEndRef}
						/>
					</div>
					<ChatInputBar
						inputRef={inputRef}
						value={input}
						onChange={setInput}
						onKeyDown={handleKeyDown}
						isStreaming={isStreaming}
						onSend={sendMessage}
						onStop={handleStop}
						voiceSupported={voice.supported}
						voiceListening={voice.listening}
						voiceError={voice.error}
						onVoiceToggle={voice.toggle}
					/>
				</div>
			)}

			<Dialog open={expandedOpen} onOpenChange={setExpandedOpen}>
				<DialogContent className="p-0 gap-0 overflow-hidden flex flex-col max-w-4xl w-full h-[82vh] border-0 [&>button:last-child]:hidden">
					{header({ expanded: true })}
					{scopeToggle}
					<div
						className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 gap-3"
						style={fontSizePercent !== 100 ? { zoom: fontSizePercent / 100 } : undefined}
					>
						<MessageThread
							messages={messages}
							toolCalls={toolCalls}
							isStreaming={isStreaming}
							copiedId={copiedId}
							onCopy={handleCopy}
							onRegenerate={handleRegenerate}
							onRetry={retryLastMessage}
							onNavigateCitation={navigateToCitation}
							endRef={modalMessagesEndRef}
						/>
					</div>
					<ChatInputBar
						inputRef={modalInputRef}
						value={input}
						onChange={setInput}
						onKeyDown={handleKeyDown}
						isStreaming={isStreaming}
						onSend={sendMessage}
						onStop={handleStop}
						voiceSupported={voice.supported}
						voiceListening={voice.listening}
						voiceError={voice.error}
						onVoiceToggle={voice.toggle}
					/>
				</DialogContent>
			</Dialog>
		</>
	);
}
