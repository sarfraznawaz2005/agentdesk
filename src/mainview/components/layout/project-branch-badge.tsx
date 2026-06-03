import { useState, useEffect, useRef, useCallback } from "react";
import { GitBranch } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { Tip } from "@/components/ui/tooltip";

/**
 * Live current-branch indicator for the navbar. Shows the ACTUAL checked-out branch (git HEAD)
 * of the open project — not the saved working branch — and keeps it fresh while the project page
 * is open: polls on a short interval, refreshes immediately on window focus / tab re-show, and
 * pauses while the window is hidden. Cheap (`git rev-parse`) and non-blocking — never overlaps
 * requests, ignores errors, and renders nothing for non-git projects.
 */
const POLL_MS = 5000;

export function ProjectBranchBadge({ projectId }: { projectId: string }) {
	const [branch, setBranch] = useState<string | null>(null);
	const inFlight = useRef(false);

	const refresh = useCallback(async () => {
		if (inFlight.current) return; // never run two reads at once
		inFlight.current = true;
		try {
			const res = await rpc.getCurrentBranch(projectId);
			setBranch(res.branch);
		} catch {
			/* keep the last known value */
		} finally {
			inFlight.current = false;
		}
	}, [projectId]);

	useEffect(() => {
		setBranch(null);
		void refresh();
		const id = setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, POLL_MS);
		const onWake = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		window.addEventListener("focus", onWake);
		document.addEventListener("visibilitychange", onWake);
		return () => {
			clearInterval(id);
			window.removeEventListener("focus", onWake);
			document.removeEventListener("visibilitychange", onWake);
		};
	}, [refresh]);

	if (!branch) return null;

	return (
		<Tip content="Current branch — the branch your code is actually on right now (live)." side="bottom">
			<span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
				<GitBranch className="h-3 w-3 shrink-0" />
				<span className="max-w-[200px] truncate font-mono">{branch}</span>
			</span>
		</Tip>
	);
}
