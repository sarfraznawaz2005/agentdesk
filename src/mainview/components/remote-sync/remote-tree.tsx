import { useState, useEffect, useCallback, useRef } from "react";
import { rpc } from "@/lib/rpc";
import { ChevronRight, ChevronDown, Folder, File as FileIcon, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RemoteEntryDto, RemoteSelection } from "../../../shared/rpc/remote-sync";

/** POSIX join of a base path and a base-relative path. */
function abs(basePath: string, rel: string): string {
	const joined = [basePath, rel].filter(Boolean).join("/").replace(/\/{2,}/g, "/");
	return joined || "/";
}

function isAncestorOf(ancestor: string, p: string): boolean {
	return ancestor !== "" && p.startsWith(ancestor + "/");
}

interface TreeState {
	expanded: Set<string>;
	children: Record<string, RemoteEntryDto[]>;
	loading: Set<string>;
	errors: Record<string, string>;
}

export function RemoteTree({
	projectId,
	basePath,
	selections,
	onChange,
}: {
	projectId: string;
	basePath: string;
	selections: RemoteSelection[];
	onChange: (next: RemoteSelection[]) => void;
}) {
	const [tree, setTree] = useState<TreeState>({ expanded: new Set(), children: {}, loading: new Set(), errors: {} });
	const [rootLoaded, setRootLoaded] = useState(false);
	const [rootError, setRootError] = useState<string | null>(null);

	// Mirror of `tree` for synchronous reads in event handlers (so we never call side effects
	// from inside a setState updater — which React StrictMode double-invokes). Updated in an
	// effect (not during render); event handlers fire after render+effects, so it's current.
	const treeRef = useRef(tree);
	useEffect(() => {
		treeRef.current = tree;
	}, [tree]);
	const load = useCallback(
		async (rel: string) => {
			setTree((t) => ({ ...t, loading: new Set(t.loading).add(rel), errors: { ...t.errors, [rel]: "" } }));
			try {
				const res = await rpc.browseRemoteDir(projectId, abs(basePath, rel));
				setTree((t) => ({
					...t,
					children: { ...t.children, [rel]: res.entries },
					errors: res.error ? { ...t.errors, [rel]: res.error } : t.errors,
					loading: new Set([...t.loading].filter((x) => x !== rel)),
				}));
				if (rel === "") {
					setRootLoaded(true);
					setRootError(res.error ?? null);
				}
			} catch {
				setTree((t) => ({
					...t,
					errors: { ...t.errors, [rel]: "Failed to list directory." },
					loading: new Set([...t.loading].filter((x) => x !== rel)),
				}));
				if (rel === "") {
					setRootLoaded(true);
					setRootError("Failed to list directory.");
				}
			}
		},
		[projectId, basePath],
	);

	// Load the root on mount. The parent remounts this component (via a `key` of
	// projectId+basePath) when either changes, so fresh state is guaranteed without an
	// in-effect reset, and an in-flight load from a prior path lands on an unmounted
	// instance (React ignores it) — no stale overwrite. Deferred a tick so the load's first
	// setState isn't synchronous within the effect (the root shows its spinner via rootLoaded).
	useEffect(() => {
		const id = setTimeout(() => void load(""), 0);
		return () => clearTimeout(id);
	}, [load]);

	const toggleExpand = (rel: string, type: RemoteEntryDto["type"]) => {
		if (type !== "dir") return;
		const t = treeRef.current;
		const willExpand = !t.expanded.has(rel);
		setTree((prev) => {
			const expanded = new Set(prev.expanded);
			if (expanded.has(rel)) expanded.delete(rel);
			else expanded.add(rel);
			return { ...prev, expanded };
		});
		// Load children on first expand (outside the updater, guarded against double-load).
		if (willExpand && !t.children[rel] && !t.loading.has(rel)) void load(rel);
	};

	const exactSelected = (rel: string) => selections.some((s) => s.path === rel);
	const impliedSelected = (rel: string) => selections.some((s) => s.type === "dir" && isAncestorOf(s.path, rel));

	const toggleSelect = (rel: string, type: "dir" | "file") => {
		if (exactSelected(rel)) {
			onChange(selections.filter((s) => s.path !== rel));
		} else {
			// Add this node; drop any now-redundant descendant selections.
			const pruned = selections.filter((s) => !(type === "dir" && isAncestorOf(rel, s.path)) && s.path !== rel);
			onChange([...pruned, { path: rel, type }]);
		}
	};

	const renderNodes = (parentRel: string, depth: number) => {
		const entries = tree.children[parentRel];
		if (!entries) return null;
		return entries.map((entry) => {
			if (entry.type === "symlink") return null; // not syncable
			const rel = parentRel ? `${parentRel}/${entry.name}` : entry.name;
			const isDir = entry.type === "dir";
			const isExpanded = tree.expanded.has(rel);
			const implied = impliedSelected(rel);
			const checked = implied || exactSelected(rel);
			return (
				<div key={rel}>
					<div
						className="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/50"
						style={{ paddingLeft: depth * 16 + 4 }}
					>
						<button
							type="button"
							onClick={() => toggleExpand(rel, entry.type)}
							className={cn("flex h-4 w-4 items-center justify-center text-muted-foreground", !isDir && "invisible")}
							aria-label={isExpanded ? "Collapse" : "Expand"}
						>
							{tree.loading.has(rel) ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : isExpanded ? (
								<ChevronDown className="h-3.5 w-3.5" />
							) : (
								<ChevronRight className="h-3.5 w-3.5" />
							)}
						</button>
						<input
							type="checkbox"
							checked={checked}
							disabled={implied}
							onChange={() => toggleSelect(rel, isDir ? "dir" : "file")}
							className="h-3.5 w-3.5 shrink-0 accent-primary disabled:opacity-50"
							title={implied ? "Included via a selected parent folder" : undefined}
						/>
						{isDir ? (
							<Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
						) : (
							<FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						)}
						<button
							type="button"
							onClick={() => (isDir ? toggleExpand(rel, entry.type) : toggleSelect(rel, "file"))}
							className="truncate text-left text-sm"
						>
							{entry.name}
						</button>
					</div>
					{tree.errors[rel] && (
						<div className="px-2 py-1 text-xs text-destructive" style={{ paddingLeft: depth * 16 + 28 }}>
							{tree.errors[rel]}
						</div>
					)}
					{isDir && isExpanded && renderNodes(rel, depth + 1)}
				</div>
			);
		});
	};

	return (
		<div className="rounded-md border border-border">
			<div className="flex items-center justify-between border-b border-border bg-muted/30 px-2 py-1.5">
				<span className="truncate font-mono text-xs text-muted-foreground">{basePath || "/"}</span>
				<button
					type="button"
					onClick={() => void load("")}
					className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
					title="Refresh"
				>
					<RefreshCw className="h-3 w-3" /> Refresh
				</button>
			</div>
			<div className="max-h-[460px] overflow-auto p-1">
				{!rootLoaded ? (
					<div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" /> Listing remote files…
					</div>
				) : rootError ? (
					<div className="px-2 py-6 text-sm text-destructive">{rootError}</div>
				) : (tree.children[""]?.length ?? 0) === 0 ? (
					<div className="px-2 py-6 text-sm text-muted-foreground">No files in this directory.</div>
				) : (
					renderNodes("", 0)
				)}
			</div>
		</div>
	);
}
