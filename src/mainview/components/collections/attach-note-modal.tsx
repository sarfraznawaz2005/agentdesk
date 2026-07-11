import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { rpc } from "@/lib/rpc";
import type { CollectionAttachPickerResultDto } from "../../../shared/rpc/collections";

// Shared modal for the "Attach a note" entry point in chat-input.tsx
// (docs/collections-plan.md §8). Search is cross-collection by design — the
// picker has no scope switch, unlike the Library's own search box.
export function AttachNoteModal({
	open,
	onOpenChange,
	onAttach,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onAttach: (note: { id: string; title: string; contentMarkdown: string }) => void;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<CollectionAttachPickerResultDto[]>([]);
	const [loading, setLoading] = useState(true);
	const [attachingId, setAttachingId] = useState<string | null>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setAttachingId(null);
		setLoading(true);
		rpc
			.listNotesForAttachPicker({})
			.then(setResults)
			.catch((err) => console.error("Failed to load notes for attach picker:", err))
			.finally(() => setLoading(false));
	}, [open]);

	useEffect(() => {
		if (!open) return;
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			setLoading(true);
			rpc
				.listNotesForAttachPicker({ query: query.trim() || undefined })
				.then(setResults)
				.catch((err) => console.error("Failed to search notes for attach picker:", err))
				.finally(() => setLoading(false));
		}, 200);
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
		// The [open] effect above already handles the initial load when the modal opens.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query]);

	async function handleSelect(note: CollectionAttachPickerResultDto) {
		if (attachingId) return;
		setAttachingId(note.id);
		try {
			const full = await rpc.getNoteContentForContext({ id: note.id });
			if (!full) throw new Error("getNoteContentForContext returned null");
			onAttach({ id: note.id, title: full.title, contentMarkdown: full.contentMarkdown });
			onOpenChange(false);
		} catch (err) {
			console.error("Failed to attach note:", err);
		} finally {
			setAttachingId(null);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Attach a note</DialogTitle>
				</DialogHeader>

				<div className="space-y-3 min-w-0">
					<div className="relative">
						<Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search notes…"
							className="pl-8"
							autoFocus
						/>
					</div>

					<div className="max-h-80 overflow-y-auto rounded-md border border-border min-w-0">
						{loading ? (
							<p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
						) : results.length === 0 ? (
							<p className="px-3 py-2 text-xs text-muted-foreground">No notes found.</p>
						) : (
							results.map((note) => (
								<button
									key={note.id}
									type="button"
									disabled={attachingId !== null}
									onClick={() => handleSelect(note)}
									className="flex w-full min-w-0 flex-col gap-0.5 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted disabled:opacity-60"
								>
									<span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
										<span className="min-w-0 flex-1 truncate">{note.title}</span>
										<span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
											{note.collectionName}
										</span>
									</span>
									<span className="block min-w-0 truncate text-xs text-muted-foreground">
										{attachingId === note.id ? "Attaching…" : note.snippet}
									</span>
								</button>
							))
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
