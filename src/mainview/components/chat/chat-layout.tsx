import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useMessageQueueStore } from "@/stores/message-queue";
import { PanelLeft, PanelRight, Upload, Search, Download, SquarePen, FoldHorizontal, UnfoldHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { useConvFontSize } from "@/lib/use-conv-font-size";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat-store";

import { Trash2 } from "lucide-react";
import { ConversationSidebar } from "./conversation-sidebar";
import { MessageList } from "./message-list";
import { ChatInput, TEXT_EXTENSIONS, type ChatInputHandle } from "./chat-input";
import { MessageSearch } from "./message-search";
import { ContextPanel } from "../activity/context-panel";
import { ModelSelector } from "./model-selector";
import { ShellApprovalCard } from "./shell-approval-card";
import { toast } from "@/components/ui/toast";
import { Tip } from "@/components/ui/tooltip";
import { rpc } from "@/lib/rpc";

interface ChatLayoutProps {
  projectId: string;
}

const ACTIVITY_WIDTH_MIN = 300;
const ACTIVITY_WIDTH_MAX = 400;
const ACTIVITY_WIDTH_DEFAULT = 300;
const FOCUS_KEY = "chat-focus-mode";

export function ChatLayout({ projectId }: ChatLayoutProps) {
  const [isFocused, setIsFocused] = useState(() => {
    try { return localStorage.getItem(FOCUS_KEY) === "true"; } catch { return false; }
  });
  const [sidebarOpen, setSidebarOpen] = useState(false); // always starts closed; user opens manually
  const [activityOpen, setActivityOpen] = useState(() => {
    try {
      // Collapsed by default on mobile — as an inline column it would squeeze/clip
      // the chat; the user opens it on demand (it overlays as a sheet there).
      if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches) return false;
      return localStorage.getItem(FOCUS_KEY) !== "true";
    } catch { return true; }
  });
  const sidebarRef = useRef<HTMLDivElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);

  // On mount: if already in focus mode, tell app-shell to collapse main sidebar
  useEffect(() => {
    try {
      if (localStorage.getItem(FOCUS_KEY) === "true") {
        window.dispatchEvent(new CustomEvent("agentdesk:focus-mode-enter"));
      }
    } catch { /* ignore localStorage errors */ }
  }, []);

  const handleFocusToggle = useCallback(() => {
    setIsFocused((prev) => {
      const next = !prev;
      try { localStorage.setItem(FOCUS_KEY, String(next)); } catch { /* ignore */ }
      if (next) {
        // Enter: collapse conv sidebar, activity pane, and main app sidebar
        setSidebarOpen(false);
        setActivityOpen(false);
        window.dispatchEvent(new CustomEvent("agentdesk:focus-mode-enter"));
      } else {
        // Exit: restore activity pane only — conv sidebar stays closed; main sidebar restores to saved setting
        setActivityOpen(true);
        window.dispatchEvent(new CustomEvent("agentdesk:focus-mode-exit"));
      }
      return next;
    });
  }, []);
  const { percent: fontSizePercent, zoomIn, zoomOut, atMin: zoomAtMin, atMax: zoomAtMax } = useConvFontSize();
  const [showZoomHint, setShowZoomHint] = useState(false);
  const zoomHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerZoomHint = useCallback(() => {
    setShowZoomHint(true);
    if (zoomHintTimer.current) clearTimeout(zoomHintTimer.current);
    zoomHintTimer.current = setTimeout(() => setShowZoomHint(false), 1500);
  }, []);

  const [isDragging, setIsDragging] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const dragCounterRef = useRef(0);
  const [activityWidth, setActivityWidth] = useState(ACTIVITY_WIDTH_DEFAULT);
  const chatInputRef = useRef<ChatInputHandle>(null);

  // Close conversation sidebar when clicking outside it (excluding the toggle button)
  useEffect(() => {
    if (!sidebarOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        sidebarRef.current && !sidebarRef.current.contains(target) &&
        sidebarToggleRef.current && !sidebarToggleRef.current.contains(target)
      ) {
        setSidebarOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [sidebarOpen]);

  // Store state
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const streamingMessageId = useChatStore((s) => s.streamingMessageId);
  // Store actions
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const createConversation = useChatStore((s) => s.createConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const branchConversation = useChatStore((s) => s.branchConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const pinConversation = useChatStore((s) => s.pinConversation);
  const shellApprovalRequests = useChatStore((s) => s.shellApprovalRequests);
  const runningAgentCount = useChatStore((s) => s.runningAgentCount);
  const messagesLoading = useChatStore((s) => s.messagesLoading);

  const pmPending = useChatStore((s) => s.pmPending);
  const isCompacting = useChatStore((s) => s.isCompacting);
  const isBusy = isStreaming || runningAgentCount > 0 || pmPending || isCompacting;

  // ---- Message queue --------------------------------------------------------
  const enqueue = useMessageQueueStore((s) => s.enqueue);
  const dequeue = useMessageQueueStore((s) => s.dequeue);
  const removeQueued = useMessageQueueStore((s) => s.remove);
  const clearQueue = useMessageQueueStore((s) => s.clear);
  const queuedMessages = useMessageQueueStore((s) => s.queue);

  // Context utilization estimate for /compact visibility (same logic as ContextIndicator)
  const contextUtilization = useMemo(() => {
    const tokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    return Math.min((tokens / 200_000) * 100, 100);
  }, [messages]);

  // Keep a ref to activityWidth so the mouseup closure can read the latest value
  const activityWidthRef = useRef(activityWidth);
  useEffect(() => {
    activityWidthRef.current = activityWidth;
  }, [activityWidth]);

  // Conversation selection
  const handleSelectConversation = useCallback(
    (id: string) => {
      setActiveConversation(id);
      loadMessages(id);
    },
    [setActiveConversation, loadMessages],
  );

  const handleCreateConversation = useCallback(() => {
    createConversation(projectId).then((id) => {
      setActiveConversation(id);
      loadMessages(id);
      chatInputRef.current?.focus();
    });
  }, [projectId, createConversation, setActiveConversation, loadMessages]);

  const handleDeleteConversation = useCallback(
    (id: string) => {
      deleteConversation(id);
    },
    [deleteConversation],
  );

  // Send message — handles file attachments by saving to backend first
  const handleSend = useCallback(
    async (content: string, attachments?: import("./chat-input").AttachmentFile[], mentionedFilePaths?: string[]) => {
      if (!activeConversationId) return;

      // Queue plain-text messages when the PM is busy (no attachments, not shell)
      if (isBusy && !attachments?.length && !content.startsWith("__shell__")) {
        const added = enqueue(content);
        if (!added) {
          toast("error", "Message queue is full — wait for the PM to respond before sending more.");
        }
        return;
      }

      // Shell result — display as ephemeral chat bubbles, don't send to AI
      if (content.startsWith("__shell__")) {
        try {
          const data = JSON.parse(content.slice(9)) as { command: string; output: string; exitCode: number | null; isError: boolean };
          // Store as JSON with stdout/exitCode so the terminal renderer picks it up
          const shellContent = JSON.stringify({
            stdout: `$ ${data.command}\n${data.output}`,
            stderr: "",
            exitCode: data.exitCode,
          });
          const shellMsg = {
            id: `shell-${Date.now()}`,
            conversationId: activeConversationId,
            role: "assistant" as const,
            agentId: null,
            agentName: null,
            content: shellContent,
            metadata: JSON.stringify({ source: "shell", isError: data.isError }),
            tokenCount: 0,
            hasParts: 0,
            createdAt: new Date().toISOString(),
          };
          useChatStore.setState((prev) => ({
            messages: [...prev.messages, shellMsg],
          }));
        } catch { /* malformed shell result */ }
        return;
      }

      let visibleContent = content;
      let implicitContext = "";
      const attachmentMeta: Array<{ name: string; type: string; path?: string }> = [];

      // Read @ mentioned files and inject as implicit context
      if (mentionedFilePaths && mentionedFilePaths.length > 0) {
        for (const filePath of mentionedFilePaths) {
          try {
            const result = await rpc.readWorkspaceFile(projectId, filePath);
            if (result.content) {
              implicitContext += `\n<attached-file name="${filePath}">\n${result.content}\n</attached-file>\n`;
            }
          } catch { /* skip unreadable files */ }
        }
      }

      // Save attachments to backend and build context
      if (attachments && attachments.length > 0) {
        const fileChips: string[] = [];

        for (const att of attachments) {
          try {
            // Convert file to base64 for backend save
            let base64: string;
            if (att.type === "text") {
              base64 = btoa(unescape(encodeURIComponent(att.content)));
            } else if (att.type === "image" && att.content.startsWith("data:")) {
              base64 = att.content.split(",")[1] ?? "";
            } else if (att.file) {
              const buf = await att.file.arrayBuffer();
              base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
            } else {
              continue;
            }

            const saved = await rpc.saveAttachment(projectId, att.name, base64, att.type);
            attachmentMeta.push({
              name: saved.name,
              type: saved.type,
              path: saved.path,
              ...(att.type === "image" && att.content ? { dataUrl: att.content } : {}),
            });
            fileChips.push(`[${att.name}]`);

            // Build implicit context based on type
            if (att.type === "text") {
              implicitContext += `\n<attached-file name="${saved.name}" path="${saved.path}">\n${att.content}\n</attached-file>\n`;
            } else if (att.type === "image") {
              implicitContext += `\n[Attached image: "${saved.name}" saved at "${saved.path}". Use read_file to view this image if you support vision, or describe that you cannot view images with the current model.]\n`;
            } else {
              implicitContext += `\n[Attached file: "${saved.name}" saved at "${saved.path}". This is a binary file (${att.name.split(".").pop()}). Use available tools or skills to read/extract content from this file before responding.]\n`;
            }
          } catch {
            // Skip failed attachment saves
          }
        }

        // Visible content: user text + file chips
        const chipLine = fileChips.length > 0 ? `Attached: ${fileChips.join(", ")}` : "";
        visibleContent = chipLine + (content ? `\n${content}` : "");
      }

      // The full content sent to AI includes implicit context
      const fullContent = implicitContext
        ? `${implicitContext}\n${content}`
        : content;

      // Add user message to local state immediately (show visible content)
      const userMsg = {
        id: `temp-${Date.now()}`,
        conversationId: activeConversationId,
        role: "user",
        agentId: null,
        agentName: null,
        content: visibleContent,
        metadata: attachmentMeta.length > 0 ? JSON.stringify({ attachments: attachmentMeta }) : null,
        tokenCount: 0,
        hasParts: 0,
        createdAt: new Date().toISOString(),
      };
      useChatStore.setState((prev) => ({
        messages: [...prev.messages, userMsg],
      }));

      sendMessage(projectId, activeConversationId, fullContent);
    },
    [projectId, activeConversationId, sendMessage, isBusy, enqueue],
  );

  // Drain one queued message when the PM transitions from busy → idle.
  const prevBusyRef = useRef(isBusy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = isBusy;
    if (wasBusy && !isBusy) {
      const msg = dequeue();
      if (msg && activeConversationId) {
        handleSend(msg.content);
      }
    }
  }, [isBusy, dequeue, handleSend, activeConversationId]);

  // Clear the queue when the user switches to a different conversation.
  useEffect(() => {
    clearQueue();
  }, [activeConversationId, clearQueue]);

  const handleStop = useCallback(() => {
    const count = useMessageQueueStore.getState().queue.length;
    if (count > 0) {
      clearQueue();
      toast("info", `Queue cleared — ${count} message${count !== 1 ? "s" : ""} discarded.`);
    }
    stopGeneration(projectId);
  }, [projectId, stopGeneration, clearQueue]);

  const [confirmClear, setConfirmClear] = useState(false);
  const confirmClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClearChat = useCallback(() => {
    if (!activeConversationId) return;
    if (confirmClear) {
      if (confirmClearTimerRef.current) clearTimeout(confirmClearTimerRef.current);
      setConfirmClear(false);
      clearMessages(activeConversationId);
    } else {
      setConfirmClear(true);
      confirmClearTimerRef.current = setTimeout(() => setConfirmClear(false), 3000);
    }
  }, [activeConversationId, clearMessages, confirmClear]);

  // Slash command: /clear (skip confirmation)
  const handleSlashClear = useCallback(() => {
    if (!activeConversationId) return;
    clearMessages(activeConversationId);
  }, [activeConversationId, clearMessages]);

  // Slash command: /fork
  const handleSlashFork = useCallback(() => {
    if (!activeConversationId || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    branchConversation(projectId, activeConversationId, lastMsg.id).then((newId) => {
      setActiveConversation(newId);
      loadMessages(newId);
      chatInputRef.current?.focus();
    });
  }, [projectId, activeConversationId, messages, branchConversation, setActiveConversation, loadMessages]);

  // Resize handler
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = activityWidthRef.current;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const newWidth = Math.max(
        ACTIVITY_WIDTH_MIN,
        Math.min(ACTIVITY_WIDTH_MAX, startWidth + delta),
      );
      setActivityWidth(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  // Ctrl+F to open search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSearchHighlight = useCallback((messageId: string | null) => {
    setHighlightedMessageId(messageId);
    if (messageId) {
      const el = document.getElementById(`msg-${messageId}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
    setHighlightedMessageId(null);
    setSearchQuery("");
  }, []);

  // Export conversation as markdown
  const handleExportMarkdown = useCallback(() => {
    if (!activeConversationId || messages.length === 0) return;
    const conv = conversations.find((c) => c.id === activeConversationId);
    const title = conv?.title ?? "Conversation";
    const lines = [`# ${title}\n`];
    for (const msg of messages) {
      if (!msg.content.trim()) continue;
      const role = msg.role === "user" ? "User" : msg.role === "error" ? "Error" : (msg.agentId ?? "Assistant");
      const time = new Date(msg.createdAt).toLocaleString();
      lines.push(`## ${role} — ${time}\n`);
      lines.push(msg.content);
      lines.push("");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "conversation"}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("success", "Chat exported as Markdown.");
  }, [activeConversationId, messages, conversations]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) {
      dragCounterRef.current += 1;
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const accepted = files.filter((f) => {
        const dot = f.name.lastIndexOf(".");
        if (dot === -1) return true;
        const ext = f.name.slice(dot + 1).toLowerCase();
        return TEXT_EXTENSIONS.has(ext);
      });
      if (accepted.length < files.length) {
        toast("warning", "Binary files were skipped — only text files can be attached");
      }
      if (accepted.length > 0) {
        chatInputRef.current?.addFiles(accepted);
      }
    },
    [],
  );

  return (
    <div className="flex h-full overflow-hidden bg-background">
      {/* Conversation Sidebar */}
      <div
        ref={sidebarRef}
        className={cn(
          "flex-shrink-0 border-r border-border bg-muted/50 overflow-hidden",
          "transition-all duration-200 ease-in-out",
          // Mobile: overlay the chat (opaque, on top) instead of squeezing it.
          // Closed by default (sidebarOpen starts false); click-outside closes it.
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:bg-background max-md:shadow-xl",
          sidebarOpen ? "w-[220px]" : "w-0",
        )}
        aria-hidden={!sidebarOpen}
      >
        <ConversationSidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelect={handleSelectConversation}
          onCreate={handleCreateConversation}
          onDelete={handleDeleteConversation}
          onRename={renameConversation}
          onPin={pinConversation}
        />
      </div>

      {/* Main Chat Area */}
      <div
        className="flex-1 flex flex-col min-w-0 sm:min-w-[400px] relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drop zone overlay */}
        {isDragging && (
          <div
            className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 rounded-lg bg-indigo-500/10 border-2 border-dashed border-indigo-400 pointer-events-none"
            aria-hidden="true"
          >
            <Upload className="w-10 h-10 text-indigo-500" />
            <span className="text-sm font-medium text-indigo-600">Drop files to attach</span>
          </div>
        )}
        {/* Header bar */}
        <div className="h-12 flex items-center px-2 sm:px-4 border-b border-border gap-1 sm:gap-2 shrink-0">
          <Tip content={sidebarOpen ? "Hide conversations" : "Show conversations"} side="bottom">
            <button
              ref={sidebarToggleRef}
              type="button"
              onClick={() => setSidebarOpen((prev) => !prev)}
              aria-label={sidebarOpen ? "Hide conversations" : "Show conversations"}
              aria-pressed={sidebarOpen}
              className={cn(
                "inline-flex items-center justify-center rounded-md p-1.5",
                "text-muted-foreground hover:text-foreground hover:bg-muted",
                "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                sidebarOpen &&
                  "text-indigo-600 bg-indigo-50 hover:bg-indigo-100 hover:text-indigo-700",
              )}
            >
              <PanelLeft className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tip>

          <span className="font-medium text-foreground text-sm truncate">
            {conversations.find((c) => c.id === activeConversationId)?.title ??
              "Chat"}
          </span>


          {/* Centered clear chat */}
          <div className="flex-1 flex justify-center">
            {activeConversationId && messages.length > 0 && !isBusy && (
              <Tip content={confirmClear ? "Click again to confirm" : "Clear chat messages"} side="bottom">
                <button
                  type="button"
                  onClick={handleClearChat}
                  className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors",
                    confirmClear
                      ? "text-red-600 bg-red-50 hover:bg-red-100"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  <Trash2 className="w-3 h-3" />
                  <span>{confirmClear ? "Confirm?" : "Clear Chat"}</span>
                </button>
              </Tip>
            )}
          </div>

          <Tip content="New conversation" side="bottom">
            <button
              type="button"
              onClick={handleCreateConversation}
              aria-label="New conversation"
              className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <SquarePen className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tip>

          <Tip content={isFocused ? "Restore sidebars" : "Focus mode — hide both sidebars"} side="bottom">
            <button
              type="button"
              onClick={handleFocusToggle}
              aria-label={isFocused ? "Restore sidebars" : "Focus mode"}
              aria-pressed={isFocused}
              className={cn(
                "inline-flex items-center justify-center rounded-md p-1.5",
                "text-muted-foreground hover:text-foreground hover:bg-muted",
                "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                isFocused && "text-indigo-600 bg-indigo-50 hover:bg-indigo-100 hover:text-indigo-700",
              )}
            >
              {isFocused
                ? <UnfoldHorizontal className="h-4 w-4" aria-hidden="true" />
                : <FoldHorizontal className="h-4 w-4" aria-hidden="true" />}
            </button>
          </Tip>

          {/* Font size controls */}
          <div className="relative flex items-center gap-0.5">
            {/* Temporary hint pill — appears above the buttons on zoom change */}
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
                aria-label="Decrease conversation font size"
                className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ZoomOut className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tip>
            <Tip content="Increase font size" side="bottom">
              <button
                type="button"
                onClick={() => { zoomIn(); triggerZoomHint(); }}
                disabled={zoomAtMax}
                aria-label="Increase conversation font size"
                className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ZoomIn className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tip>
          </div>

          <Tip content="Search messages" side="bottom">
            <button
              type="button"
              onClick={() => setSearchOpen((o) => !o)}
              aria-label="Search messages"
              className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tip>

          {activeConversationId && messages.length > 0 && (
            <Tip content="Export as markdown" side="bottom">
              <button
                type="button"
                onClick={handleExportMarkdown}
                aria-label="Export as markdown"
                className="inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tip>
          )}

          <Tip content={activityOpen ? "Hide activity pane" : "Show activity pane"} side="bottom">
            <button
              type="button"
              onClick={() => setActivityOpen((prev) => !prev)}
              aria-label={activityOpen ? "Hide activity pane" : "Show activity pane"}
              aria-pressed={activityOpen}
              className={cn(
                "inline-flex items-center justify-center rounded-md p-1.5",
                "text-muted-foreground hover:text-foreground hover:bg-muted",
                "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                activityOpen &&
                  "text-indigo-600 bg-indigo-50 hover:bg-indigo-100 hover:text-indigo-700",
              )}
            >
              <PanelRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </Tip>
        </div>

        {/* Search bar */}
        {searchOpen && (
          <MessageSearch
            messages={messages}
            onHighlight={handleSearchHighlight}
            onQueryChange={setSearchQuery}
            onClose={handleCloseSearch}
          />
        )}

        {/* Message list */}
        {activeConversationId ? (
          <div className="flex-1 overflow-hidden">
            <MessageList
              key={activeConversationId}
              projectId={projectId}
              messages={messages}
              isStreaming={isStreaming}
              streamingContent={streamingContent}
              streamingMessageId={streamingMessageId}
              activeAgentCount={runningAgentCount}
              highlightedMessageId={highlightedMessageId}
              searchQuery={searchQuery}
              loading={messagesLoading}
              onSend={handleSend}
              fontSizePercent={fontSizePercent}
            />
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-muted/50">
            <p className="text-sm text-muted-foreground">Select or create a conversation to get started</p>
          </div>
        )}

        {/* Shell approval requests */}
        {shellApprovalRequests.length > 0 && (
          <div className="px-4 py-2 space-y-2 border-t border-border bg-background max-h-48 overflow-y-auto">
            {shellApprovalRequests.map((req) => (
              <ShellApprovalCard
                key={req.requestId}
                request={req}
                onDismiss={(id) => useChatStore.setState((prev) => ({
                  shellApprovalRequests: prev.shellApprovalRequests.filter((r) => r.requestId !== id),
                }))}
              />
            ))}
          </div>
        )}

        {/* Context usage bar + Chat input */}
        <div>
          <ChatInput
            ref={chatInputRef}
            projectId={projectId}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isBusy}
            disabled={!activeConversationId || isCompacting}
            placeholder="Message Project Manager..."
            onClear={handleSlashClear}
            onNew={handleCreateConversation}
            onFork={handleSlashFork}
            activeConversationId={activeConversationId}
            contextUtilization={contextUtilization}
            queuedMessages={queuedMessages}
            onRemoveQueued={removeQueued}
          />
          <ModelSelector
            projectId={projectId}
            messages={messages.filter((m) => m.conversationId === activeConversationId)}
          />
        </div>
      </div>

      {/* Resize handle + Activity Pane */}
      {activityOpen && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize activity pane"
            tabIndex={0}
            onMouseDown={handleResizeStart}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                setActivityWidth((w) =>
                  Math.min(ACTIVITY_WIDTH_MAX, w + 10),
                );
              } else if (e.key === "ArrowRight") {
                setActivityWidth((w) =>
                  Math.max(ACTIVITY_WIDTH_MIN, w - 10),
                );
              }
            }}
            className={cn(
              "w-1 cursor-col-resize shrink-0 max-md:hidden",
              "bg-border hover:bg-indigo-400 active:bg-indigo-500",
              "transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500",
            )}
          />

          <div
            style={{ width: activityWidth }}
            className="flex-shrink-0 overflow-hidden bg-muted/50 border-l border-border max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:!w-[85vw] max-md:max-w-[340px] max-md:bg-background max-md:shadow-xl"
            aria-label="Context panel"
          >
            <ContextPanel projectId={projectId} />
          </div>
        </>
      )}
    </div>
  );
}
