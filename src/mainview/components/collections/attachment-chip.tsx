import { Paperclip, FolderOpen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { rpc } from "@/lib/rpc";
import type { CollectionAttachmentDto } from "../../../shared/rpc/collections";

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Download-only by design — this chip never renders a preview (no <img>, no
// inline content), regardless of mimeType. See docs/collections-plan.md §6.
export function AttachmentChip({
	attachment,
	onRemoved,
}: {
	attachment: CollectionAttachmentDto;
	onRemoved: (id: string) => void;
}) {
	async function handleShowInFolder() {
		try {
			await rpc.revealAttachment({ id: attachment.id });
		} catch (err) {
			console.error("Failed to reveal attachment:", err);
		}
	}

	async function handleRemove() {
		try {
			const res = await rpc.removeAttachment({ id: attachment.id });
			if (res.success) onRemoved(attachment.id);
		} catch (err) {
			console.error("Failed to remove attachment:", err);
		}
	}

	return (
		<div className="flex items-center gap-2.5 rounded-md border border-border bg-muted/30 px-3 py-2">
			<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
				<Paperclip className="h-4 w-4" />
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-foreground">{attachment.fileName}</p>
				<p className="text-xs text-muted-foreground">{formatFileSize(attachment.fileSize)} · download only, not previewed</p>
			</div>
			<Tip content="Show in folder">
				<Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={handleShowInFolder} aria-label="Show in folder">
					<FolderOpen className="h-3.5 w-3.5" />
				</Button>
			</Tip>
			<Tip content="Remove attachment">
				<Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={handleRemove} aria-label="Remove attachment">
					<X className="h-3.5 w-3.5" />
				</Button>
			</Tip>
		</div>
	);
}
