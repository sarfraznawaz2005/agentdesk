import { useEffect, useState } from "react";
import { Plus, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { collectionDotClass } from "@/lib/collection-colors";
import type {
	CollectionDto,
	CollectionNoteSourceRef,
	CollectionNoteSourceType,
} from "../../../shared/rpc/collections";

// Derives a starting title from the first substantive line of the source
// content, mirroring how the mockup pre-fills the field from a chat message.
// Skips blank lines and markdown horizontal rules (---, ***, ___), which
// would otherwise surface as a literal "---" title.
function deriveTitleFromMarkdown(markdown: string): string {
	for (const line of markdown.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || /^([-*_])\1{2,}$/.test(trimmed)) continue;
		const plain = trimmed.replace(/^#{1,6}\s+/, "").replace(/[*_`~]/g, "").trim();
		if (!plain) continue;
		return plain.length > 80 ? `${plain.slice(0, 80).trimEnd()}…` : plain;
	}
	return "";
}

// Shared modal for every "Save to Collection" entry point (message-bubble.tsx,
// Freelance inbox — docs/collections-plan.md §8). The caller supplies the
// source content and provenance; this component only owns the collection
// picker + title editing + the saveToCollection call.
export function SaveToCollectionModal({
	open,
	onOpenChange,
	contentMarkdown,
	suggestedTitle,
	sourceType,
	sourceRef,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	contentMarkdown: string;
	suggestedTitle?: string;
	sourceType?: CollectionNoteSourceType;
	sourceRef?: CollectionNoteSourceRef;
	onSaved?: (collectionId: string, noteId: string) => void;
}) {
	const [collections, setCollections] = useState<CollectionDto[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [saving, setSaving] = useState(false);
	const [newName, setNewName] = useState("");
	const [creatingCollection, setCreatingCollection] = useState(false);

	useEffect(() => {
		if (!open) return;
		setTitle(suggestedTitle?.trim() || deriveTitleFromMarkdown(contentMarkdown) || "Untitled");
		setNewName("");
		setSelectedId(null);
		setLoading(true);
		rpc
			.listCollections()
			.then((result) => {
				setCollections(result);
				const preferred = result.find((c) => c.isDefault) ?? result[0];
				if (preferred) setSelectedId(preferred.id);
			})
			.catch((err) => console.error("Failed to load collections:", err))
			.finally(() => setLoading(false));
		// Sample content/title are only meaningful at the moment the modal opens.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	async function handleCreateCollection() {
		const trimmed = newName.trim();
		if (!trimmed || creatingCollection) return;
		setCreatingCollection(true);
		try {
			const result = await rpc.createCollection({ name: trimmed, color: "indigo" });
			const created = await rpc.listCollections();
			setCollections(created);
			setSelectedId(result.id);
			setNewName("");
		} catch (err) {
			console.error("Failed to create collection:", err);
		} finally {
			setCreatingCollection(false);
		}
	}

	async function handleSave() {
		if (!selectedId || saving) return;
		setSaving(true);
		try {
			const result = await rpc.saveToCollection({
				collectionId: selectedId,
				title: title.trim() || "Untitled",
				contentMarkdown,
				sourceType,
				sourceRef,
			});
			if (!result.success) throw new Error("saveToCollection returned success:false");
			toast("success", `Saved to ${collections.find((c) => c.id === selectedId)?.name ?? "collection"}.`);
			onSaved?.(selectedId, result.id);
			onOpenChange(false);
		} catch (err) {
			console.error("Failed to save to collection:", err);
			toast("error", "Failed to save note.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Save to Collection</DialogTitle>
				</DialogHeader>

				<div className="space-y-3">
					<div className="rounded-md border-l-2 border-border bg-muted/40 px-3 py-2 max-h-32 overflow-y-auto">
						<p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{contentMarkdown}</p>
					</div>

					<div className="space-y-1.5">
						<label className="text-xs font-medium text-muted-foreground">Title</label>
						<Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Note title" autoFocus />
					</div>

					<div className="space-y-1.5">
						<label className="text-xs font-medium text-muted-foreground">Collection</label>
						<div className="rounded-md border border-border max-h-40 overflow-y-auto">
							{loading ? (
								<p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
							) : (
								collections.map((c) => (
									<button
										key={c.id}
										type="button"
										onClick={() => setSelectedId(c.id)}
										className={cn(
											"w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors",
											selectedId === c.id ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted",
										)}
									>
										<span className={cn("w-2 h-2 rounded-full shrink-0", collectionDotClass(c.color))} />
										<span className="truncate flex-1">{c.name}</span>
										{selectedId === c.id && <Check className="w-3.5 h-3.5 shrink-0" />}
									</button>
								))
							)}
							<div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-border">
								<Plus className="w-3 h-3 text-muted-foreground shrink-0" />
								<input
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											handleCreateCollection();
										}
									}}
									placeholder="New collection…"
									className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none min-w-0"
								/>
							</div>
						</div>
					</div>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={handleSave} disabled={!selectedId || saving}>
						{saving ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
