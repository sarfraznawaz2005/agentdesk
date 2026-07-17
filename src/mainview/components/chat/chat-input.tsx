/* eslint-disable react-refresh/only-export-components */
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Square, Paperclip, Server, X, FileText, Music, Sparkles, AlertCircle, RefreshCw, WifiOff, Clock, ChevronDown, ChevronUp, Library } from "lucide-react";
import { MESSAGE_QUEUE_MAX, type QueuedMessage } from "@/stores/message-queue";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "../../lib/utils";
import { PromptsDropdown } from "./prompts-dropdown";
import { VoiceInputButton } from "./voice-input-button";
import { useVoiceInput } from "../../lib/use-voice-input";
import { rpc } from "../../lib/rpc";
import { useChatStore } from "../../stores/chat-store";
import { Tip } from "@/components/ui/tooltip";
import { AttachNoteModal } from "@/components/collections/attach-note-modal";
import {
  useInputPopover,
  SLASH_COMMANDS,
  buildFileItem,
  type PopoverItem,
} from "./chat-input-popover";

export interface ChatInputHandle {
  setValue: (v: string) => void;
  addFiles: (files: File[]) => void;
  focus: () => void;
}

interface ChatInputProps {
  projectId: string;
  onSend: (content: string, attachments?: AttachmentFile[], mentionedFilePaths?: string[]) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  onInputChange?: (value: string) => void;
  placeholder?: string;
  // Slash command callbacks
  onClear?: () => void;
  onNew?: () => void;
  onFork?: () => void;
  onCompact?: () => void;
  activeConversationId?: string | null;
  /** Context utilization percentage (0-100) for conditional /compact visibility */
  contextUtilization?: number;
  /** Messages waiting to be sent once the PM becomes idle. */
  queuedMessages?: QueuedMessage[];
  /** Remove a specific queued message by id. */
  onRemoveQueued?: (id: string) => void;
}

export const TEXT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "json", "jsonc", "yaml", "yml", "toml", "xml", "csv", "tsv",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "rs", "go", "java", "kt", "swift",
  "c", "cpp", "h", "hpp", "cs", "php", "sh", "bash", "zsh", "fish",
  "html", "htm", "css", "scss", "sass", "less", "sql", "graphql", "gql",
  "env", "ini", "cfg", "conf", "properties", "log", "diff", "patch",
  "r", "lua", "pl", "pm", "ex", "exs", "erl", "hs", "ml", "mli", "scala", "clj",
  "vue", "svelte", "astro", "prisma", "proto", "tf", "hcl",
  "makefile", "dockerfile", "vagrantfile", "gemfile", "rakefile",
]);

export const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
  "jfif", "pjp", "pjpeg", "jpe",
]);

export const BINARY_DOC_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "odt", "ods", "odp", "rtf", "epub",
  "zip", "tar", "gz", "7z", "rar",
]);

// Only formats the read_audio tool (and the AI SDK's OpenAI-compatible audio
// input) actually accepts — wav and mp3. Anything else is rejected with a
// clear error rather than silently mis-delivered; transcoding other formats
// would need an ffmpeg-class dependency this app doesn't carry.
export const AUDIO_EXTENSIONS = new Set(["wav", "mp3"]);

export type AttachmentType = "text" | "image" | "audio" | "binary";

export interface AttachmentFile {
  name: string;
  type: AttachmentType;
  /** Text content (for text files) or data URL (for image previews) */
  content: string;
  /** Original File object for saving to backend */
  file?: File;
  /** Size in bytes */
  size: number;
}

export function categorizeFile(name: string): AttachmentType {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "text"; // No extension — likely Dockerfile, Makefile, etc.
  const ext = name.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (BINARY_DOC_EXTENSIONS.has(ext)) return "binary";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "binary";
}

/** Build accept string for file input — all supported types */
const ACCEPT_ALL = [
  ...Array.from(TEXT_EXTENSIONS).map(e => `.${e}`),
  ...Array.from(IMAGE_EXTENSIONS).map(e => `.${e}`),
  ...Array.from(AUDIO_EXTENSIONS).map(e => `.${e}`),
  ...Array.from(BINARY_DOC_EXTENSIONS).map(e => `.${e}`),
].join(",");

