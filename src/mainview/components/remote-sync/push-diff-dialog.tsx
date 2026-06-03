import { useState, useEffect, useCallback } from "react";
import { rpc } from "@/lib/rpc";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle, ChevronRight, ChevronDown } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { UnifiedDiffCard } from "@/components/ui/unified-diff";
import { cn } from "@/lib/utils";
import type { PushDiffEntry } from "../../../shared/rpc/remote-sync";

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_STYLE: Record<PushDiffEntry["status"], string> = {
	new: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	modified: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
	deleted: "bg-destructive/15 text-destructive",
};

interface FileDiff {
	local: string;
	remote: string;
	remoteExists: boolean;
	binary: boolean;
	tooLarge: boolean;
	error?: string;
}

/** One uploadable row: checkbox + status + path, with an expandable lazy-loaded diff. */
function PushFileRow({
	projectId,
	entry,
	checked,
	onToggle,
}: {
	projectId: string;
	entry: PushDiffEntry;
	checked: boolean;
	onToggle: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [diff, setDiff] = useState<FileDiff | null>(null);
	const [loading, setLoading] = useState(false);

	const toggleOpen = async () => {
		const next = !open;
		setOpen(next);
		if (next && !diff && !loading) {
			setLoading(true);
			try {
				setDiff(await rpc.getRemotePushFileDiff(projectId, entry.remotePath));
			} catch {
				setDiff({ local: "", remote: "", remoteExists: false, binary: false, tooLarge: false, error: "Failed to load diff." });
			} finally {
				setLoading(false);
			}
		}
	};

	return (
		<div className="border-b border-border last:border-0">
			<div className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40">
				<input
					type="checkbox"
					checked={checked}
					onChange={onToggle}
					className="h-3.5 w-3.5 shrink-0 accent-primary"
				/>
				<Badge variant="secondary" className={cn("w-[68px] justify-center", STATUS_STYLE[entry.status])}>
					{entry.status}
				</Badge>
				<span className="flex-1 truncate font-mono text-xs">{entry.remotePath}</span>
				{entry.remoteChanged === true && (
					<Tip content="The server copy changed since your last sync — uploading overwrites it.">
						<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
					</Tip>
				)}
				<button
					type="button"
					onClick={toggleOpen}
					className="inline-flex shrink-0 items-center gap-0.5 text-xs text-primary hover:underline"
				>
					{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
					diff
				</button>
				<span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{fmtBytes(entry.size)}</span>
			</div>
			{open && (
				<div className="px-3 pb-2.5">
					{loading ? (
						<div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
							<Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading diff from server…
						</div>
					) : !diff ? null : diff.error ? (
						<p className="py-2 text-xs text-destructive">{diff.error}</p>
					) : diff.binary ? (
						<p className="py-2 text-xs text-muted-foreground">Binary file — no text diff available.</p>
					) : diff.tooLarge ? (
						<p className="py-2 text-xs text-muted-foreground">File is too large to diff inline.</p>
					) : (
						<>
							<UnifiedDiffCard
								oldStr={diff.remote}
								newStr={diff.local}
								filePath={entry.remotePath}
								maxHeightClass="max-h-72"
							/>
							{!diff.remoteExists && (
								<p className="mt-1 text-[11px] text-muted-foreground">New file — not yet on the server (shown entirely as additions).</p>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

export function PushDiffDialog({
	projectId,
	open,
	onOpenChange,
	onConfirm,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Called with the remote paths the user chose to upload. */
	onConfirm: (remotePaths: string[]) => void;
}) {
	const [loading, setLoading] = useState(false);
	const [entries, setEntries] = useState<PushDiffEntry[]>([]);
	const [scanned, setScanned] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [checked, setChecked] = useState<Set<string>>(new Set());

	const compute = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await rpc.computeRemotePushDiff(projectId);
			setEntries(res.entries);
			setScanned(res.scanned);
			setError(res.error ?? null);
			// Pre-check uploadable files, but NOT ones whose server copy changed since the
			// last sync — the user must consciously opt in to overwrite those.
			setChecked(
				new Set(
					res.entries
						.filter((e) => e.status !== "deleted" && e.remoteChanged !== true)
						.map((e) => e.remotePath),
				),
			);
		} catch {
			setError("Failed to compute changes.");
		} finally {
			setLoading(false);
		}
	}, [projectId]);

	useEffect(() => {
		if (open) void compute();
	}, [open, compute]);

	const uploadable = entries.filter((e) => e.status !== "deleted");
	const deletions = entries.filter((e) => e.status === "deleted");
	const conflictCount = uploadable.filter((e) => e.remoteChanged === true).length;

	const toggle = (rel: string) => {
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(rel)) next.delete(rel);
			else next.add(rel);
			return next;
		});
	};

	const allChecked = uploadable.length > 0 && uploadable.every((e) => checked.has(e.remotePath));
	const toggleAll = () => {
		if (allChecked) setChecked(new Set());
		else setChecked(new Set(uploadable.map((e) => e.remotePath)));
	};

	const confirm = () => {
		onConfirm([...checked]);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-4xl w-[90vw]">
				<DialogHeader>
					<DialogTitle>Review changes to upload</DialogTitle>
					<DialogDescription>
						Only the files you check will be uploaded, overwriting the server copy. Nothing is ever
						deleted on the server.
					</DialogDescription>
				</DialogHeader>

				{loading ? (
					<div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" /> Comparing local files and checking the server…
					</div>
				) : error ? (
					<div className="py-6 text-sm text-destructive">{error}</div>
				) : entries.length === 0 ? (
					scanned === 0 ? (
						<div className="space-y-2 py-8 text-center text-sm text-muted-foreground">
							<p className="font-medium text-foreground">Nothing is selected to sync yet.</p>
							<p>
								In the <span className="font-medium">Files</span> tab, tick the folders or files you want to
								manage, then push. Files not yet on the server are offered as uploads; pull first if you want
								change-tracking against the server copy.
							</p>
						</div>
					) : (
						<div className="py-10 text-center text-sm text-muted-foreground">
							No changes in your selection since the last sync. Everything is up to date.
						</div>
					)
				) : (
					<div className="space-y-3">
						{conflictCount > 0 && (
							<div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
								<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
								<span>
									{conflictCount} file{conflictCount === 1 ? " has" : "s have"} changed on the server since your
									last sync. Those are left unchecked — checking one will overwrite the newer server copy.
								</span>
							</div>
						)}
						{uploadable.length > 0 && (
							<label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
								<input type="checkbox" checked={allChecked} onChange={toggleAll} className="h-3.5 w-3.5 accent-primary" />
								Select all uploadable ({uploadable.length})
							</label>
						)}
						<div className="max-h-[60vh] overflow-auto rounded-md border border-border">
							{uploadable.map((e) => (
								<PushFileRow
									key={e.remotePath}
									projectId={projectId}
									entry={e}
									checked={checked.has(e.remotePath)}
									onToggle={() => toggle(e.remotePath)}
								/>
							))}
							{deletions.map((e) => (
								<div
									key={e.remotePath}
									className="flex items-center gap-2 border-b border-border px-3 py-2 opacity-70 last:border-0"
									title="Deleted locally — the server copy is left untouched."
								>
									<span className="h-3.5 w-3.5" />
									<Badge variant="secondary" className={cn("w-[68px] justify-center", STATUS_STYLE[e.status])}>
										{e.status}
									</Badge>
									<span className="flex-1 truncate font-mono text-xs line-through">{e.remotePath}</span>
									<span className="shrink-0 text-xs text-muted-foreground">kept on server</span>
								</div>
							))}
						</div>
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
					<Button onClick={confirm} disabled={loading || checked.size === 0}>
						Upload {checked.size > 0 ? `${checked.size} file${checked.size === 1 ? "" : "s"}` : ""}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
