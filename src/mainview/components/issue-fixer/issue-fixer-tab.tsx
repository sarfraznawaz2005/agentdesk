import { useState, useEffect, useCallback, useRef } from "react";
import { rpc } from "@/lib/rpc";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ExternalLink, RefreshCw, Square } from "lucide-react";
import { useIssueFixerStore, initIssueFixerListeners, type IssueFixerPart } from "@/stores/issue-fixer-store";
import { MessageParts, TextBlock, type MessagePartData } from "@/components/chat/message-parts";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { IssueFixerSettingsTab } from "@/components/issue-fixer/issue-fixer-settings";
import { useUnreadStore, hasUnread } from "@/stores/unread-store";
import { UnreadDot } from "@/components/ui/unread-dot";
import type { IssueFixRunDto, IssueFixerConfigDto } from "../../../shared/rpc/issue-fixer";

/** Map a streamed Issue Fixer part to the shape MessageParts renders (tool-call cards + markdown). */
function toPartData(p: IssueFixerPart): MessagePartData {
	return {
		id: p.id,
		messageId: "issue-fixer",
		type: p.type,
		content: p.content,
		toolName: p.toolName ?? null,
		toolInput: p.toolInput ?? null,
		toolOutput: p.toolOutput ?? null,
		toolState: p.toolState ?? null,
		sortOrder: p.sortOrder,
		timeStart: p.timeStart ?? null,
		timeEnd: p.timeEnd ?? null,
		createdAt: new Date().toISOString(),
		agentName: p.agentName,
	};
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
	if (status === "pr_created" || status === "pr_updated") return "default";
	if (status === "failed") return "destructive";
	if (status === "ignored" || status === "cancelled") return "outline";
	return "secondary";
}

