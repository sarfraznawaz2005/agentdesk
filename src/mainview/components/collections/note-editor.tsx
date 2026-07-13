import { useEffect, useMemo, useState } from "react";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import rehypeSanitize from "rehype-sanitize";
import {
	bold,
	italic,
	strikethrough,
	title,
	quote,
	code,
	unorderedListCommand,
	orderedListCommand,
	checkedListCommand,
	table,
	link,
	divider,
	type ICommand,
} from "@uiw/react-md-editor/commands";
import { FileText, Save, Paperclip, Star, Trash2, Link2, Download, Check } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/date-utils";
import { Tip } from "@/components/ui/tooltip";
import { useCollectionsStore } from "@/stores/collections-store";
import { collectionSourceLabel } from "@/lib/collection-source-label";
import { AttachmentChip } from "./attachment-chip";
import { softDeleteWithUndo } from "./trash-actions";
import { TagEditor } from "./tag-editor";
import type {
	CollectionAttachmentDto,
	CollectionExportFormat,
	CollectionLinkedNoteDto,
	CollectionNoteSourceRef,
	CollectionNoteSourceType,
} from "../../../shared/rpc/collections";

const EXPORT_FORMATS: { value: CollectionExportFormat; label: string }[] = [
	{ value: "markdown", label: "Export as Markdown" },
	{ value: "pdf", label: "Export as PDF" },
	{ value: "json", label: "Export as JSON" },
];

// Trimmed to the approved mockup's toolbar — drops the library's default
// fullscreen/HR/comment/image commands.
const BASE_COMMANDS: ICommand[] = [
	bold,
	italic,
	strikethrough,
	divider,
	title,
	quote,
	code,
	divider,
	unorderedListCommand,
	orderedListCommand,
	checkedListCommand,
	divider,
	table,
	link,
];

// Custom command — NOT the library's default image command. Attachments are
// download-only and never inline-previewed, so this never touches the
// markdown source: it opens the OS picker and lets the note's own attachment
// list (below the editor) pick up the result, rather than inserting any kind
// of ![]() / reference-marker text that a markdown renderer could ever turn
// into an inline preview.
function makeAttachCommand(onClick: () => void): ICommand {
	return {
		name: "attach",
		keyCommand: "attach",
		buttonProps: { "aria-label": "Attach a file", title: "Attach a file" },
		icon: <Paperclip size={12} />,
		execute: () => onClick(),
	};
}

// Same link styling + open-in-default-browser behavior as the main project chat's
// markdown rendering (src/mainview/components/chat/message-bubble.tsx) — MDEditor's
// preview otherwise renders a plain, unstyled anchor whose default click would
// navigate the app's own webview instead of the OS browser. `!` (important)
// modifiers are needed here because @uiw/react-markdown-preview/markdown.css's
// `.wmde-markdown a` rule outranks a plain Tailwind utility class on specificity.
function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
	return (
		<a
			href={href}
			className="!text-blue-800 hover:!text-blue-600 !font-semibold !underline cursor-pointer"
			onClick={(e) => {
				e.preventDefault();
				if (href) rpc.openExternalUrl(href).catch(() => {});
			}}
		>
			{children}
		</a>
	);
}

type PreviewMode = "edit" | "preview" | "live";
const MODES: { value: PreviewMode; label: string }[] = [
	{ value: "edit", label: "Write" },
	{ value: "preview", label: "Preview" },
	{ value: "live", label: "Live" },
];

function ModeSwitch({ mode, onChange }: { mode: PreviewMode; onChange: (m: PreviewMode) => void }) {
	return (
		<div className="flex items-center gap-0.5 bg-secondary rounded-full p-0.5 text-xs shrink-0">
			{MODES.map((m) => (
				<button
					key={m.value}
					type="button"
					onClick={() => onChange(m.value)}
					className={cn(
						"px-2.5 py-1 rounded-full transition-colors",
						mode === m.value
							? "bg-card text-foreground font-semibold shadow-sm"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{m.label}
				</button>
			))}
		</div>
	);
}

// Tracks the app's own light/dark class (src/mainview/lib/theme.ts) so the
// editor's data-color-mode never disagrees with the rest of the UI.
function useIsDarkMode(): boolean {
	const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ theme: "light" | "dark" }>).detail;
			setIsDark(detail.theme === "dark");
		};
		window.addEventListener("agentdesk:theme-changed", handler);
		return () => window.removeEventListener("agentdesk:theme-changed", handler);
	}, []);
	return isDark;
}

