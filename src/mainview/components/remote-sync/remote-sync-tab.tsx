import { useState, useEffect, useCallback, useRef } from "react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Upload, Square, Loader2, ServerCog } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	useRemoteSyncStore,
	initRemoteSyncListeners,
	type RemoteSyncRunState,
} from "@/stores/remote-sync-store";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";
import { RemoteConnectionForm } from "./connection-form";
import { RemoteTree } from "./remote-tree";
import { PushDiffDialog } from "./push-diff-dialog";
import type {
	RemoteSyncConfigDto,
	RemoteSelection,
	RemoteSyncRunDto,
	PullConflictEntry,
} from "../../../shared/rpc/remote-sync";

function selectionsEqual(a: RemoteSelection[], b: RemoteSelection[]): boolean {
	if (a.length !== b.length) return false;
	const key = (s: RemoteSelection) => `${s.type}:${s.path}`;
	const sa = new Set(a.map(key));
	return b.every((s) => sa.has(key(s)));
}

function runStatusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
	if (status === "success") return "default";
	if (status === "error" || status === "failed") return "destructive";
	if (status === "partial") return "secondary";
	return "outline";
}

function ProgressView({ run }: { run: RemoteSyncRunState }) {
	const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : run.running ? 0 : 100;
	return (
		<div className="space-y-2 rounded-lg border border-border bg-card p-4">
			<div className="flex items-center gap-2 text-sm">
				<Badge variant={run.running ? "secondary" : runStatusVariant(run.status)}>
					{run.direction === "pull" ? "Download" : "Upload"}
				</Badge>
				{run.running && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
				{run.running && run.total === 0 ? (
					<span className="font-medium text-muted-foreground">Connecting…</span>
				) : (
					<>
						<span className="font-medium">
							{run.done}/{run.total} files
						</span>
						<span className="text-emerald-600 dark:text-emerald-400">{run.ok} ok</span>
						{run.failed > 0 && <span className="text-destructive">{run.failed} failed</span>}
					</>
				)}
			</div>
			<div className="h-2 w-full overflow-hidden rounded-full bg-muted">
				<div
					className={cn("h-full transition-all", run.failed > 0 ? "bg-amber-500" : "bg-primary")}
					style={{ width: `${pct}%` }}
				/>
			</div>
			{run.running && run.currentFile && (
				<p className="truncate font-mono text-xs text-muted-foreground">{run.currentFile}</p>
			)}
			{run.summary && !run.running && <p className="text-sm text-muted-foreground">{run.summary}</p>}
			{run.error && <p className="text-sm text-destructive">{run.error}</p>}
		</div>
	);
}

export function RemoteSyncTab({ projectId }: { projectId: string }) {
	const [config, setConfig] = useState<RemoteSyncConfigDto | null>(null);
	const [configLoaded, setConfigLoaded] = useState(false);
	const [selections, setSelections] = useState<RemoteSelection[]>([]);
	const [runs, setRuns] = useState<RemoteSyncRunDto[]>([]);
	const [subTab, setSubTab] = useState("files");
	const [pushOpen, setPushOpen] = useState(false);
	const [savingSel, setSavingSel] = useState(false);
	const [pullConflicts, setPullConflicts] = useState<PullConflictEntry[] | null>(null);
	const [checkingPull, setCheckingPull] = useState(false);
	const [checkingPush, setCheckingPush] = useState(false);

	const run = useRemoteSyncStore((s) => s.runByProject[projectId]);
	const logs = useRemoteSyncStore((s) => s.logsByProject[projectId]);
	const logRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		initRemoteSyncListeners();
	}, []);

	const loadConfig = useCallback(async () => {
		try {
			const res = await rpc.getRemoteSyncConfig(projectId);
			setConfig(res.config);
			setSelections(res.config?.selections ?? []);
		} catch {
			/* ignore */
		} finally {
			setConfigLoaded(true);
		}
	}, [projectId]);

	const loadRuns = useCallback(async () => {
		try {
			const res = await rpc.listRemoteSyncRuns(projectId);
			setRuns(res.runs);
		} catch {
			/* ignore */
		}
	}, [projectId]);

	useEffect(() => {
		void loadConfig();
		void loadRuns();
	}, [loadConfig, loadRuns]);

	// Refresh history when a run finishes; surface a failed run (e.g. the connection
	// dropped mid-operation) as a toast so the user isn't left watching a stalled bar.
	useEffect(() => {
		const onDone = () => void loadRuns();
		const onErr = (e: Event) => {
			const d = (e as CustomEvent<{ projectId: string; error?: string }>).detail;
			if (d?.projectId === projectId) toast("error", d.error ?? "Remote sync failed.");
			void loadRuns();
		};
		window.addEventListener("agentdesk:remotesync-run-complete", onDone);
		window.addEventListener("agentdesk:remotesync-run-error", onErr);
		return () => {
			window.removeEventListener("agentdesk:remotesync-run-complete", onDone);
			window.removeEventListener("agentdesk:remotesync-run-error", onErr);
		};
	}, [loadRuns, projectId]);

	// Auto-scroll the log to the bottom as lines stream in.
	useEffect(() => {
		if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
	}, [logs]);

	const configured = !!config && !!config.host;
	const running = run?.running ?? false;
	const selectionDirty = !selectionsEqual(selections, config?.selections ?? []);

	const saveSelection = useCallback(async () => {
		setSavingSel(true);
		try {
			const res = await rpc.saveRemoteSyncConfig(projectId, { selections });
			setConfig(res.config);
			toast("success", "Selection saved.");
		} catch {
			toast("error", "Failed to save selection.");
		} finally {
			setSavingSel(false);
		}
	}, [projectId, selections]);

	const doStartPull = useCallback(async () => {
		try {
			const res = await rpc.startRemotePull(projectId);
			if (!res.ok) {
				toast("error", res.error ?? "Could not start download.");
				return;
			}
			if (res.runId) useRemoteSyncStore.getState().beginConnecting(projectId, res.runId, "pull");
			setSubTab("activity");
		} catch {
			toast("error", "Could not start download.");
		}
	}, [projectId]);

	const onPull = useCallback(async () => {
		setCheckingPull(true);
		try {
			// Persist the current selection first so the backend pulls exactly what's shown
			// (and the conflict preflight examines the same set).
			if (selectionDirty) {
				const res = await rpc.saveRemoteSyncConfig(projectId, { selections });
				setConfig(res.config);
			}
			// Establish the connection up front: the button shows a spinner while we connect,
			// and a clear toast fires if the server is unreachable — instead of a silent gap
			// followed by a failure buried in the activity log.
			const test = await rpc.testRemoteConnection(projectId);
			if (!test.ok) {
				toast("error", test.error ?? "Could not connect to the server.");
				return;
			}
			// Overwrite guard: if any selected file has un-pushed local edits, confirm first.
			const { conflicts, error } = await rpc.computeRemotePullConflicts(projectId);
			if (error) {
				toast("error", error);
				return;
			}
			if (conflicts.length > 0) {
				setPullConflicts(conflicts);
				return; // wait for the user to confirm in the dialog
			}
			await doStartPull();
		} catch {
			toast("error", "Could not start download.");
		} finally {
			setCheckingPull(false);
		}
	}, [projectId, selections, selectionDirty, doStartPull]);

	const onConfirmOverwritePull = useCallback(async () => {
		setPullConflicts(null);
		await doStartPull();
	}, [doStartPull]);

	const onPushClick = useCallback(async () => {
		setCheckingPush(true);
		try {
			// Same as pull: confirm the server is reachable before opening the diff dialog,
			// so the user gets a spinner + a toast on failure rather than a silent wait.
			const test = await rpc.testRemoteConnection(projectId);
			if (!test.ok) {
				toast("error", test.error ?? "Could not connect to the server.");
				return;
			}
			setPushOpen(true);
		} catch {
			toast("error", "Could not connect to the server.");
		} finally {
			setCheckingPush(false);
		}
	}, [projectId]);

	const onPushConfirm = useCallback(
		async (remotePaths: string[]) => {
			try {
				const res = await rpc.startRemotePush(projectId, remotePaths);
				if (!res.ok) {
					toast("error", res.error ?? "Could not start upload.");
					return;
				}
				if (res.runId) useRemoteSyncStore.getState().beginConnecting(projectId, res.runId, "push");
				setSubTab("activity");
			} catch {
				toast("error", "Could not start upload.");
			}
		},
		[projectId],
	);

	const onCancel = useCallback(() => {
		rpc.cancelRemoteSync(projectId).catch(() => {});
	}, [projectId]);

	const selectedCount = selections.length;

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-5xl px-4 py-6">
				<div className="mb-4 flex items-center justify-between gap-4">
					<div className="flex items-center gap-3">
						<ServerCog className="h-6 w-6 text-muted-foreground" />
						<div>
							<h2 className="text-xl font-semibold text-foreground">Remote Sync</h2>
							<p className="text-sm text-muted-foreground">
								{configured ? (
									<>
										<span className="font-mono">{config && `${config.protocol}://${config.username ? `${config.username}@` : ""}${config.host}`}</span>
										{" — download selected files to work on locally, then push your changes back."}
									</>
								) : (
									"Connect to an SFTP/FTP server to download files into this project and push changes back."
								)}
							</p>
						</div>
					</div>
					{configured && (
						<div className="flex items-center gap-2">
							{running ? (
								<Button variant="destructive" size="sm" onClick={onCancel}>
									<Square className="h-4 w-4 fill-current" /> Stop
								</Button>
							) : (
								<>
									<Button variant="outline" size="sm" onClick={onPull} disabled={selectedCount === 0 || checkingPull} title={selectedCount === 0 ? "Select files in the Files tab first." : undefined}>
										{checkingPull ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Pull selected
									</Button>
									<Button size="sm" onClick={onPushClick} disabled={checkingPush}>
										{checkingPush ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Push changes
									</Button>
								</>
							)}
						</div>
					)}
				</div>

				{!configLoaded ? (
					<div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Loading…</div>
				) : (
					<Tabs value={subTab} onValueChange={setSubTab}>
						<TabsList>
							<TabsTrigger value="files">Files</TabsTrigger>
							<TabsTrigger value="activity">
								Activity {running && <Loader2 className="ml-1 h-3 w-3 animate-spin" />}
							</TabsTrigger>
							<TabsTrigger value="connection">Connection</TabsTrigger>
						</TabsList>

						{/* Files — remote tree + selection */}
						<TabsContent value="files" className="pt-4">
							{!configured ? (
								<div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
									Configure a connection in the{" "}
									<button type="button" onClick={() => setSubTab("connection")} className="font-medium text-primary hover:underline">
										Connection
									</button>{" "}
									tab to browse and select remote files.
								</div>
							) : (
								<div className="space-y-3">
									<div className="flex items-center justify-between">
										<p className="text-sm text-muted-foreground">
											Tick the folders and files to sync. {selectedCount} selected.
										</p>
										<Button size="sm" variant="outline" onClick={saveSelection} disabled={!selectionDirty || savingSel}>
											{savingSel ? "Saving…" : selectionDirty ? "Save selection" : "Saved"}
										</Button>
									</div>
									<RemoteTree
										key={`${projectId}:${config?.remoteBasePath ?? "/"}`}
										projectId={projectId}
										basePath={config?.remoteBasePath ?? "/"}
										selections={selections}
										onChange={setSelections}
									/>
									{selectedCount > 0 && (
										<div className="flex flex-wrap gap-1.5">
											{selections.map((s) => (
												<Badge
													key={`${s.type}:${s.path}`}
													variant="secondary"
													className="cursor-pointer font-mono text-xs"
													onClick={() => setSelections(selections.filter((x) => x.path !== s.path))}
													title="Remove from selection"
												>
													{s.type === "dir" ? "📁" : "📄"} {s.path || "/"} ✕
												</Badge>
											))}
										</div>
									)}
								</div>
							)}
						</TabsContent>

						{/* Activity — live progress, logs, history */}
						<TabsContent value="activity" className="space-y-4 pt-4">
							{run ? <ProgressView run={run} /> : (
								<div className="rounded-lg border border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
									No sync running. Use “Pull selected” or “Push changes” above.
								</div>
							)}

							{logs && logs.length > 0 && (
								<div>
									<p className="mb-1 text-xs font-medium text-muted-foreground">Operation log</p>
									<div ref={logRef} className="max-h-52 overflow-auto rounded-md border border-border bg-muted/20 p-2 font-mono text-xs">
										{logs.map((l, i) => (
											<div
												key={i}
												className={cn(
													l.level === "error" && "text-destructive",
													l.level === "warn" && "text-amber-600 dark:text-amber-400",
													l.level === "info" && "text-muted-foreground",
												)}
											>
												{l.message}
											</div>
										))}
									</div>
								</div>
							)}

							<div>
								<p className="mb-1 text-xs font-medium text-muted-foreground">Recent operations</p>
								{runs.length === 0 ? (
									<p className="py-4 text-center text-sm text-muted-foreground">No operations yet.</p>
								) : (
									<div className="overflow-x-auto rounded-lg border border-border">
										<table className="w-full text-sm">
											<thead className="bg-muted/40 text-left text-xs text-muted-foreground">
												<tr>
													<th className="px-3 py-2">Started</th>
													<th className="px-3 py-2">Type</th>
													<th className="px-3 py-2">Files</th>
													<th className="px-3 py-2">Status</th>
													<th className="px-3 py-2">Summary</th>
												</tr>
											</thead>
											<tbody>
												{runs.map((r) => (
													<tr key={r.id} className="border-t border-border">
														<td className="px-3 py-2 text-xs text-muted-foreground">{r.startedAt}</td>
														<td className="px-3 py-2 capitalize">{r.direction}</td>
														<td className="px-3 py-2 text-xs">
															{r.okFiles}/{r.totalFiles}{r.failedFiles ? ` (${r.failedFiles} failed)` : ""}
														</td>
														<td className="px-3 py-2"><Badge variant={runStatusVariant(r.status)}>{r.status}</Badge></td>
														<td className="px-3 py-2 text-xs text-muted-foreground">{r.error ?? r.summary ?? "—"}</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								)}
							</div>
						</TabsContent>

						{/* Connection — config form */}
						<TabsContent value="connection" className="pt-4">
							<RemoteConnectionForm
								projectId={projectId}
								config={config}
								onSaved={(c) => {
									setConfig(c);
									setSelections(c.selections);
								}}
							/>
						</TabsContent>
					</Tabs>
				)}
			</div>

			<PushDiffDialog projectId={projectId} open={pushOpen} onOpenChange={setPushOpen} onConfirm={onPushConfirm} />

			<Dialog open={!!pullConflicts} onOpenChange={(o) => !o && setPullConflicts(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<AlertTriangle className="h-5 w-5 text-amber-500" />
							Overwrite local changes?
						</DialogTitle>
						<DialogDescription>
							{pullConflicts?.length === 1 ? "1 selected file has" : `${pullConflicts?.length ?? 0} selected files have`}{" "}
							local edits that haven't been pushed. Pulling will overwrite{" "}
							{pullConflicts?.length === 1 ? "it" : "them"} with the server copy. Push your changes first if you
							want to keep this work.
						</DialogDescription>
					</DialogHeader>
					<div className="max-h-60 overflow-auto rounded-md border border-border bg-muted/20 p-2 font-mono text-xs">
						{pullConflicts?.map((c) => (
							<div key={c.remotePath} className="truncate text-amber-700 dark:text-amber-400" title={c.remotePath}>
								{c.remotePath}
							</div>
						))}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setPullConflicts(null)}>
							Cancel
						</Button>
						<Button variant="destructive" onClick={onConfirmOverwritePull}>
							Overwrite &amp; pull
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
