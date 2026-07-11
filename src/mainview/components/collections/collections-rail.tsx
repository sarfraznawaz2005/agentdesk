import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Star, Folder, Trash2, MoreVertical, Check, Search, X } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { useSortable, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCollectionsStore } from "@/stores/collections-store";
import { collectionDotClass } from "@/lib/collection-colors";
import { NewCollectionPopover } from "./new-collection-popover";
import type { CollectionDto, CollectionExportFormat, CollectionNoteSummaryDto } from "../../../shared/rpc/collections";

const SEARCH_DEBOUNCE_MS = 250;

const EXPORT_FORMATS: { value: CollectionExportFormat; label: string }[] = [
	{ value: "markdown", label: "Export as Markdown" },
	{ value: "pdf", label: "Export as PDF" },
	{ value: "json", label: "Export as JSON" },
];

function RailItem({
	icon: Icon,
	dot,
	label,
	count,
	active,
	onClick,
	onExport,
	defaultExportFormat,
	onEdit,
	onDelete,
	innerRef,
	style,
	dragHandleProps,
	isDropTarget,
	centered,
}: {
	icon?: LucideIcon;
	dot?: string;
	label: string;
	count?: number;
	active: boolean;
	onClick: () => void;
	/** Real collections only (not Favorites/Trash) — renders a hover-visible export menu. */
	onExport?: (format: CollectionExportFormat) => void;
	/** Which format is checked as the persisted default (Settings tab's Defaults card). */
	defaultExportFormat?: CollectionExportFormat;
	/** Real collections only (Default included — only its isDefault status is protected, not its name/color). */
	onEdit?: () => void;
	/** Custom collections only (not Default/Favorites/Trash — Default can't be deleted). */
	onDelete?: () => void;
	/** dnd-kit setNodeRef, for rows that are draggable and/or a drop target. */
	innerRef?: (node: HTMLElement | null) => void;
	style?: CSSProperties;
	/** Spread onto the row so the whole row is the drag handle (matches KanbanCard's convention). */
	dragHandleProps?: Record<string, unknown>;
	/** A note is currently being dragged over this row — highlight it as a drop target. */
	isDropTarget?: boolean;
	/** Standalone footer action (Trash) rather than a list row — centers icon+label as a group. */
	centered?: boolean;
}) {
	return (
		<div
			ref={innerRef}
			style={style}
			{...dragHandleProps}
			className={cn(
				"group w-full flex items-center rounded-md text-sm transition-colors",
				active ? "bg-primary/10 text-primary font-medium" : "text-foreground hover:bg-muted",
				isDropTarget && "ring-2 ring-primary/50 bg-primary/5",
			)}
		>
			<button
				type="button"
				onClick={onClick}
				className={cn(
					"flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5",
					centered ? "justify-center text-center" : "text-left",
				)}
			>
				{Icon ? (
					<Icon className="w-3.5 h-3.5 shrink-0" />
				) : (
					<span className={cn("w-2 h-2 rounded-full shrink-0", dot)} />
				)}
				<span className={cn("truncate", !centered && "flex-1")}>{label}</span>
				{count !== undefined && (
					<span className={cn("text-[10px]", active ? "text-primary" : "text-muted-foreground")}>{count}</span>
				)}
			</button>
			{(onExport || onEdit || onDelete) && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="shrink-0 mr-1 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-background/80 text-muted-foreground transition-opacity"
							aria-label={`${label} options`}
						>
							<MoreVertical className="w-3.5 h-3.5" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{onEdit && <DropdownMenuItem onClick={onEdit}>Edit collection</DropdownMenuItem>}
						{onEdit && onExport && <DropdownMenuSeparator />}
						{onExport && (
							<>
								{EXPORT_FORMATS.map((f) => (
									<DropdownMenuItem key={f.value} onClick={() => onExport(f.value)} className="justify-between">
										{f.label}
										{defaultExportFormat === f.value && <Check className="w-3.5 h-3.5 text-muted-foreground" />}
									</DropdownMenuItem>
								))}
							</>
						)}
						{onExport && onDelete && <DropdownMenuSeparator />}
						{onDelete && (
							<DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
								Delete collection
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}

// Default is a drop target for notes (dragged in from NoteList) but never reorders
// or gets dragged itself — it's pinned first by the backend regardless of sortOrder.
function DroppableRailItem({
	collectionId,
	isDropTarget,
	...railProps
}: Omit<Parameters<typeof RailItem>[0], "innerRef" | "isDropTarget"> & { collectionId: string; isDropTarget: boolean }) {
	const { setNodeRef } = useDroppable({ id: collectionId, data: { type: "collection" } });
	return <RailItem {...railProps} innerRef={setNodeRef} isDropTarget={isDropTarget} />;
}

// Custom collections are both draggable (rail reordering) and a drop target (notes).
function SortableRailItem({
	collectionId,
	isDropTarget,
	...railProps
}: Omit<Parameters<typeof RailItem>[0], "innerRef" | "style" | "dragHandleProps" | "isDropTarget"> & {
	collectionId: string;
	isDropTarget: boolean;
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: collectionId,
		data: { type: "collection", label: railProps.label },
	});
	const style: CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};
	return (
		<RailItem
			{...railProps}
			innerRef={setNodeRef}
			style={style}
			dragHandleProps={{ ...attributes, ...listeners }}
			isDropTarget={isDropTarget}
		/>
	);
}

export function CollectionsRail({
	collections,
	loading,
	onCreated,
	onExport,
	onEditRequest,
	onDeleteRequest,
	dragOverCollectionId,
}: {
	collections: CollectionDto[];
	loading: boolean;
	onCreated: (id: string) => void;
	onExport: (collectionId: string, format: CollectionExportFormat) => void;
	onEditRequest: (collection: CollectionDto) => void;
	onDeleteRequest: (collection: CollectionDto) => void;
	/** id of the collection a dragged note is currently hovering over, if any. */
	dragOverCollectionId: string | null;
}) {
	const selectedCollectionId = useCollectionsStore((s) => s.selectedCollectionId);
	const setSelectedCollection = useCollectionsStore((s) => s.setSelectedCollection);
	// Persisted default export format (Settings tab's Defaults card is the other
	// entry point) — picking a format here also updates the default, mirroring
	// how NoteList's sort dropdown doubles as its own default-setter.
	const [defaultExportFormat, setDefaultExportFormat] = useState<CollectionExportFormat>("markdown");
	useEffect(() => {
		rpc
			.getSetting("defaultExportFormat", "collections")
			.then((value) => {
				if (value === "markdown" || value === "pdf" || value === "json") setDefaultExportFormat(value);
			})
			.catch((err) => console.error("Failed to load default export format setting:", err));
	}, []);

	function handleExport(collectionId: string, format: CollectionExportFormat) {
		setDefaultExportFormat(format);
		rpc.saveSetting("defaultExportFormat", format, "collections").catch((err) => console.error("Failed to save default export format setting:", err));
		onExport(collectionId, format);
	}

	// "Search all notes" — replaces the old top-bar GlobalSearch. Lives in the
	// store (not local state) so NoteList can mirror the same query into its own
	// per-collection search once a filtered collection is selected.
	const librarySearchQuery = useCollectionsStore((s) => s.librarySearchQuery);
	const setLibrarySearchQuery = useCollectionsStore((s) => s.setLibrarySearchQuery);
	const [searchResults, setSearchResults] = useState<CollectionNoteSummaryDto[] | null>(null);
	const [searching, setSearching] = useState(false);

	useEffect(() => {
		const trimmed = librarySearchQuery.trim();
		if (!trimmed) {
			// No setSearchResults(null)/setSearching(false) here — every read of both
			// below is already gated on isSearching (itself derived straight from
			// librarySearchQuery), so stale values are never actually observed once
			// the query is empty. Avoids a synchronous setState-in-effect.
			return;
		}
		// Marks the debounced fetch below as started — legitimately synchronizing
		// with an external timer/RPC call, not derivable from render.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setSearching(true);
		const handle = setTimeout(() => {
			rpc
				.searchCollectionNotes({ query: trimmed, scope: "all" })
				.then((results) => setSearchResults(results))
				.catch((err) => {
					console.error("Failed to search collections:", err);
					setSearchResults([]);
				})
				.finally(() => setSearching(false));
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(handle);
	}, [librarySearchQuery]);

	const isSearching = librarySearchQuery.trim().length > 0;

	// Which real collections have at least one matching note, and how many —
	// null while not searching. Favorites is a cross-cutting view (not a real
	// collection), so it's never filtered by this and stays always visible.
	const matchCountByCollection = useMemo(() => {
		if (!searchResults) return null;
		const map = new Map<string, number>();
		for (const note of searchResults) {
			map.set(note.collectionId, (map.get(note.collectionId) ?? 0) + 1);
		}
		return map;
	}, [searchResults]);

	const defaultCollection = collections.find((c) => c.isDefault);
	const allCustomCollections = collections.filter((c) => !c.isDefault);
	// While searching, hide collections with zero matches — reordering (drag)
	// only makes sense over the full unfiltered list, so custom collections
	// render as plain (non-sortable) rows in this mode.
	const showDefault = defaultCollection && (!isSearching || (matchCountByCollection?.has(defaultCollection.id) ?? false));
	const customCollections = isSearching
		? allCustomCollections.filter((c) => matchCountByCollection?.has(c.id))
		: allCustomCollections;
	const noMatches = isSearching && !searching && searchResults !== null && !showDefault && customCollections.length === 0;

	return (
		<div className="w-48 shrink-0 border-r border-border flex flex-col bg-muted/30 min-h-0">
			<div className="shrink-0 flex items-center justify-between border-b border-border px-3 py-2">
				<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Collections
				</span>
				<NewCollectionPopover onCreated={onCreated} />
			</div>

			<div className="relative px-3 py-2 border-b border-border shrink-0">
				<Search className="absolute left-5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
				<Input
					value={librarySearchQuery}
					onChange={(e) => setLibrarySearchQuery(e.target.value)}
					placeholder="Search all notes…"
					className="h-7 pl-7 pr-7 text-xs border-none shadow-none bg-transparent focus-visible:ring-0"
				/>
				{librarySearchQuery && (
					<button
						type="button"
						onClick={() => setLibrarySearchQuery("")}
						className="absolute right-5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
						aria-label="Clear search"
					>
						<X className="w-3.5 h-3.5" />
					</button>
				)}
			</div>

			<div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
				<div className="space-y-0.5">
					<RailItem
						icon={Star}
						label="Favorites"
						active={selectedCollectionId === "favorites"}
						onClick={() => setSelectedCollection("favorites")}
					/>
					{showDefault && defaultCollection && (
						<DroppableRailItem
							collectionId={defaultCollection.id}
							icon={Folder}
							label={defaultCollection.name}
							count={isSearching ? (matchCountByCollection?.get(defaultCollection.id) ?? 0) : defaultCollection.noteCount}
							active={selectedCollectionId === defaultCollection.id}
							onClick={() => setSelectedCollection(defaultCollection.id)}
							onExport={(format) => handleExport(defaultCollection.id, format)}
							defaultExportFormat={defaultExportFormat}
							onEdit={() => onEditRequest(defaultCollection)}
							isDropTarget={dragOverCollectionId === defaultCollection.id}
						/>
					)}
				</div>

				{loading ? (
					<div className="space-y-1.5 px-2">
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-3/4" />
					</div>
				) : isSearching && searching ? (
					<div className="space-y-1.5 px-2 pt-2">
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-2/3" />
					</div>
				) : noMatches ? (
					<p className="px-2 pt-2 text-xs text-muted-foreground text-center">
						No notes match "{librarySearchQuery.trim()}".
					</p>
				) : (
					customCollections.length > 0 &&
					(isSearching ? (
						// Filtered subset — plain rows, no drag-to-reorder (indices would
						// no longer line up with the full unfiltered collection list).
						<div className="space-y-0.5 pt-2 border-t border-border">
							{customCollections.map((c) => (
								<RailItem
									key={c.id}
									dot={collectionDotClass(c.color)}
									label={c.name}
									count={matchCountByCollection?.get(c.id) ?? 0}
									active={selectedCollectionId === c.id}
									onClick={() => setSelectedCollection(c.id)}
								/>
							))}
						</div>
					) : (
						<SortableContext items={customCollections.map((c) => c.id)} strategy={verticalListSortingStrategy}>
							<div className="space-y-0.5 pt-2 border-t border-border">
								{customCollections.map((c) => (
									<SortableRailItem
										key={c.id}
										collectionId={c.id}
										dot={collectionDotClass(c.color)}
										label={c.name}
										count={c.noteCount}
										active={selectedCollectionId === c.id}
										onClick={() => setSelectedCollection(c.id)}
										onExport={(format) => handleExport(c.id, format)}
										defaultExportFormat={defaultExportFormat}
										onEdit={() => onEditRequest(c)}
										onDelete={() => onDeleteRequest(c)}
										isDropTarget={dragOverCollectionId === c.id}
									/>
								))}
							</div>
						</SortableContext>
					))
				)}
			</div>

			{!isSearching && (
				<div className="px-2 py-1 border-t border-border shrink-0">
					<RailItem
						icon={Trash2}
						label="Trash"
						centered
						active={selectedCollectionId === "trash"}
						onClick={() => setSelectedCollection("trash")}
					/>
				</div>
			)}
		</div>
	);
}