export function NoteEditor() {
	const selectedNoteId = useCollectionsStore((s) => s.selectedNoteId);
	const [loading, setLoading] = useState(false);
	const [title_, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [attachments, setAttachments] = useState<CollectionAttachmentDto[]>([]);
	const [linkedNotes, setLinkedNotes] = useState<CollectionLinkedNoteDto[]>([]);
	const [backlinks, setBacklinks] = useState<CollectionLinkedNoteDto[]>([]);
	const [tags, setTags] = useState<string[]>([]);
	const [isFavorite, setIsFavorite] = useState(false);
	const [isDeleted, setIsDeleted] = useState(false);
	const [sourceType, setSourceType] = useState<CollectionNoteSourceType | null>(null);
	const [sourceRef, setSourceRef] = useState<CollectionNoteSourceRef | null>(null);
	const [updatedAt, setUpdatedAt] = useState<string | null>(null);
	const [previewMode, setPreviewMode] = useState<PreviewMode>("preview");
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [attaching, setAttaching] = useState(false);
	const [exporting, setExporting] = useState(false);
	// Persisted default export format (Settings tab's Defaults card is the
	// other entry point) — picking a format here also updates the default.
	const [defaultExportFormat, setDefaultExportFormat] = useState<CollectionExportFormat>("markdown");
	const isDark = useIsDarkMode();
	const setSelectedNote = useCollectionsStore((s) => s.setSelectedNote);
	const setSelectedCollection = useCollectionsStore((s) => s.setSelectedCollection);

	useEffect(() => {
		rpc
			.getSetting("defaultExportFormat", "collections")
			.then((value) => {
				if (value === "markdown" || value === "pdf" || value === "json") setDefaultExportFormat(value);
			})
			.catch((err) => console.error("Failed to load default export format setting:", err));
	}, []);

	useEffect(() => {
		if (!selectedNoteId) {
			setTitle("");
			setContent("");
			setAttachments([]);
			setLinkedNotes([]);
			setBacklinks([]);
			setTags([]);
			setIsFavorite(false);
			setIsDeleted(false);
			setSourceType(null);
			setSourceRef(null);
			setUpdatedAt(null);
			setDirty(false);
			return;
		}
		setLoading(true);
		rpc
			.getCollectionNote({ id: selectedNoteId })
			.then((note) => {
				setTitle(note?.title ?? "");
				setContent(note?.contentMarkdown ?? "");
				setAttachments(note?.attachments ?? []);
				setTags(note?.tags ?? []);
				setIsFavorite(note?.isFavorite ?? false);
				setIsDeleted(note?.isDeleted ?? false);
				setSourceType(note?.sourceType ?? null);
				setSourceRef(note?.sourceRef ?? null);
				setUpdatedAt(note?.updatedAt ?? null);
				setDirty(false);
			})
			.catch((err) => console.error("Failed to load note:", err))
			.finally(() => setLoading(false));
		loadLinks(selectedNoteId);
	}, [selectedNoteId]);

	function loadLinks(noteId: string) {
		rpc.getLinkedNotes({ id: noteId }).then(setLinkedNotes).catch((err) => console.error("Failed to load linked notes:", err));
		rpc.getBacklinks({ id: noteId }).then(setBacklinks).catch((err) => console.error("Failed to load backlinks:", err));
	}

	function navigateToNote(note: CollectionLinkedNoteDto) {
		setSelectedCollection(note.collectionId);
		setSelectedNote(note.id);
	}

	// Fires once the native OS file picker resolves (opened via pickAttachmentFile).
	useEffect(() => {
		if (!selectedNoteId) return;
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ noteId: string; path: string | null }>).detail;
			if (detail.noteId !== selectedNoteId) return;
			if (!detail.path) {
				setAttaching(false);
				return;
			}
			rpc
				.addAttachment({ noteId: selectedNoteId, sourcePath: detail.path })
				.then((res) => {
					if (res.success) setAttachments((prev) => [...prev, res.attachment]);
				})
				.catch((err) => console.error("Failed to attach file:", err))
				.finally(() => setAttaching(false));
		};
		window.addEventListener("agentdesk:collection-attachment-file-picked", handler);
		return () => window.removeEventListener("agentdesk:collection-attachment-file-picked", handler);
	}, [selectedNoteId]);

	// Mirrors the note-list card's own star toggle (a sibling component) back into this pane.
	useEffect(() => {
		if (!selectedNoteId) return;
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ noteId: string; isFavorite: boolean }>).detail;
			if (detail.noteId === selectedNoteId) setIsFavorite(detail.isFavorite);
		};
		window.addEventListener("agentdesk:collection-note-favorite-changed", handler);
		return () => window.removeEventListener("agentdesk:collection-note-favorite-changed", handler);
	}, [selectedNoteId]);

	function handleAttachClick() {
		if (!selectedNoteId || attaching) return;
		setAttaching(true);
		rpc.pickAttachmentFile({ noteId: selectedNoteId }).catch((err) => {
			console.error("Failed to open file picker:", err);
			setAttaching(false);
		});
	}

	function handleAttachmentRemoved(id: string) {
		setAttachments((prev) => prev.filter((a) => a.id !== id));
	}

	async function handleToggleFavorite() {
		if (!selectedNoteId) return;
		try {
			const result = await rpc.toggleFavorite({ id: selectedNoteId });
			if (!result.success) return;
			setIsFavorite(result.isFavorite);
			// Keep the note-list card (a sibling component) in sync without a full reload.
			window.dispatchEvent(
				new CustomEvent("agentdesk:collection-note-favorite-changed", {
					detail: { noteId: selectedNoteId, isFavorite: result.isFavorite },
				}),
			);
		} catch (err) {
			console.error("Failed to toggle favorite:", err);
		}
	}

	async function handleDelete() {
		if (!selectedNoteId) return;
		const noteId = selectedNoteId;
		try {
			const deleted = await softDeleteWithUndo({ id: noteId, title: title_ });
			if (!deleted) return;
			// Keep the note-list card (a sibling component) in sync without a full reload.
			window.dispatchEvent(new CustomEvent("agentdesk:collection-note-trashed", { detail: { noteId } }));
			setSelectedNote(null);
		} catch (err) {
			console.error("Failed to delete note:", err);
		}
	}

	async function handleExport(format: CollectionExportFormat) {
		if (!selectedNoteId || exporting) return;
		setExporting(true);
		setDefaultExportFormat(format);
		rpc.saveSetting("defaultExportFormat", format, "collections").catch((err) => console.error("Failed to save default export format setting:", err));
		try {
			const result = await rpc.exportNote({ id: selectedNoteId, format });
			if (!result.success) throw new Error("exportNote returned success:false");
			toast("success", "Exported — revealed in folder.");
		} catch (err) {
			console.error("Failed to export note:", err);
			toast("error", "Failed to export note.");
		} finally {
			setExporting(false);
		}
	}

	function handleTagsChange(next: string[]) {
		setTags(next);
		setDirty(true);
	}

	const commands = useMemo(() => [...BASE_COMMANDS, makeAttachCommand(handleAttachClick)], [selectedNoteId, attaching]); // eslint-disable-line react-hooks/exhaustive-deps
	const sourceLabel = useMemo(() => collectionSourceLabel(sourceType, sourceRef), [sourceType, sourceRef]);

	async function handleSave() {
		if (!selectedNoteId || !dirty) return;
		setSaving(true);
		try {
			await rpc.updateCollectionNote({
				id: selectedNoteId,
				title: title_.trim() || "Untitled",
				contentMarkdown: content,
				tags,
			});
			setDirty(false);
			setUpdatedAt(new Date().toISOString());
			// Saved content may have added/removed [[wiki-links]] — refresh both
			// this note's outgoing links and (in case a link elsewhere now
			// resolves to this note) its backlinks.
			loadLinks(selectedNoteId);
			// Keep the note-list card (a sibling component) in sync without requiring
			// a manual refresh — mirrors the favorite-changed/trashed/moved events below.
			window.dispatchEvent(new CustomEvent("agentdesk:collection-note-updated", { detail: { noteId: selectedNoteId } }));
		} catch (err) {
			console.error("Failed to save note:", err);
		} finally {
			setSaving(false);
		}
	}

	if (!selectedNoteId) {
		return (
			<div className="flex-1 flex items-center justify-center min-w-0">
				<EmptyState icon={<FileText className="w-5 h-5" />} title="Select a note" description="Choose a note from the list to view or edit it." />
			</div>
		);
	}

	if (loading) {
		return (
			<div className="flex-1 min-w-0 p-4 space-y-3">
				<Skeleton className="h-7 w-1/2" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}

	return (
		<div className="flex-1 flex flex-col min-w-0" data-color-mode={isDark ? "dark" : "light"}>
			<div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border shrink-0 bg-background">
				<div className="flex items-center gap-2 min-w-0 flex-1">
					{updatedAt && (
						<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
							{relativeTime(updatedAt)}
						</span>
					)}
					<Input
						value={title_}
						onChange={(e) => {
							setTitle(e.target.value);
							setDirty(true);
						}}
						readOnly={isDeleted}
						placeholder="Note title"
						className="text-base font-semibold h-8 max-w-md border-none shadow-none px-0 focus-visible:ring-0"
					/>
				</div>
				{isDeleted ? (
					<span className="text-xs text-muted-foreground shrink-0 px-2">In Trash — restore from the list to edit</span>
				) : (
					<div className="flex items-center gap-1 shrink-0">
						<Tip content={isFavorite ? "Remove from favorites" : "Add to favorites"}>
							<Button
								size="sm"
								variant="ghost"
								className="h-8 w-8 p-0 shrink-0"
								onClick={handleToggleFavorite}
								aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
							>
								<Star className={cn("w-4 h-4", isFavorite ? "text-amber-500 fill-amber-500" : "text-muted-foreground")} />
							</Button>
						</Tip>
						<DropdownMenu>
							<Tip content="Export note">
								<DropdownMenuTrigger asChild>
									<Button
										size="sm"
										variant="ghost"
										className="h-8 w-8 p-0 shrink-0"
										disabled={exporting}
										aria-label="Export note"
									>
										<Download className="w-4 h-4 text-muted-foreground" />
									</Button>
								</DropdownMenuTrigger>
							</Tip>
							<DropdownMenuContent align="end">
								{EXPORT_FORMATS.map((f) => (
									<DropdownMenuItem key={f.value} onClick={() => handleExport(f.value)} className="justify-between">
										{f.label}
										{defaultExportFormat === f.value && <Check className="w-3.5 h-3.5 text-muted-foreground" />}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
						<Tip content="Delete note">
							<Button
								size="sm"
								variant="ghost"
								className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive"
								onClick={handleDelete}
								aria-label="Delete note"
							>
								<Trash2 className="w-4 h-4" />
							</Button>
						</Tip>
						<Button size="sm" className="ml-1" onClick={handleSave} disabled={!dirty || saving}>
							<Save className="w-3.5 h-3.5 mr-1" />
							{saving ? "Saving…" : "Save"}
						</Button>
					</div>
				)}
			</div>
			{(sourceLabel || tags.length > 0 || !isDeleted) && (
				<div className="px-4 py-2 border-b border-border shrink-0 space-y-1.5">
					{sourceLabel && (
						<Badge variant="outline" className="font-normal text-muted-foreground">
							{sourceLabel}
						</Badge>
					)}
					<TagEditor tags={tags} onChange={handleTagsChange} readOnly={isDeleted} />
				</div>
			)}
			<div className="flex items-center justify-between gap-2 px-4 py-1.5 border-b border-border shrink-0">
				<span className="text-[11px] text-muted-foreground">Markdown · GFM tables, task lists &amp; strikethrough supported</span>
				{!isDeleted && <ModeSwitch mode={previewMode} onChange={setPreviewMode} />}
			</div>
			<div className="flex-1 min-h-0 overflow-hidden">
				<MDEditor
					value={content}
					onChange={(v) => {
						if (isDeleted) return;
						setContent(v ?? "");
						setDirty(true);
					}}
					preview={isDeleted ? "preview" : previewMode}
					commands={isDeleted ? [] : commands}
					extraCommands={[]}
					height="100%"
					visibleDragbar={false}
					previewOptions={{ rehypePlugins: [[rehypeSanitize]], components: { a: MarkdownLink } }}
				/>
			</div>
			{attachments.length > 0 && (
				<div className="shrink-0 border-t border-border px-4 py-3 space-y-2 overflow-y-auto max-h-48">
					<span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Attachments</span>
					{attachments.map((a) => (
						<AttachmentChip key={a.id} attachment={a} onRemoved={handleAttachmentRemoved} />
					))}
				</div>
			)}
			{(linkedNotes.length > 0 || backlinks.length > 0) && (
				<div className="shrink-0 border-t border-border px-4 py-3 space-y-3 overflow-y-auto max-h-48">
					{linkedNotes.length > 0 && (
						<div className="space-y-1.5">
							<span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Linked Notes</span>
							<div className="flex flex-wrap gap-1.5">
								{linkedNotes.map((n) => (
									<button
										key={n.id}
										type="button"
										onClick={() => navigateToNote(n)}
										className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60 hover:bg-muted text-xs text-foreground transition-colors max-w-[240px]"
										title={`${n.title} — ${n.collectionName}`}
									>
										<Link2 className="w-3 h-3 shrink-0 text-muted-foreground" />
										<span className="truncate">{n.title}</span>
									</button>
								))}
							</div>
						</div>
					)}
					{backlinks.length > 0 && (
						<div className="space-y-1.5">
							<span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Backlinks</span>
							<div className="flex flex-wrap gap-1.5">
								{backlinks.map((n) => (
									<button
										key={n.id}
										type="button"
										onClick={() => navigateToNote(n)}
										className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/60 hover:bg-muted text-xs text-foreground transition-colors max-w-[240px]"
										title={`${n.title} — ${n.collectionName}`}
									>
										<Link2 className="w-3 h-3 shrink-0 text-muted-foreground" />
										<span className="truncate">{n.title}</span>
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
