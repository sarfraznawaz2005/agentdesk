import { useCallback, useEffect, useRef, useState } from "react";
import {
	DndContext,
	DragOverlay,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
	type DragOverEvent,
	type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { EditCollectionDialog } from "../components/collections/edit-collection-dialog";
import { CollectionsRail } from "../components/collections/collections-rail";
import { NoteList } from "../components/collections/note-list";
import { NoteEditor } from "../components/collections/note-editor";
import { SettingsTab } from "../components/collections/settings-tab";
import { ChatFab } from "../components/collections/chat-fab";
import { useCollectionsStore } from "../stores/collections-store";
import type { CollectionDto } from "../../shared/rpc/collections";

function LibraryView() {
	const [collections, setCollections] = useState<CollectionDto[]>([]);
	const [loading, setLoading] = useState(true);
	const [deleteTarget, setDeleteTarget] = useState<CollectionDto | null>(null);
	const [editTarget, setEditTarget] = useState<CollectionDto | null>(null);
	const [dragOverCollectionId, setDragOverCollectionId] = useState<string | null>(null);
	const [activeDrag, setActiveDrag] = useState<{ type: "collection" | "note"; label: string } | null>(null);
	const selectedCollectionId = useCollectionsStore((s) => s.selectedCollectionId);
	const setSelectedCollection = useCollectionsStore((s) => s.setSelectedCollection);

	const loadCollections = useCallback(async () => {
		try {
			const result = await rpc.listCollections();
			setCollections(result);
		} catch (err) {
			console.error("Failed to load collections:", err);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadCollections();
	}, [loadCollections]);

	// Always land on the Default (top) collection when the Collections page is
	// opened — selectedCollectionId lives in a store that outlives this view, so
	// without this a prior visit's Trash/Favorites/custom selection would stick.
	// The ref (not selectedCollectionId) gates it so it fires exactly once per
	// mount, not on every later selection change during this visit.
	const didAutoSelectRef = useRef(false);
	useEffect(() => {
		if (didAutoSelectRef.current || collections.length === 0) return;
		didAutoSelectRef.current = true;
		const preferred = collections.find((c) => c.isDefault) ?? collections[0];
		setSelectedCollection(preferred.id);
	}, [collections, setSelectedCollection]);

	async function handleCreated(newId: string) {
		await loadCollections();
		setSelectedCollection(newId);
	}

	// noteCount on `collections` can be stale (e.g. a note was just added via NoteList,
	// which doesn't notify this parent) — refetch so the confirmation dialog's
	// "notes move to Default" wording reflects the real current count, not a stale one.
	async function handleDeleteRequest(collection: CollectionDto) {
		try {
			const fresh = await rpc.listCollections();
			setCollections(fresh);
			setDeleteTarget(fresh.find((c) => c.id === collection.id) ?? collection);
		} catch (err) {
			console.error("Failed to refresh collections before delete confirmation:", err);
			setDeleteTarget(collection);
		}
	}

	async function handleExportCollection(collectionId: string, format: "markdown" | "pdf" | "json") {
		try {
			const result = await rpc.exportCollection({ id: collectionId, format });
			if (!result.success) throw new Error("exportCollection returned success:false");
			toast("success", "Collection exported — revealed in folder.");
		} catch (err) {
			console.error("Failed to export collection:", err);
			toast("error", "Failed to export collection.");
		}
	}

	async function handleConfirmDelete() {
		if (!deleteTarget) return;
		try {
			const result = await rpc.deleteCollection({ id: deleteTarget.id });
			if (!result.success) throw new Error(result.error ?? "deleteCollection returned success:false");
			// Notes were moved to Default rather than deleted — reflect that in the toast.
			toast("success", result.movedNoteCount ? `Deleted "${deleteTarget.name}" — notes moved to Default.` : `Deleted "${deleteTarget.name}".`);
			if (selectedCollectionId === deleteTarget.id) {
				const preferred = collections.find((c) => c.isDefault);
				if (preferred) setSelectedCollection(preferred.id);
			}
			await loadCollections();
		} catch (err) {
			console.error("Failed to delete collection:", err);
			toast("error", "Failed to delete collection.");
		} finally {
			setDeleteTarget(null);
		}
	}

	// Require minimum drag distance so a plain click (select a note/collection) never
	// gets misread as a drag — same convention as KanbanBoard.
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

	function handleDragStart(event: DragStartEvent) {
		const data = event.active.data.current as { type?: "collection" | "note"; label?: string; title?: string } | undefined;
		if (!data?.type) return;
		setActiveDrag({ type: data.type, label: data.type === "note" ? (data.title ?? "") : (data.label ?? "") });
	}

	function handleDragOver(event: DragOverEvent) {
		const over = event.over;
		const overData = over?.data.current as { type?: string } | undefined;
		setDragOverCollectionId(over && overData?.type === "collection" ? (over.id as string) : null);
	}

	async function handleDragEnd(event: DragEndEvent) {
		setActiveDrag(null);
		setDragOverCollectionId(null);
		const { active, over } = event;
		if (!over) return;

		const activeData = active.data.current as
			| { type: "note"; sourceCollectionId?: string }
			| { type: "collection" }
			| undefined;
		if (!activeData) return;

		if (activeData.type === "note") {
			const overData = over.data.current as { type?: string } | undefined;
			if (overData?.type !== "collection") return;
			const targetCollectionId = over.id as string;
			if (targetCollectionId === activeData.sourceCollectionId) return;
			try {
				const result = await rpc.moveNote({ id: active.id as string, targetCollectionId });
				if (!result.success) throw new Error("moveNote returned success:false");
				window.dispatchEvent(new CustomEvent("agentdesk:collection-note-moved", { detail: { noteId: active.id } }));
				await loadCollections();
			} catch (err) {
				console.error("Failed to move note:", err);
				toast("error", "Failed to move note.");
			}
			return;
		}

		// Reordering custom collections in the rail — Default isn't part of this list
		// and can't be dragged, so an out-of-list `over` (e.g. Default) is a no-op.
		if (active.id === over.id) return;
		const customIds = collections.filter((c) => !c.isDefault).map((c) => c.id);
		const oldIndex = customIds.indexOf(active.id as string);
		const newIndex = customIds.indexOf(over.id as string);
		if (oldIndex === -1 || newIndex === -1) return;

		const reordered = arrayMove(customIds, oldIndex, newIndex);
		setCollections((prev) => {
			const byId = new Map(prev.map((c) => [c.id, c]));
			const defaultOnes = prev.filter((c) => c.isDefault);
			const customReordered = reordered.map((id) => byId.get(id)).filter((c): c is CollectionDto => !!c);
			return [...defaultOnes, ...customReordered];
		});
		try {
			const result = await rpc.reorderCollections({ orderedIds: reordered });
			if (!result.success) throw new Error("reorderCollections returned success:false");
		} catch (err) {
			console.error("Failed to save new collection order:", err);
			toast("error", "Failed to save new order.");
			await loadCollections();
		}
	}

	return (
		<div className="flex flex-col h-full min-h-0">
			<DndContext sensors={sensors} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
				<div className="flex flex-1 min-h-0">
					<CollectionsRail
						collections={collections}
						loading={loading}
						onCreated={handleCreated}
						onExport={handleExportCollection}
						onEditRequest={setEditTarget}
						onDeleteRequest={handleDeleteRequest}
						dragOverCollectionId={dragOverCollectionId}
					/>
					<NoteList collectionId={selectedCollectionId} collections={collections} />
					<NoteEditor />
				</div>
				<DragOverlay>
					{activeDrag ? (
						<div className="px-3 py-1.5 rounded-md bg-background border border-border shadow-lg text-sm font-medium max-w-[220px] truncate">
							{activeDrag.type === "note" ? `Move "${activeDrag.label}"` : activeDrag.label}
						</div>
					) : null}
				</DragOverlay>
			</DndContext>
			<ChatFab />

			<ConfirmationDialog
				open={!!deleteTarget}
				onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
				title={`Delete "${deleteTarget?.name ?? ""}"?`}
				description={
					deleteTarget && deleteTarget.noteCount > 0
						? `This collection has ${deleteTarget.noteCount} note${deleteTarget.noteCount === 1 ? "" : "s"}. They will be moved to Default, not deleted. This cannot be undone.`
						: "This cannot be undone."
				}
				confirmLabel="Delete"
				variant="destructive"
				onConfirm={handleConfirmDelete}
				onCancel={() => setDeleteTarget(null)}
			/>

			<EditCollectionDialog
				collection={editTarget}
				onOpenChange={(open) => { if (!open) setEditTarget(null); }}
				onSaved={loadCollections}
			/>
		</div>
	);
}

export function CollectionsPage() {
	const activeTab = useCollectionsStore((s) => s.activeTab);
	const setActiveTab = useCollectionsStore((s) => s.setActiveTab);

	return (
		<Tabs
			value={activeTab}
			onValueChange={(v) => setActiveTab(v as "library" | "settings")}
			className="flex flex-col h-full min-h-0"
		>
			<div className="h-14 shrink-0 flex items-center border-b border-border px-4 md:px-6">
				<TabsList>
					<TabsTrigger value="library">Collections</TabsTrigger>
					<TabsTrigger value="settings">Settings</TabsTrigger>
				</TabsList>
			</div>
			<TabsContent value="library" className="flex-1 min-h-0 mt-0">
				<LibraryView />
			</TabsContent>
			<TabsContent value="settings" className="flex-1 min-h-0 mt-0 overflow-y-auto">
				<SettingsTab />
			</TabsContent>
		</Tabs>
	);
}