/** Process files into AttachmentFile objects based on their type */
async function processFiles(files: File[]): Promise<AttachmentFile[]> {
  const results: AttachmentFile[] = [];
  for (const file of files) {
    const type = categorizeFile(file.name);
    if (type === "text") {
      results.push({ name: file.name, type, content: await file.text(), file, size: file.size });
    } else if (type === "image") {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      results.push({ name: file.name, type, content: dataUrl, file, size: file.size });
    } else {
      results.push({ name: file.name, type, content: "", file, size: file.size });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({
  projectId,
  onSend,
  onStop,
  isStreaming,
  disabled,
  onInputChange,
  placeholder,
  onClear,
  onNew,
  onFork,
  onCompact: _onCompact,
  activeConversationId,
  contextUtilization = 0,
  queuedMessages = [],
  onRemoveQueued,
}, ref) {
  // Seed from the persisted draft for the conversation we mount on, so a
  // typed-but-unsent message survives navigation / tab switches / restart.
  const [value, setValue] = useState(
    () => (activeConversationId ? useChatStore.getState().drafts[activeConversationId] ?? "" : ""),
  );
  const setDraft = useChatStore((s) => s.setDraft);
  // Track which conversation `value` belongs to. On a conversation switch, swap
  // in that conversation's saved draft during render (React's "adjust state when
  // a prop changes" pattern) — the outgoing draft was already persisted by the
  // effect below on each keystroke, so `value` and `draftConv` stay a consistent
  // pair without a stale-value window.
  const [draftConv, setDraftConv] = useState<string | null>(activeConversationId ?? null);
  if ((activeConversationId ?? null) !== draftConv) {
    const nextConv = activeConversationId ?? null;
    setDraftConv(nextConv);
    setValue(nextConv ? useChatStore.getState().drafts[nextConv] ?? "" : "");
  }
  const [lastSent, setLastSent] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachmentFile[]>([]);
  const [attachNoteOpen, setAttachNoteOpen] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- Input modes --------------------------------------------------------
  const [inputMode, setInputMode] = useState<"normal" | "shell">("normal");
  const [shellExecuting, setShellExecuting] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);

  // ---- Popover state ------------------------------------------------------
  const [popoverMode, setPopoverMode] = useState<null | "slash" | "file">(null);
  const [popoverQuery, setPopoverQuery] = useState("");
  const [fileItems, setFileItems] = useState<PopoverItem[]>([]);
  const filesCacheRef = useRef<PopoverItem[] | null>(null);
  const fileDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ChatInput lives inside ChatLayout, which stays mounted across a project
  // switch (ProjectPage always force-selects the Chat tab). Without this, the
  // "no query" @-mention cache populated for one project would silently keep
  // being served for a different project after switching, since the cache
  // check (`!query && filesCacheRef.current`) has no project awareness.
  useEffect(() => {
    filesCacheRef.current = null;
  }, [projectId]);

  // Same reasoning: an in-flight async action (enhance prompt) that spans a
  // project/conversation switch must not apply its result to whatever is now
  // showing. Tracked in refs (not state) so the async callback can read the
  // LATEST value after its await, not the one captured when it started.
  const projectIdRef = useRef(projectId);
  useEffect(() => { projectIdRef.current = projectId; });
  const activeConversationIdRef = useRef(activeConversationId);
  useEffect(() => { activeConversationIdRef.current = activeConversationId; });

  // ---- Mentioned files (@ references) ------------------------------------
  const [mentionedFiles, setMentionedFiles] = useState<string[]>([]);

  // Clear attachments/mentions on a genuine conversation switch too — same
  // "adjust state when a prop changes" render-time pattern as the draft swap
  // above (reusing that same draftConv comparison, which hasn't been updated
  // to its new value yet within this render). Otherwise a file attached or an
  // @-mention typed in conversation A would silently carry over into B's
  // input and, if sent there, get attached to the wrong conversation.
  if ((activeConversationId ?? null) !== draftConv) {
    if (attachedFiles.length > 0) setAttachedFiles([]);
    if (mentionedFiles.length > 0) setMentionedFiles([]);
    // Also close the slash/file popover — otherwise switching conversations
    // (e.g. clicking "New Conv") while it's open leaves it stuck open, now
    // floating over an input that's no longer the one the user was typing in.
    if (popoverMode !== null) setPopoverMode(null);
    if (popoverQuery !== "") setPopoverQuery("");
  }

  // ---- Shell result bubbles (ephemeral, in-chat) -------------------------
  // Managed by parent via onShellResult callback — we just execute and report

  useImperativeHandle(ref, () => ({
    focus: () => {
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    setValue: (v: string) => {
      setValue(v);
      onInputChange?.(v);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    addFiles: async (files: File[]) => {
      if (files.length === 0) return;
      const newAttachments = await processFiles(files);
      if (newAttachments.length > 0) {
        setAttachedFiles((prev) => [...prev, ...newAttachments]);
      }
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  }));

  // MCP server count + config (for /mcp command)
  const [mcpCount, setMcpCount] = useState(0);
  const [mcpServers, setMcpServers] = useState<Record<string, { command: string; args?: string[]; disabled?: boolean }>>({});
  const [mcpLiveStatus, setMcpLiveStatus] = useState<Record<string, "connected" | "connecting" | "failed" | "disabled">>({});
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [mcpActionLoading, setMcpActionLoading] = useState<string | null>(null);

  const refreshMcpStatus = useCallback(() => {
    rpc.getMcpStatus().then((status) => {
      setMcpLiveStatus(status);
      setMcpCount(Object.values(status).filter((s) => s === "connected").length);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([rpc.getMcpConfig(), rpc.getMcpStatus()]).then(([cfg, status]) => {
      setMcpServers(cfg.servers);
      setMcpLiveStatus(status);
      setMcpCount(Object.values(status).filter((s) => s === "connected").length);
    }).catch(() => {});
  }, []);

  // Poll status every 5s when dialog is open
  useEffect(() => {
    if (!mcpDialogOpen) return;
    const id = setInterval(refreshMcpStatus, 5_000);
    return () => clearInterval(id);
  }, [mcpDialogOpen, refreshMcpStatus]);

  const handleMcpReconnect = useCallback(async (name: string) => {
    setMcpActionLoading(name);
    await rpc.reconnectMcpServer(name).catch(() => {});
    setTimeout(() => { refreshMcpStatus(); setMcpActionLoading(null); }, 2_000);
  }, [refreshMcpStatus]);

  const handleMcpDisconnect = useCallback(async (name: string) => {
    setMcpActionLoading(name);
    await rpc.disconnectMcpServer(name).catch(() => {});
    setTimeout(() => { refreshMcpStatus(); setMcpActionLoading(null); }, 500);
  }, [refreshMcpStatus]);

  // Focus the textarea when the input becomes enabled. Deferred via
  // requestAnimationFrame — every other imperative focus() call in this file
  // already does this; this was the one holdout, calling focus() synchronously
  // inside the effect. That's fine once the page has been open and painting
  // for a while (normal project chat, opened by clicking inside an already-
  // warm, already-focused main window), but on a brand-new Quick Chat window
  // this effect can fire before the page's first paint has settled — the
  // DOM-level focus() call still succeeds (document.activeElement genuinely
  // becomes the textarea, confirmed by the CSS focus-within ring rendering),
  // but WebView2 hadn't finished wiring up real keyboard input routing for
  // the still-settling page yet, so typing silently did nothing until the
  // user's own click forced a fresh, real focus event. Waiting a frame gives
  // the first paint time to complete first.
  useEffect(() => {
    if (!disabled) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [disabled]);

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // ---- Draft persistence ---------------------------------------------------
  // Persist every change to the current conversation's draft. Covers all sources
  // that mutate `value` (typing, slash resets, enhance, imperative setValue) and
  // clears the draft on send (value → ""). The draft swap on conversation switch
  // is handled during render above, so `value` and `draftConv` are always a
  // consistent pair here — no risk of writing one conversation's text under
  // another's key.
  useEffect(() => {
    if (draftConv) setDraft(draftConv, value);
  }, [value, draftConv, setDraft]);

  // ---- File search for @ mentions -----------------------------------------
  const searchFiles = useCallback((query: string) => {
    if (fileDebounceRef.current) clearTimeout(fileDebounceRef.current);
    const searchProjectId = projectId;
    fileDebounceRef.current = setTimeout(async () => {
      try {
        // Use cache if no query and already fetched
        if (!query && filesCacheRef.current) {
          setFileItems(filesCacheRef.current);
          return;
        }
        const files = await rpc.searchWorkspaceFiles(searchProjectId, query || undefined);
        // The debounce timer itself isn't cancelled on a project switch (only
        // the cache is cleared, above) — without this check, a slow search
        // for the OLD project could still resolve after switching and
        // populate the @-mention popover with the wrong project's files.
        if (projectIdRef.current !== searchProjectId) return;
        const items = files.map(buildFileItem);
        if (!query) filesCacheRef.current = items;
        setFileItems(items);
      } catch {
        if (projectIdRef.current === searchProjectId) setFileItems([]);
      }
    }, query ? 150 : 0); // Instant for initial load, debounced for search
  }, [projectId]);

  // ---- Popover detection on input change -----------------------------------
  const handleInputChange = useCallback((newValue: string) => {
    setValue(newValue);
    onInputChange?.(newValue);

    // Skip popover detection in shell mode
    if (inputMode === "shell") {
      setPopoverMode(null);
      return;
    }

    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? newValue.length;
    const textBeforeCursor = newValue.substring(0, cursorPos);

    // Check for @ mention (anywhere in text, after space or at start)
    const atMatch = textBeforeCursor.match(/(^|[\s])@([^\s]*)$/);
    if (atMatch) {
      const query = atMatch[2];
      setPopoverMode("file");
      setPopoverQuery(query);
      searchFiles(query);
      return;
    }

    // Check for / slash command (only at start of input, no other text)
    const slashMatch = newValue.match(/^\/(\S*)$/);
    if (slashMatch) {
      setPopoverMode("slash");
      setPopoverQuery(slashMatch[1]);
      return;
    }

    // No match — close popover
    if (popoverMode) {
      setPopoverMode(null);
      setPopoverQuery("");
    }

    // Sync mentioned files — remove any that are no longer in the text
    setMentionedFiles((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.filter((f) => newValue.includes(`@${f}`));
      return next.length === prev.length ? prev : next;
    });
  }, [inputMode, popoverMode, searchFiles, onInputChange]);

  // ---- Voice input (Web Speech API) ---------------------------------------
  // Declared here (before handleSend below) because handleSend's useCallback
  // dependency array references `voice` — deps arrays evaluate immediately every
  // render, unlike a callback body, so `voice` must already be initialized by
  // the time that array is evaluated (TDZ — see aitasks TASK-548 notes).
  const voice = useVoiceInput(value, handleInputChange, () => requestAnimationFrame(() => textareaRef.current?.focus()));

  // ---- Filtered slash commands (hide /compact below 50% utilization) --------
  const visibleSlashCommands = useMemo(
    () => SLASH_COMMANDS.filter((cmd) => cmd.id !== "compact" || contextUtilization >= 50),
    [contextUtilization],
  );

  // ---- Popover hooks -------------------------------------------------------
  const slashPopover = useInputPopover({
    items: visibleSlashCommands,
    visible: popoverMode === "slash",
    query: popoverQuery,
    onSelect: handleSlashSelect,
    onClose: () => { setPopoverMode(null); setPopoverQuery(""); },
  });

  const filePopover = useInputPopover({
    items: fileItems,
    visible: popoverMode === "file",
    query: popoverQuery,
    onSelect: handleFileSelect_mention,
    onClose: () => { setPopoverMode(null); setPopoverQuery(""); },
    selectedIds: mentionedFiles,
  });

  // ---- Slash command execution ---------------------------------------------
  function handleSlashSelect(item: PopoverItem) {
    setPopoverMode(null);
    setPopoverQuery("");
    setValue("");
    onInputChange?.("");

    switch (item.id) {
      case "clear":
        onClear?.();
        break;
      case "compact": {
        if (activeConversationId) {
          const startConversationId = activeConversationId;
          setCompacting(true);
          setCompactError(null);
          rpc.compactConversation(projectId, activeConversationId)
            .then((result) => {
              // The user may have switched conversations while this was in
              // flight — its error banner (or the compacting spinner cleared
              // below) belongs to `startConversationId`, not whatever's shown now.
              if (activeConversationIdRef.current !== startConversationId) return;
              if (!result.success && result.message) {
                setCompactError(result.message);
                setTimeout(() => setCompactError(null), 3000);
              }
            })
            .catch(() => {})
            .finally(() => {
              if (activeConversationIdRef.current === startConversationId) setCompacting(false);
            });
        }
        break;
      }
      case "fork":
        onFork?.();
        break;
      case "init":
        onSend("Analyze this project's codebase thoroughly and create a comprehensive AGENTS.md file in the project root. Include: project overview, tech stack, directory structure, key files, build commands, and any patterns you discover.");
        break;
      case "mcp": {
        // Show MCP info as ephemeral bubble (not sent to AI)
        const entries = Object.entries(mcpServers);
        let mcpText: string;
        if (entries.length === 0) {
          mcpText = "No MCP servers configured.";
        } else {
          const lines = entries.map(([name, s]) => {
            const status = s.disabled ? "disabled" : "enabled";
            return `  ${name}: ${s.command} (${status})`;
          });
          mcpText = lines.join("\n");
        }
        onSend(`__shell__${JSON.stringify({ command: "mcp status", output: mcpText, exitCode: 0, isError: false })}`);
        break;
      }
      case "info":
        onSend("/info");
        break;
      case "new":
        onNew?.();
        break;
      case "preview":
        onSend("/preview");
        break;
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  // ---- @ file mention selection (toggle) ------------------------------------
  function handleFileSelect_mention(item: PopoverItem) {
    setPopoverMode(null);
    setPopoverQuery("");

    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? value.length;
    const textBeforeCursor = value.substring(0, cursorPos);
    const textAfterCursor = value.substring(cursorPos);

    // Toggle: if already mentioned, remove it
    if (mentionedFiles.includes(item.id)) {
      const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const newValue = value.replace(new RegExp(`@${escaped}\\s?`, "g"), "").trim();
      setValue(newValue);
      onInputChange?.(newValue);
      setMentionedFiles((prev) => prev.filter((f) => f !== item.id));
      requestAnimationFrame(() => textarea?.focus());
      return;
    }

    // Add: replace @query with @filepath in the text
    const atMatch = textBeforeCursor.match(/(^|[\s])@([^\s]*)$/);
    if (atMatch) {
      const matchStart = textBeforeCursor.length - atMatch[0].length + (atMatch[1].length);
      const before = value.substring(0, matchStart);
      const inserted = `@${item.id} `;
      const newValue = before + inserted + textAfterCursor;
      setValue(newValue);
      onInputChange?.(newValue);

      setMentionedFiles((prev) => [...prev, item.id]);

      // Set cursor after inserted text
      requestAnimationFrame(() => {
        if (textarea) {
          const newPos = before.length + inserted.length;
          textarea.selectionStart = newPos;
          textarea.selectionEnd = newPos;
          textarea.focus();
        }
      });
    }
  }

  // ---- File attachment handling --------------------------------------------
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      const newAttachments = await processFiles(files);
      if (newAttachments.length > 0) {
        setAttachedFiles((prev) => [...prev, ...newAttachments]);
      }
      e.target.value = "";
    },
    [],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Attaching a Collections note reuses the existing text-attachment plumbing
  // (chip rendering, removal, saveAttachment + implicit-context injection on
  // send) — it's just an AttachmentFile whose content came from a note instead
  // of a picked File. getNoteContentForContext is read-only, so the note itself
  // is never modified by attaching it.
  const handleAttachNote = useCallback((note: { id: string; title: string; contentMarkdown: string }) => {
    setAttachedFiles((prev) => [
      ...prev,
      {
        name: `${note.title || "Untitled note"}.md`,
        type: "text",
        content: note.contentMarkdown,
        size: note.contentMarkdown.length,
      },
    ]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // ---- Shell mode execution -----------------------------------------------
  const executeShell = useCallback(async (command: string) => {
    if (!command.trim() || shellExecuting) return;
    setShellExecuting(true);
    setValue("");
    onInputChange?.("");

    try {
      const result = await rpc.executeShellCommand(projectId, command);
      const isError = result.exitCode !== 0;
      const output = result.stderr && !result.stdout
        ? result.stderr
        : result.stdout + (result.stderr ? "\n" + result.stderr : "");

      // Insert as a special shell result message via onSend with a prefix the parent can detect
      onSend(`__shell__${JSON.stringify({ command, output: output || "(no output)", exitCode: result.exitCode, isError })}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onSend(`__shell__${JSON.stringify({ command, output: msg, exitCode: 1, isError: true })}`);
    }

    setShellExecuting(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [projectId, shellExecuting, onSend, onInputChange]);

  // ---- Send handler (normal mode) -----------------------------------------
  const handleSend = useCallback(() => {
    // If voice input is still listening when the user sends (button click or
    // Enter), stop it — otherwise the mic keeps capturing silently in the
    // background after the message has already gone out.
    voice.stop();

    if (inputMode === "shell") {
      executeShell(value);
      return;
    }

    const trimmed = value.trim();
    if ((!trimmed && attachedFiles.length === 0) || disabled) return;

    // Strip @mentions from visible text (keep the rest)
    let visibleText = trimmed;
    for (const f of mentionedFiles) {
      visibleText = visibleText.replace(new RegExp(`@${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s?`, "g"), "");
    }
    visibleText = visibleText.trim() || trimmed;

    onSend(
      visibleText,
      attachedFiles.length > 0 ? attachedFiles : undefined,
      mentionedFiles.length > 0 ? [...mentionedFiles] : undefined,
    );
    setLastSent(trimmed);
    setValue("");
    setAttachedFiles([]);
    setMentionedFiles([]);
    onInputChange?.("");
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.focus();
      }
    });
  }, [value, inputMode, attachedFiles, disabled, mentionedFiles, onSend, onInputChange, executeShell, voice]);

  // ---- Keyboard handler ----------------------------------------------------
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Let popover handle keys first
    if (popoverMode === "slash" && slashPopover.handleKeyDown(e)) return;
    if (popoverMode === "file" && filePopover.handleKeyDown(e)) return;

    // Shell mode: ! entry
    if (inputMode === "normal" && e.key === "!" && value === "") {
      e.preventDefault();
      setInputMode("shell");
      setPopoverMode(null);
      return;
    }

    // Shell mode: exit on Escape
    if (inputMode === "shell" && e.key === "Escape") {
      e.preventDefault();
      setInputMode("normal");
      setValue("");
      onInputChange?.("");
      return;
    }

    // Shell mode: exit on Backspace when empty
    if (inputMode === "shell" && e.key === "Backspace" && value === "") {
      e.preventDefault();
      setInputMode("normal");
      return;
    }

    // Normal mode: Escape closes popover or does nothing
    if (e.key === "Escape" && popoverMode) {
      e.preventDefault();
      setPopoverMode(null);
      setPopoverQuery("");
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    // Up arrow when textarea is empty → recall last sent message
    if (e.key === "ArrowUp" && value === "" && lastSent && inputMode === "normal") {
      e.preventDefault();
      setValue(lastSent);
    }
  };

  // ---- Enhance prompt -----------------------------------------------------
  const handleEnhance = useCallback(async () => {
    const trimmed = value.trim();
    if (trimmed.length < 25 || enhancing) return;
    const startProjectId = projectId;
    const startConversationId = activeConversationId;
    setEnhancing(true);
    setEnhanceError(null);
    try {
      const s = await rpc.getProjectSettings(projectId) as Record<string, string>;
      const result = await rpc.enhancePrompt(
        projectId,
        trimmed,
        s.chatProviderId || undefined,
        s.chatModelId || undefined,
      );
      // A project/conversation switch during this round-trip must not insert
      // the enhanced text (based on the OLD project's settings/context) into
      // whatever conversation is now showing.
      if (projectIdRef.current !== startProjectId || activeConversationIdRef.current !== startConversationId) {
        return;
      }
      if (result.enhanced) {
        setValue(result.enhanced);
        onInputChange?.(result.enhanced);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setEnhanceError(msg || "Failed to enhance prompt");
    }
    setEnhancing(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [value, enhancing, projectId, activeConversationId, onInputChange]);

  const isQueueFull = queuedMessages.length >= MESSAGE_QUEUE_MAX;
  const canEnhance = value.trim().length >= 25 && !isStreaming && !disabled && inputMode === "normal" && !compacting;
  const canSend = inputMode === "shell"
    ? value.trim().length > 0 && !shellExecuting
    : (value.trim().length > 0 || attachedFiles.length > 0) && !disabled && !enhancing && !compacting && !(isStreaming && isQueueFull);
  const hasInput = value.trim().length > 0 || attachedFiles.length > 0;

  const isShellMode = inputMode === "shell";

  // Placeholder text
  const placeholderText = enhancing
    ? "Enhancing prompt..."
    : isShellMode
      ? "Enter shell command..."
      : (placeholder ?? "Message Project Manager...");

  return (
    <div className="px-4 pt-3 pb-1">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT_ALL}
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* MCP + queue count row */}
      {(Object.keys(mcpServers).length > 0 || queuedMessages.length > 0) && !isShellMode && (
        <div className="flex items-center justify-between mb-1.5 px-1">
          {Object.keys(mcpServers).length > 0 ? (
            <button
              onClick={() => setMcpDialogOpen(true)}
              className="inline-flex items-center gap-1 text-xs text-foreground/75 font-semibold hover:text-foreground transition-colors cursor-pointer"
            >
              <Server className="w-3 h-3" />
              {mcpCount}/{Object.keys(mcpServers).length} MCP server{Object.keys(mcpServers).length !== 1 ? "s" : ""}
            </button>
          ) : <span />}

          {queuedMessages.length > 0 && (
            <button
              type="button"
              onClick={() => setQueueExpanded((v) => !v)}
              className="inline-flex items-center gap-1 text-xs text-amber-600 font-semibold hover:text-amber-700 transition-colors"
            >
              <Clock className="w-3 h-3 text-amber-500" />
              {queuedMessages.length} queued{isQueueFull ? " (full)" : ""}
              {queueExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>
      )}

      {/* MCP servers dialog */}
      <Dialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Server className="w-4 h-4" />
              MCP Servers
            </DialogTitle>
          </DialogHeader>
          <ul className="space-y-3 mt-1 min-w-0">
            {Object.entries(mcpServers).map(([name, cfg]) => {
              const status = mcpLiveStatus[name] ?? (cfg.disabled ? "disabled" : "failed");
              const isLoading = mcpActionLoading === name;
              const isConnected = status === "connected";
              const isConnecting = status === "connecting";
              return (
                <li key={name} className="flex items-center gap-3">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${
                    isConnected ? "bg-green-500" :
                    isConnecting ? "bg-yellow-400 animate-pulse" :
                    status === "failed" ? "bg-red-500" : "bg-muted-foreground/50"
                  }`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {cfg.command} {(cfg.args ?? []).join(" ")}
                    </p>
                  </div>
                  <span className={`text-xs shrink-0 ${
                    isConnected ? "text-green-600" :
                    isConnecting ? "text-yellow-600" :
                    status === "failed" ? "text-red-500" : "text-muted-foreground"
                  }`}>
                    {isConnecting ? "connecting…" : status}
                  </span>
                  {isConnected ? (
                    <button
                      onClick={() => handleMcpDisconnect(name)}
                      disabled={isLoading}
                      className="shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors disabled:opacity-50"
                    >
                      {isLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <WifiOff className="w-3 h-3" />}
                      Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => handleMcpReconnect(name)}
                      disabled={isLoading || isConnecting || cfg.disabled}
                      className="shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors disabled:opacity-50"
                    >
                      {isLoading || isConnecting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                      Connect
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>

      {/* Attach a note dialog */}
      <AttachNoteModal open={attachNoteOpen} onOpenChange={setAttachNoteOpen} onAttach={handleAttachNote} />

      {/* Compacting indicator */}
      {compacting && (
        <div className="flex items-center gap-2 mb-1.5 px-2 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
          <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="font-semibold">Compacting conversation...</span>
        </div>
      )}

      {/* Character count + shell mode hint */}
      {(isShellMode || (!isShellMode && value.length > 0)) && (
        <div className="flex justify-end px-1 pb-1">
          {isShellMode && (
            <span className="text-[10px] text-red-400 mr-auto">
              Press Escape to exit shell mode
            </span>
          )}
          {!isShellMode && value.length > 0 && (
            <span
              className={cn(
                "text-[11px] tabular-nums font-semibold",
                value.length > 10000 ? "text-red-400" : "text-muted-foreground/60",
              )}
            >
              {value.length.toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* Expanded queue list */}
      {!isShellMode && queueExpanded && queuedMessages.length > 0 && (
        <div className="mb-2 px-1 flex flex-col gap-1">
          {queuedMessages.map((m, i) => (
            <div
              key={m.id}
              className="flex items-start gap-1.5 px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800"
            >
              <span className="shrink-0 font-semibold text-amber-500 mt-px">{i + 1}.</span>
              <span className="flex-1 break-words">{m.content}</span>
              <button
                type="button"
                aria-label="Remove queued message"
                onClick={() => onRemoveQueued?.(m.id)}
                className="shrink-0 mt-px text-amber-400 hover:text-amber-700 transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main input container — relative for popover positioning */}
      <div className="relative">
        {/* Popovers (rendered above input) */}
        {slashPopover.popoverElement}
        {filePopover.popoverElement}

        <div
          className={cn(
            "flex items-center gap-2 rounded-xl border px-3 py-1.5 transition-colors",
            isShellMode
              ? "border-red-300 bg-red-50/50 focus-within:ring-1 focus-within:ring-red-400 focus-within:border-red-400"
              : "border-border bg-background focus-within:ring-1 focus-within:ring-indigo-400 focus-within:border-indigo-400",
            enhancing && "bg-muted/50 opacity-75",
          )}
        >
          {/* Attach button — hidden in shell mode */}
          {!isShellMode && (
            <Tip content="Attach file" side="top">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex-shrink-0 p-1.5 text-muted-foreground/60 hover:text-muted-foreground rounded-lg hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60"
                disabled={isStreaming || disabled || enhancing}
              >
                <Paperclip className="w-4 h-4" />
              </button>
            </Tip>
          )}

          {/* Attach a note — hidden in shell mode */}
          {!isShellMode && (
            <Tip content="Attach a note" side="top">
              <button
                type="button"
                onClick={() => setAttachNoteOpen(true)}
                className="flex-shrink-0 p-1.5 text-muted-foreground/60 hover:text-muted-foreground rounded-lg hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60"
                disabled={isStreaming || disabled || enhancing}
              >
                <Library className="w-4 h-4" />
              </button>
            </Tip>
          )}

          {/* Prompts library — hidden in shell mode */}
          {!isShellMode && (
            <PromptsDropdown
              onSelect={(content) => { setValue((prev) => prev + content); onInputChange?.(value + content); }}
              disabled={isStreaming || disabled || enhancing}
            />
          )}

          {/* Shell mode indicator */}
          {isShellMode && (
            <span className="flex-shrink-0 text-red-500 font-mono text-sm font-bold py-1">$</span>
          )}

          {/* Attached file chips */}
          {!isShellMode && attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 flex-1">
              {attachedFiles.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-indigo-50 border border-indigo-200 text-xs text-indigo-700 max-w-[200px]"
                >
                  {f.type === "image" && f.content ? (
                    <img src={f.content} alt={f.name} className="w-8 h-8 rounded object-cover shrink-0" />
                  ) : f.type === "audio" ? (
                    <Music className="w-3.5 h-3.5 shrink-0" />
                  ) : f.type === "binary" ? (
                    <FileText className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <Paperclip className="w-3 h-3 shrink-0" />
                  )}
                  <span className="truncate">{f.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    className="shrink-0 hover:text-indigo-900"
                    aria-label={`Remove ${f.name}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {/* Textarea in-line when chips present */}
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholderText}
                disabled={disabled || enhancing || compacting}
                rows={1}
                className={cn(
                  "flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60",
                  "focus:outline-none min-h-[24px] max-h-[200px] py-0.5 min-w-[80px]",
                  (disabled || enhancing || compacting) && "opacity-50",
                )}
              />
            </div>
          )}

          {/* Textarea (no attachments or shell mode) */}
          {(isShellMode || attachedFiles.length === 0) && !(attachedFiles.length > 0 && !isShellMode) && (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholderText}
              disabled={(disabled && !isShellMode) || enhancing || shellExecuting || compacting}
              rows={1}
              className={cn(
                "flex-1 resize-none bg-transparent text-sm placeholder:text-muted-foreground/60",
                "focus:outline-none min-h-[24px] max-h-[200px] py-0.5",
                isShellMode ? "font-mono text-red-900 placeholder:text-red-400" : "text-foreground",
                (disabled || enhancing) && "opacity-50",
              )}
            />
          )}

          {/* Voice input — hidden in shell mode, or entirely if this webview has no speech engine */}
          {!isShellMode && voice.supported && (
            <VoiceInputButton
              listening={voice.listening}
              error={voice.error}
              onClick={voice.toggle}
              disabled={isStreaming || disabled || enhancing}
            />
          )}

          {/* Enhance prompt button — not in shell mode */}
          {!isShellMode && (canEnhance || enhancing) && (
            <Tip content={enhancing ? "Enhancing..." : "Enhance prompt"} side="top">
              <button
                type="button"
                onClick={handleEnhance}
                disabled={enhancing}
                className={cn(
                  "flex-shrink-0 p-1.5 rounded-lg transition-colors",
                  enhancing
                    ? "text-indigo-500 cursor-wait"
                    : "text-muted-foreground/60 hover:text-indigo-600 hover:bg-indigo-50",
                )}
                aria-label="Enhance prompt"
              >
                <Sparkles className={cn("w-4 h-4", enhancing && "animate-spin")} />
              </button>
            </Tip>
          )}

          {/* Send / Stop buttons */}
          {isStreaming && !hasInput && !isShellMode && (
            <Tip content="Stop generation" side="top">
              <button
                type="button"
                onClick={onStop}
                className="flex-shrink-0 p-1.5 rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors"
                aria-label="Stop generation"
              >
                <Square className="w-4 h-4" fill="currentColor" />
              </button>
            </Tip>
          )}
          {(isShellMode || !isStreaming || hasInput) && (
            <Tip content={isShellMode ? "Run command" : (isStreaming && hasInput ? (isQueueFull ? `Queue full (${MESSAGE_QUEUE_MAX}/${MESSAGE_QUEUE_MAX})` : "Add to queue") : "Send message")} side="top">
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className={cn(
                  "flex-shrink-0 p-1.5 rounded-full transition-colors",
                  canSend
                    ? isShellMode
                      ? "bg-red-500 text-white hover:bg-red-600"
                      : "bg-indigo-600 text-white hover:bg-indigo-700"
                    : "bg-muted text-muted-foreground/60 cursor-not-allowed",
                )}
                aria-label={isShellMode ? "Run command" : "Send message"}
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            </Tip>
          )}
        </div>
      </div>

      {/* Mentioned files chips */}
      {mentionedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1 pt-1.5">
          {mentionedFiles.map((f) => (
            <span
              key={f}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-[10px] text-blue-700 font-mono"
            >
              @{f.split(/[/\\]/).pop()}
              <button
                type="button"
                onClick={() => setMentionedFiles((prev) => prev.filter((p) => p !== f))}
                className="hover:text-blue-900"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Enhance error */}
      {enhanceError && (
        <div className="flex items-start gap-2 mx-1 mt-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200">
          <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-red-700">Prompt enhancement failed</p>
            <p className="text-[11px] text-red-600 mt-0.5 break-words">{enhanceError}</p>
          </div>
          <button
            type="button"
            onClick={() => setEnhanceError(null)}
            className="shrink-0 p-0.5 text-red-400 hover:text-red-600 rounded"
            aria-label="Dismiss error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Compact error */}
      {compactError && (
        <div className="flex items-center gap-2 mx-1 mt-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
          <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <span className="text-xs text-amber-700 flex-1">{compactError}</span>
          <button
            type="button"
            onClick={() => setCompactError(null)}
            className="shrink-0 p-0.5 text-amber-400 hover:text-amber-600 rounded"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

    </div>
  );
});
