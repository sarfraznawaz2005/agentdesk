import { useState } from "react";
import { Plus } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { COLLECTION_COLORS } from "@/lib/collection-colors";

// "slate" is visually reserved for the Default collection's folder icon, so
// new collections default to the next swatch instead.
const DEFAULT_COLOR = COLLECTION_COLORS[1].name;

export function NewCollectionPopover({ onCreated }: { onCreated: (id: string) => void }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [color, setColor] = useState<string>(DEFAULT_COLOR);
	const [creating, setCreating] = useState(false);

	function reset() {
		setName("");
		setColor(DEFAULT_COLOR);
	}

	async function handleCreate() {
		const trimmed = name.trim();
		if (!trimmed || creating) return;
		setCreating(true);
		try {
			const result = await rpc.createCollection({ name: trimmed, color });
			onCreated(result.id);
			reset();
			setOpen(false);
		} catch (err) {
			console.error("Failed to create collection:", err);
		} finally {
			setCreating(false);
		}
	}

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) reset();
			}}
		>
			<Tip content="New collection">
				<PopoverTrigger asChild>
					<Button size="sm" variant="ghost" className="h-8 w-8 p-0" aria-label="New collection">
						<Plus className="w-3.5 h-3.5" />
					</Button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent align="start" className="w-64 space-y-3">
				<div className="space-y-1.5">
					<label className="text-xs font-medium text-muted-foreground">Name</label>
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Collection name"
						autoFocus
						onKeyDown={(e) => {
							if (e.key === "Enter") handleCreate();
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
									color === c.name && "ring-2 ring-offset-2 ring-offset-popover ring-foreground",
								)}
							/>
						))}
					</div>
				</div>
				<Button size="sm" className="w-full" onClick={handleCreate} disabled={!name.trim() || creating}>
					{creating ? "Creating…" : "Create collection"}
				</Button>
			</PopoverContent>
		</Popover>
	);
}
