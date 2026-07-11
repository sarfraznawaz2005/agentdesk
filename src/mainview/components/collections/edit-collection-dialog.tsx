import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { COLLECTION_COLORS } from "@/lib/collection-colors";
import type { CollectionDto } from "../../../shared/rpc/collections";

// Rename/recolor an existing collection — Default included (its isDefault
// status is protected from deletion, not its name/color; see docs/collections-plan.md §4).
export function EditCollectionDialog({
	collection,
	onOpenChange,
	onSaved,
}: {
	collection: CollectionDto | null;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState("");
	const [color, setColor] = useState<string>(COLLECTION_COLORS[0].name);
	const [saving, setSaving] = useState(false);

	// Re-seed the form whenever a new collection is opened for editing.
	useEffect(() => {
		if (collection) {
			setName(collection.name);
			setColor(collection.color);
		}
	}, [collection]);

	async function handleSave() {
		if (!collection) return;
		const trimmed = name.trim();
		if (!trimmed || saving) return;
		setSaving(true);
		try {
			const requests: Promise<unknown>[] = [];
			if (trimmed !== collection.name) requests.push(rpc.renameCollection({ id: collection.id, name: trimmed }));
			if (color !== collection.color) requests.push(rpc.recolorCollection({ id: collection.id, color }));
			await Promise.all(requests);
			onSaved();
			onOpenChange(false);
		} catch (err) {
			console.error("Failed to save collection:", err);
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog open={!!collection} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Edit collection</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<label className="text-xs font-medium text-muted-foreground">Name</label>
						<Input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Collection name"
							autoFocus
							onKeyDown={(e) => {
								if (e.key === "Enter") handleSave();
							}}
						/>
					</div>
					<div className="space-y-1.5">
						<label className="text-xs font-medium text-muted-foreground">Color</label>
						<div className="flex gap-1.5">
							{COLLECTION_COLORS.map((c) => (
								<button
									key={c.name}
									type="button"
									onClick={() => setColor(c.name)}
									aria-label={c.name}
									className={cn(
										"w-5 h-5 rounded-full transition-shadow",
										c.dot,
										color === c.name && "ring-2 ring-offset-2 ring-offset-background ring-foreground",
									)}
								/>
							))}
						</div>
					</div>
				</div>
				<DialogFooter>
					<Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button size="sm" onClick={handleSave} disabled={!name.trim() || saving}>
						{saving ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
