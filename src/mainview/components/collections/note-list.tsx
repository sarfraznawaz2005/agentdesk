import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Star, FileText, Trash2, RotateCcw, XCircle, Search, X } from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Tip } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCollectionsStore } from "@/stores/collections-store";
import { softDeleteWithUndo } from "./trash-actions";
import type { CollectionDto, CollectionNoteSummaryDto, CollectionNoteSort } from "../../../shared/rpc/collections";

const SEARCH_DEBOUNCE_MS = 250;

const SORT_OPTIONS: { value: CollectionNoteSort; label: string }[] = [
	{ value: "updated", label: "Last updated" },
	{ value: "created", label: "Created" },
	{ value: "title", label: "Title A-Z" },
	{ value: "favorite", label: "Favorites first" },
];

function collectionLabel(collectionId: string | null, collections: CollectionDto[]): string {
	if (collectionId === "favorites") return "Favorites";
	if (collectionId === "trash") return "Trash";
	return collections.find((c) => c.id === collectionId)?.name ?? "";
}

// Notes can only be created directly in a real collection — not in the
// virtual Favorites/Trash scopes.
function canCreateIn(collectionId: string | null): collectionId is string {
	return !!collectionId && collectionId !== "favorites" && collectionId !== "trash";
}

// A single note card. Draggable everywhere except Trash (trashed notes are
// restored via the Restore button, not dragged into a collection).
function NoteRow({
	note,
	selected,
	collectionId,
	draggable,
	onSelect,
	onToggleFavorite,
	onSoftDelete,
	onRestore,
	onDeleteForever,
}: {
	note: CollectionNoteSummaryDto;
	selected: boolean;
	collectionId: string | null;
	draggable: boolean;
	onSelect: () => void;
	onToggleFavorite: (e: React.MouseEvent) => void;
	onSoftDelete: (e: React.MouseEvent) => void;
	onRestore: (e: React.MouseEvent) => void;
	onDeleteForever: (e: React.MouseEvent) => void;
}) {
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: note.id,
		data: { type: "note", title: note.title || "Untitled", sourceCollectionId: note.collectionId },
		disabled: !draggable,
	});

	return (
		<li
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			onClick={onSelect}
			className={cn(
				"px-3 py-1.5 cursor-pointer border-l-2 transition-colors",
				selected ? "bg-primary/10 border-primary" : "border-transparent hover:bg-muted",
				draggable && "active:cursor-grabbing",
				isDragging && "opacity-40",
			)}
		>
			<div className="flex items-center gap-1.5 min-w-0">
				<p
					className={cn(
						"text-sm truncate flex-1",
						selected ? "font-semibold text-primary" : "font-medium text-foreground",
					)}
				>
					{note.title || "Untitled"}
				</p>
				{collectionId === "trash" ? (
					<>
						<button
							type="button"
							onClick={onRestore}
							className="shrink-0 p-0.5 -m-0.5 text-muted-foreground hover:text-foreground"
							aria-label="Restore from Trash"
						>
							<RotateCcw className="w-3 h-3" />
						</button>
						<button
							type="button"
							onClick={onDeleteForever}
							className="shrink-0 p-0.5 -m-0.5 text-muted-foreground hover:text-destructive"
							aria-label="Delete forever"
						>
							<XCircle className="w-3 h-3" />
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							onClick={onToggleFavorite}
							className="shrink-0 p-0.5 -m-0.5 text-muted-foreground hover:text-amber-500"
							aria-label={note.isFavorite ? "Remove from favorites" : "Add to favorites"}
						>
							<Star className={cn("w-3 h-3", note.isFavorite && "text-amber-500 fill-amber-500")} />
						</button>
						<button
							type="button"
							onClick={onSoftDelete}
							className="shrink-0 p-0.5 -m-0.5 text-muted-foreground hover:text-destructive"
							aria-label="Delete note"
						>
							<Trash2 className="w-3 h-3" />
						</button>
					</>
				)}
			</div>
			{note.snippet && <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{note.snippet}</p>}
		</li>
	);
}

