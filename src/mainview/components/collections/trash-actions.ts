import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import type { CollectionNoteSummaryDto } from "../../../shared/rpc/collections";

// Shared by note-list.tsx (card action) and note-editor.tsx (top-bar action) so
// the delete->Undo pattern behaves identically from either surface.
export async function softDeleteWithUndo(
	note: Pick<CollectionNoteSummaryDto, "id" | "title">,
	onRestored?: () => void,
): Promise<boolean> {
	const result = await rpc.softDeleteNote({ id: note.id });
	if (!result.success) return false;
	toast(
		"info",
		`"${note.title || "Untitled"}" moved to Trash.`,
		{
			label: "Undo",
			onClick: async () => {
				try {
					const r = await rpc.restoreNote({ id: note.id });
					if (r.success) onRestored?.();
				} catch (err) {
					console.error("Failed to restore note:", err);
				}
			},
		},
		{ autoDismiss: true },
	);
	return true;
}