export function IssueFixerProjectTab({ projectId }: { projectId: string }) {
	const run = useIssueFixerStore((s) => s.byProject[projectId]);
	const [config, setConfig] = useState<IssueFixerConfigDto | null>(null);
	const [configLoaded, setConfigLoaded] = useState(false);
	const [runs, setRuns] = useState<IssueFixRunDto[]>([]);
	const [selected, setSelected] = useState<IssueFixRunDto | null>(null);
	const [tab, setTab] = useState("activity");
	const [polling, setPolling] = useState(false);
	const [confirmStop, setConfirmStop] = useState(false);
	// Unread completed-run activity surfaced on the History inner tab.
	const historyUnread = useUnreadStore(hasUnread(projectId, "issue-fixer:history"));
	const markSeen = useUnreadStore((s) => s.markSeen);
	const scrollRef = useRef<HTMLDivElement>(null);
	// Whether the activity log is "stuck" to the bottom. Starts true so a fresh run
	// auto-scrolls; flips false when the user scrolls up to read, true again when they
	// return near the bottom — so streaming never yanks them away from what they're reading.
	const stickToBottom = useRef(true);

	useEffect(() => {
		initIssueFixerListeners();
	}, []);

	// Hydrate the live run from the backend's in-memory snapshot on mount. Covers runs
	// whose start/part broadcasts the webview missed (e.g. the startup poll firing before
	// listeners attached) — without this the Activity tab shows nothing or a bogus "#0" card.
	useEffect(() => {
		rpc
			.getActiveIssueFixRun(projectId)
			.then((res) => {
				if (res.run) {
					useIssueFixerStore.getState().hydrate(projectId, {
						runId: res.run.runId,
						issueNumber: res.run.issueNumber,
						issueTitle: res.run.issueTitle,
						intent: res.run.intent,
						status: res.run.status,
						running: res.run.running,
						parts: res.run.parts as unknown as IssueFixerPart[],
						prNumber: res.run.prNumber,
						prUrl: res.run.prUrl,
						error: res.run.error,
					});
				}
			})
			.catch(() => {});
	}, [projectId]);

	// Opening the History tab marks its completed-run activity read (and clears it
	// immediately if a run finishes while History is the active inner tab).
	useEffect(() => {
		if (tab === "history" && historyUnread) markSeen(projectId, "issue-fixer:history");
	}, [tab, historyUnread, projectId, markSeen]);

	const onActivityScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	}, []);

	// Auto-scroll the activity log to the bottom as parts stream in (mirrors the
	// Playground agent + chat behavior), but only while the user is parked at the bottom.
	useEffect(() => {
		if (tab === "activity" && stickToBottom.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [run?.parts, run?.running, tab]);

	const stopRun = useCallback(() => setConfirmStop(true), []);
	const doStopRun = useCallback(() => {
		if (run?.runId) rpc.cancelIssueFixRun(run.runId).catch(() => {});
	}, [run?.runId]);

	const loadRuns = useCallback(async () => {
		try {
			const res = await rpc.listIssueFixRuns(projectId);
			setRuns(res.runs);
		} catch {
			/* ignore */
		}
	}, [projectId]);

	const loadConfig = useCallback(async () => {
		try {
			const res = await rpc.getIssueFixerConfig(projectId);
			setConfig(res.config);
		} catch {
			/* ignore */
		} finally {
			setConfigLoaded(true);
		}
	}, [projectId]);

	useEffect(() => {
		void loadRuns();
		void loadConfig();
	}, [loadRuns, loadConfig]);

	const enabled = config?.enabled ?? false;

	// Refresh history when a run finishes.
	useEffect(() => {
		const h = () => void loadRuns();
		window.addEventListener("agentdesk:issuefixer-run-complete", h);
		window.addEventListener("agentdesk:issuefixer-run-error", h);
		return () => {
			window.removeEventListener("agentdesk:issuefixer-run-complete", h);
			window.removeEventListener("agentdesk:issuefixer-run-error", h);
		};
	}, [loadRuns]);

	const pollNow = useCallback(async () => {
		setPolling(true);
		try {
			const res = await rpc.pollIssueFixerNow(projectId);
			await loadRuns();
			if (!res.ok) {
				toast("error", res.error ?? "Poll failed.");
			} else if (res.reason === "no-credentials") {
				toast("error", "Set a GitHub repository URL and token first.");
			} else if (res.reason === "primed") {
				toast("info", "Now watching this repository for new agentdesk-* issues.");
			} else if ((res.enqueued ?? 0) > 0) {
				const n = res.enqueued ?? 0;
				toast("success", `Found ${n} matching issue${n === 1 ? "" : "s"} — fixing now.`);
			} else if ((res.ignored ?? 0) > 0) {
				const n = res.ignored ?? 0;
				toast("info", `Found ${n} match${n === 1 ? "" : "es"} from an unauthorized author — ignored.`);
			} else {
				toast("info", "No new issues found.");
			}
		} catch {
			toast("error", "Poll failed.");
		} finally {
			setPolling(false);
		}
	}, [projectId, loadRuns]);

	return (
		<div ref={scrollRef} onScroll={onActivityScroll} className="h-full overflow-y-auto">
			<div className="max-w-6xl mx-auto px-4 py-6">
				<div className="mb-4 flex items-center justify-between">
					<div>
						<h2 className="text-xl font-semibold text-foreground">Auto Issues Fixer</h2>
						<p className="text-sm text-muted-foreground">
							Autonomous fixes from GitHub issues. Configure triggers in the Configuration tab.
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={pollNow}
						disabled={polling || !enabled}
						title={enabled ? undefined : "Enable Issue Fixer in the Configuration tab first."}
					>
						<RefreshCw className={polling ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
						Poll now
					</Button>
				</div>

				<Tabs value={tab} onValueChange={setTab}>
					<TabsList>
						<TabsTrigger value="activity">
							Activity {run?.running && <Loader2 className="ml-1 h-3 w-3 animate-spin" />}
						</TabsTrigger>
						<TabsTrigger value="history" className="inline-flex items-center gap-1.5">
							History
							{historyUnread && <UnreadDot />}
						</TabsTrigger>
						<TabsTrigger value="configuration">Configuration</TabsTrigger>
					</TabsList>

					{/* Activity — live run, streamed like the Playground agent. */}
					<TabsContent value="activity" className="pt-4">
						{!run ? (
							<div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
								{enabled ? (
									<>
										Watching this repository. When an authorized <code>agentdesk-*</code> issue or comment
										arrives, the fix will appear here live.
									</>
								) : (
									<>
										Issue Fixer is <span className="font-medium text-foreground">disabled</span> for this
										project. Enable it in the{" "}
										<button
											type="button"
											onClick={() => setTab("configuration")}
											className="font-medium text-primary hover:underline"
										>
											Configuration
										</button>{" "}
										tab to start watching this repository.
									</>
								)}
							</div>
						) : (
							<div className="space-y-4">
								<div className="flex items-center gap-2">
									<Badge variant={statusVariant(run.status)}>{run.status}</Badge>
									<span className="text-sm font-medium">
										#{run.issueNumber} — {run.issueTitle}
									</span>
									<span className="text-xs text-muted-foreground">({run.intent})</span>
									{run.running && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
									{run.running && (
										<Button
											variant="destructive"
											size="sm"
											className="ml-auto"
											onClick={stopRun}
										>
											<Square className="h-4 w-4 fill-current" />
											Stop
										</Button>
									)}
								</div>

								{run.prUrl && (
									<a
										href={run.prUrl}
										onClick={(e) => {
											e.preventDefault();
											if (run.prUrl) rpc.openExternalUrl(run.prUrl).catch(() => {});
										}}
										className="inline-flex cursor-pointer items-center gap-1 text-sm text-primary hover:underline"
									>
										View PR #{run.prNumber} <ExternalLink className="h-3 w-3" />
									</a>
								)}
								{run.error && <p className="text-sm text-destructive">{run.error}</p>}

								<MessageParts
									parts={run.parts.map(toPartData)}
									hasRunningAgents={run.running}
									onStopAgent={run.running ? stopRun : undefined}
								/>
							</div>
						)}
					</TabsContent>

					{/* History — every issue seen, with status + PR links. */}
					<TabsContent value="history" className="pt-4">
						{runs.length === 0 ? (
							<p className="py-8 text-center text-sm text-muted-foreground">No runs yet.</p>
						) : (
							<div className="overflow-x-auto rounded-lg border border-border">
								<table className="w-full text-sm">
									<thead className="bg-muted/40 text-left text-xs text-muted-foreground">
										<tr>
											<th className="px-3 py-2">Started</th>
											<th className="px-3 py-2">Issue</th>
											<th className="px-3 py-2">Trigger</th>
											<th className="px-3 py-2">Intent</th>
											<th className="px-3 py-2">Status</th>
											<th className="px-3 py-2">PR</th>
										</tr>
									</thead>
									<tbody>
										{runs.map((r) => (
											<tr
												key={r.id}
												onClick={() => setSelected(r)}
												className="cursor-pointer border-t border-border hover:bg-muted/30"
											>
												<td className="px-3 py-2 text-xs text-muted-foreground">{r.startedAt}</td>
												<td className="px-3 py-2">#{r.issueNumber} {r.issueTitle}</td>
												<td className="px-3 py-2 text-xs">
													{r.triggerType}
													{r.triggerKeyword ? ` (${r.triggerKeyword})` : ""}
												</td>
												<td className="px-3 py-2 text-xs">{r.intent}</td>
												<td className="px-3 py-2">
													<Badge variant={statusVariant(r.status)}>{r.status}</Badge>
												</td>
												<td className="px-3 py-2 text-xs">
													{r.prUrl ? (
														<a
															href={r.prUrl}
															onClick={(e) => {
																e.preventDefault();
																e.stopPropagation();
																if (r.prUrl) rpc.openExternalUrl(r.prUrl).catch(() => {});
															}}
															className="inline-flex cursor-pointer items-center gap-1 text-primary hover:underline"
														>
															#{r.prNumber} <ExternalLink className="h-3 w-3" />
														</a>
													) : (
														"—"
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}

						<Dialog open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
							<DialogContent className="max-w-2xl">
								{selected && (
									<>
										<DialogHeader>
											<DialogTitle className="text-base">
												#{selected.issueNumber} — {selected.issueTitle}
											</DialogTitle>
										</DialogHeader>
										<dl className="space-y-1 text-xs text-muted-foreground">
											<div>Status: <Badge variant={statusVariant(selected.status)}>{selected.status}</Badge></div>
											<div>Intent: {selected.intent}</div>
											<div>Trigger: {selected.triggerType}{selected.triggerKeyword ? ` (${selected.triggerKeyword})` : ""}</div>
											<div>Author: {selected.author ?? "—"} {selected.authorized ? "" : "(unauthorized — ignored)"}</div>
											<div>Branch: {selected.branchName ?? "—"}</div>
											{selected.branchName && selected.testPassed != null && (
												<div>Tests: {selected.testPassed ? "passed" : "failed"}</div>
											)}
											{selected.prUrl && (
												<div>
													PR:{" "}
													<a
														href={selected.prUrl}
														onClick={(e) => {
															e.preventDefault();
															if (selected.prUrl) rpc.openExternalUrl(selected.prUrl).catch(() => {});
														}}
														className="cursor-pointer text-primary hover:underline"
													>
														#{selected.prNumber}
													</a>
												</div>
											)}
										</dl>
										{selected.summary && (
											<div className="max-h-[55vh] overflow-auto rounded bg-muted/30 p-3 text-sm">
												<TextBlock content={selected.summary} />
											</div>
										)}
										{selected.error && <p className="text-xs text-destructive">{selected.error}</p>}
									</>
								)}
							</DialogContent>
						</Dialog>
					</TabsContent>

					{/* Configuration — the per-project Issue Fixer settings (moved here from Project Settings). */}
					<TabsContent value="configuration" className="pt-4">
						<IssueFixerSettingsTab
							projectId={projectId}
							config={config}
							configLoaded={configLoaded}
							onSaved={loadConfig}
						/>
					</TabsContent>
				</Tabs>
			</div>

			<ConfirmationDialog
				open={confirmStop}
				onOpenChange={setConfirmStop}
				title="Stop the Issue Fixer?"
				description="The agent will stop immediately and abandon its in-progress work for this issue. Any commits already made on the branch are kept, but no pull request will be opened."
				confirmLabel="Stop agent"
				cancelLabel="Keep running"
				variant="destructive"
				onConfirm={doStopRun}
			/>
		</div>
	);
}
