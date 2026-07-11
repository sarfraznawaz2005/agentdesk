import { useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Inline tag chip editor for the note editor's tags column (JSON string[] —
// see collection_notes.tags in schema.ts). Changes only take effect once the
// caller includes `tags` in its next updateCollectionNote save, matching the
// title/content dirty-then-Save flow (unlike the favorite star, which is an
// immediate RPC call).
export function TagEditor({
	tags,
	onChange,
	readOnly = false,
}: {
	tags: string[];
	onChange: (tags: string[]) => void;
	readOnly?: boolean;
}) {
	const [draft, setDraft] = useState("");

	function commitDraft() {
		const value = draft.trim();
		setDraft("");
		if (!value || tags.includes(value)) return;
		onChange([...tags, value]);
	}

	function removeTag(tag: string) {
		onChange(tags.filter((t) => t !== tag));
	}

	return (
		<div className={cn("flex flex-wrap items-center gap-1.5 min-h-7", readOnly && "pointer-events-none")}>
			{tags.map((tag) => (
				<Badge key={tag} variant="secondary" className="gap-1 pr-1 font-normal">
					{tag}
					{!readOnly && (
						<button
							type="button"
							onClick={() => removeTag(tag)}
							className="rounded-sm hover:bg-black/10 dark:hover:bg-white/10"
							aria-label={`Remove tag ${tag}`}
						>
							<X className="w-2.5 h-2.5" />
						</button>
					)}
				</Badge>
			))}
			{!readOnly && (
				<input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commitDraft();
						}
					}}
					onBlur={commitDraft}
					placeholder={tags.length === 0 ? "Add tags…" : "Add…"}
					className="min-w-16 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
				/>
			)}
		</div>
	);
}