export function NoteList({ collectionId, collections }: { collectionId: string | null; collections: CollectionDto[] }) {
	const [notes, setNotes] = useState<CollectionNoteSummaryDto[]>([]);
	const [loading, setLoading] = useState(false);
	const [selectedTag, setSelectedTag] = useState<string | null>(null);
	// Sort is a user preference, not per-collection state — deliberately not reset on collection switch.
	const [sort, setSort] = useState<CollectionNoteSort>("updated");
	const [searchQuery, setSearchQuery] = useState("");
	// null = not searching (browse mode); array (possibly empty) = FTS5 search results.
	const [searchResults, setSearchResults] = useState<CollectionNoteSummaryDto[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [deleteForeverTarget, setDeleteForeverTarget] = useState<CollectionNoteSummaryDto | null>(null);
	const [emptyTrashConfirmOpen, setEmptyTrashConfirmOpen] = useState(false);
	const selectedNoteId = useCollectionsStore((s) => s.selectedNoteId);
	const setSelectedNote = useCollectionsStore((s) => s.setSelectedNote);
	// The rail's "search all notes" box (above the collections list) — when
	// active, it drives this list's own search instead of the local box below,
	// so selecting a filtered collection shows just its matching notes.
	const librarySearchQuery = useCollectionsStore((s) => s.librarySearchQuery);
	const setLibrarySearchQuery = useCollectionsStore((s) => s.setLibrarySearchQuery);
	// Tracks the latest collectionId across renders so an Undo toast clicked after
	// the user has switched to a different collection doesn't reload the wrong list.
	const collectionIdRef = useRef(collectionId);
	useEffect(() => {
		collectionIdRef.current = collectionId;
	}, [collectionId]);

	const load = useCallback(async () => {
		if (!collectionId) {
			setNotes([]);
			return;
		}
		setLoading(true);
		try {
			const result = await rpc.listNotes({ collectionId, sort });
			setNotes(result);
		} catch (err) {
			console.error("Failed to load notes:", err);
		} finally {
			setLoading(false);
		}
	}, [collectionId, sort]);

	useEffect(() => {
		load();
	}, [load]);

	// Sort is a persisted preference (Settings tab's Defaults card is the other
	// entry point to the same setting) — load it once on mount, after the
	// initial "updated"-sorted load has already kicked off above.
	useEffect(() => {
		rpc
			.getSetting("defaultSort", "collections")
			.then((value) => {
				if (value && SORT_OPTIONS.some((o) => o.value === value)) setSort(value as CollectionNoteSort);
			})
			.catch((err) => console.error("Failed to load default sort setting:", err));
	}, []);

	// Tag filter and search are per-collection-view — clear them when switching
	// collections. Seeds from the rail's global query (not "") so switching to
	// a collection filtered-in by that search shows its matches immediately.
	useEffect(() => {
		setSelectedTag(null);
		setSearchQuery(librarySearchQuery);
		setSearchResults(null);
		// Intentionally keyed on collectionId only; live typing is handled by the effect below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [collectionId]);

	// Keep this list's search in sync while the user types in the rail's global
	// box, without waiting for a collection switch.
	useEffect(() => {
		setSearchQuery(librarySearchQuery);
	}, [librarySearchQuery]);

	// Debounced FTS5 search (with LIKE fallback, handled server-side) — replaces
	// the normal browse list while a query is active. Empty query reverts to browsing.
	useEffect(() => {
		const trimmed = searchQuery.trim();
		if (!trimmed || !collectionId) {
			setSearchResults(null);
			setSearching(false);
			return;
		}
		setSearching(true);
		const handle = setTimeout(() => {
			rpc
				.searchCollectionNotes({ query: trimmed, scope: collectionId })
				.then((results) => setSearchResults(results))
				.catch((err) => {
					console.error("Failed to search notes:", err);
					setSearchResults([]);
				})
				.finally(() => setSearching(false));
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(handle);
	}, [searchQuery, collectionId]);

	const isSearching = searchResults !== null;
	const isLibrarySearchActive = librarySearchQuery.trim().length > 0;

	// Chips are derived from every tag seen in the currently loaded (unfiltered)
	// note list — not from the filtered view, so selecting a tag never hides
	// the other chips that would otherwise re-widen the filter.
	const allTags = useMemo(() => {
		const set = new Set<string>();
		for (const n of notes) for (const t of n.tags) set.add(t);
		return Array.from(set).sort((a, b) => a.localeCompare(b));
	}, [notes]);

	// Search results bypass the tag filter and sort entirely — it's a different mode, not a refinement.
	const displayedNotes = useMemo(() => {
		if (isSearching) return searchResults ?? [];
		return selectedTag ? notes.filter((n) => n.tags.includes(selectedTag)) : notes;
	}, [notes, selectedTag, isSearching, searchResults]);

	// Keep the selection valid as the visible (tag-filtered or search) list changes.
	useEffect(() => {
		if (displayedNotes.length === 0) {
			if (selectedNoteId) setSelectedNote(null);
			return;
		}
		if (!displayedNotes.find((n) => n.id === selectedNoteId)) {
			setSelectedNote(displayedNotes[0].id);
		}
	}, [displayedNotes, selectedNoteId, setSelectedNote]);

	async function handleNewNote() {
		if (!canCreateIn(collectionId)) return;
		try {
			const result = await rpc.createCollectionNote({ collectionId, title: "Untitled" });
			await load();
			setSelectedNote(result.id);
		} catch (err) {
			console.error("Failed to create note:", err);
		}
	}

	// Viewing the virtual Favorites scope: unfavoriting removes the card outright.
	const applyFavoriteChange = useCallback(
		(noteId: string, isFavorite: boolean) => {
			if (collectionId === "favorites" && !isFavorite) {
				setNotes((prev) => prev.filter((n) => n.id !== noteId));
				return;
			}
			setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, isFavorite } : n)));
		},
		[collectionId],
	);

	async function handleToggleFavorite(e: React.MouseEvent, noteId: string) {
		e.stopPropagation();
		try {
			const result = await rpc.toggleFavorite({ id: noteId });
			if (!result.success) return;
			applyFavoriteChange(noteId, result.isFavorite);
			// Mirror into the note-editor pane (a sibling component) if that note is open there.
			window.dispatchEvent(
				new CustomEvent("agentdesk:collection-note-favorite-changed", {
					detail: { noteId, isFavorite: result.isFavorite },
				}),
			);
		} catch (err) {
			console.error("Failed to toggle favorite:", err);
		}
	}

	// The note-editor's own star toggle (top bar) fires this so this card list
	// stays in sync without a full reload while the same note is open.
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ noteId: string; isFavorite: boolean }>).detail;
			applyFavoriteChange(detail.noteId, detail.isFavorite);
		};
		window.addEventListener("agentdesk:collection-note-favorite-changed", handler);
		return () => window.removeEventListener("agentdesk:collection-note-favorite-changed", handler);
	}, [applyFavoriteChange]);

	// The note-editor's own Delete button fires this so this card list drops the
	// note immediately without a full reload while the same note is open.
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ noteId: string }>).detail;
			setNotes((prev) => prev.filter((n) => n.id !== detail.noteId));
		};
		window.addEventListener("agentdesk:collection-note-trashed", handler);
		return () => window.removeEventListener("agentdesk:collection-note-trashed", handler);
	}, []);

	// A drag-and-drop move (dropped onto a different collection in the rail) fires
	// this so this list drops the note immediately without a full reload.
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ noteId: string }>).detail;
			setNotes((prev) => prev.filter((n) => n.id !== detail.noteId));
		};
		window.addEventListener("agentdesk:collection-note-moved", handler);
		return () => window.removeEventListener("agentdesk:collection-note-moved", handler);
	}, []);

	// The note-editor's Save button fires this. Title/snippet/updatedAt aren't
	// reliably re-derivable client-side (the backend computes the snippet), so a
	// full reload is simplest — the selected note always belongs to the
	// currently displayed collection, so it's always relevant here.
	useEffect(() => {
		const handler = () => load();
		window.addEventListener("agentdesk:collection-note-updated", handler);
		return () => window.removeEventListener("agentdesk:collection-note-updated", handler);
	}, [load]);

	async function handleSoftDelete(e: React.MouseEvent, note: CollectionNoteSummaryDto) {
		e.stopPropagation();
		const deletedFromCollectionId = collectionId;
		try {
			const deleted = await softDeleteWithUndo(note, () => {
				// Only reload if still viewing the same collection the note was deleted from.
				if (collectionIdRef.current === deletedFromCollectionId) load();
			});
			if (!deleted) return;
			setNotes((prev) => prev.filter((n) => n.id !== note.id));
			if (selectedNoteId === note.id) setSelectedNote(null);
		} catch (err) {
			console.error("Failed to delete note:", err);
		}
	}

	async function handleRestore(e: React.MouseEvent, noteId: string) {
		e.stopPropagation();
		try {
			const result = await rpc.restoreNote({ id: noteId });
			if (!result.success) return;
			setNotes((prev) => prev.filter((n) => n.id !== noteId));
			if (selectedNoteId === noteId) setSelectedNote(null);
		} catch (err) {
			console.error("Failed to restore note:", err);
		}
	}

	function handleDeleteForever(e: React.MouseEvent, note: CollectionNoteSummaryDto) {
		e.stopPropagation();
		setDeleteForeverTarget(note);
	}

	async function confirmDeleteForever() {
		if (!deleteForeverTarget) return;
		const noteId = deleteForeverTarget.id;
		try {
			const result = await rpc.permanentlyDeleteNote({ id: noteId });
			if (!result.success) return;
			setNotes((prev) => prev.filter((n) => n.id !== noteId));
			if (selectedNoteId === noteId) setSelectedNote(null);
		} catch (err) {
			console.error("Failed to permanently delete note:", err);
		} finally {
			setDeleteForeverTarget(null);
		}
	}

	async function confirmEmptyTrash() {
		try {
			const result = await rpc.emptyTrash();
			if (!result.success) return;
			setNotes([]);
			setSelectedNote(null);
		} catch (err) {
			console.error("Failed to empty trash:", err);
		} finally {
			setEmptyTrashConfirmOpen(false);
		}
	}

	return (
		<div className="w-64 shrink-0 border-r border-border flex flex-col bg-muted/10 min-h-0">
			<div className="px-3 py-2 border-b border-border shrink-0 flex items-center justify-between gap-2">
				<h3 className="text-sm font-semibold text-foreground truncate">{collectionLabel(collectionId, collections)}</h3>
				{canCreateIn(collectionId) && (
					<Tip content="New note">
						<Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={handleNewNote} aria-label="New note">
							<Plus className="w-3.5 h-3.5" />
						</Button>
					</Tip>
				)}
				{collectionId === "trash" && notes.length > 0 && (
					<Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive" onClick={() => setEmptyTrashConfirmOpen(true)}>
						<XCircle className="w-3.5 h-3.5 mr-1" />
						Empty Trash
					</Button>
				)}
			</div>

			{collectionId && (
				<div className="relative px-3 py-2 border-b border-border shrink-0">
					<Search className="absolute left-5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
					<Input
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder={isLibrarySearchActive ? "Filtered by library search…" : "Search notes…"}
						disabled={isLibrarySearchActive}
						className="h-7 pl-7 pr-7 text-xs border-none shadow-none bg-transparent focus-visible:ring-0"
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={() => (isLibrarySearchActive ? setLibrarySearchQuery("") : setSearchQuery(""))}
							className="absolute right-5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
							aria-label="Clear search"
						>
							<X className="w-3.5 h-3.5" />
						</button>
					)}
				</div>
			)}

			{!isSearching && notes.length > 1 && (
				<div className="px-3 py-1.5 border-b border-border shrink-0">
					<Select
						value={sort}
						onValueChange={(v) => {
							setSort(v as CollectionNoteSort);
							rpc.saveSetting("defaultSort", v, "collections").catch((err) => console.error("Failed to save default sort setting:", err));
						}}
					>
						<SelectTrigger className="h-6 w-full text-xs px-2 py-0 gap-1 border-none shadow-none bg-transparent hover:bg-muted">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{SORT_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}

			{!isSearching && allTags.length > 0 && (
				<div className="flex flex-wrap gap-1 px-3 py-2 border-b border-border shrink-0">
					{allTags.map((tag) => (
						<Badge
							key={tag}
							variant={selectedTag === tag ? "default" : "secondary"}
							className="cursor-pointer font-normal"
							onClick={() => setSelectedTag((prev) => (prev === tag ? null : tag))}
						>
							{tag}
						</Badge>
					))}
				</div>
			)}

			<div className="flex-1 overflow-y-auto">
				{(isSearching ? searching : loading) ? (
					<div className="p-2 space-y-2">
						{Array.from({ length: 4 }).map((_, i) => (
							<div key={i} className="p-2">
								<Skeleton className="h-4 w-3/4" />
								<Skeleton className="h-3 w-full mt-1.5" />
							</div>
						))}
					</div>
				) : isSearching && displayedNotes.length === 0 ? (
					<EmptyState
						icon={<Search className="w-5 h-5" />}
						title="No matches"
						description={`No notes match "${searchQuery.trim()}".`}
					/>
				) : !isSearching && notes.length === 0 && collectionId === "trash" ? (
					<EmptyState
						icon={<Trash2 className="w-5 h-5" />}
						title="Trash is empty"
						description="Deleted notes are kept here until you remove them for good."
					/>
				) : !isSearching && notes.length === 0 && collectionId === "favorites" ? (
					<EmptyState
						icon={<Star className="w-5 h-5" />}
						title="No favorites yet"
						description="Star notes to find them here quickly."
					/>
				) : !isSearching && notes.length === 0 ? (
					<EmptyState
						icon={<FileText className="w-5 h-5" />}
						title="Nothing saved yet"
						description="Create your first note to get started."
						action={
							<Button size="sm" onClick={handleNewNote}>
								<Plus className="w-4 h-4 mr-1" />
								New Note
							</Button>
						}
					/>
				) : !isSearching && displayedNotes.length === 0 ? (
					<p className="p-4 text-xs text-muted-foreground text-center">No notes with the "{selectedTag}" tag.</p>
				) : (
					<ul>
						{displayedNotes.map((note) => (
							<NoteRow
								key={note.id}
								note={note}
								selected={selectedNoteId === note.id}
								collectionId={collectionId}
								draggable={collectionId !== "trash"}
								onSelect={() => setSelectedNote(note.id)}
								onToggleFavorite={(e) => handleToggleFavorite(e, note.id)}
								onSoftDelete={(e) => handleSoftDelete(e, note)}
								onRestore={(e) => handleRestore(e, note.id)}
								onDeleteForever={(e) => handleDeleteForever(e, note)}
							/>
						))}
					</ul>
				)}
			</div>

			<ConfirmationDialog
				open={!!deleteForeverTarget}
				onOpenChange={(open) => { if (!open) setDeleteForeverTarget(null); }}
				title="Delete forever?"
				description={`"${deleteForeverTarget?.title || "Untitled"}" will be permanently deleted. This cannot be undone.`}
				confirmLabel="Delete Forever"
				variant="destructive"
				onConfirm={confirmDeleteForever}
				onCancel={() => setDeleteForeverTarget(null)}
			/>

			<ConfirmationDialog
				open={emptyTrashConfirmOpen}
				onOpenChange={setEmptyTrashConfirmOpen}
				title="Empty Trash?"
				description={`${notes.length} note${notes.length === 1 ? "" : "s"} in Trash will be permanently deleted. This cannot be undone.`}
				confirmLabel="Empty Trash"
				variant="destructive"
				onConfirm={confirmEmptyTrash}
				onCancel={() => setEmptyTrashConfirmOpen(false)}
			/>
		</div>
	);
}
