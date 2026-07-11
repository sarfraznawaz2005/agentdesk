import { useCallback, useEffect, useState } from "react";
import { Brain, CheckCircle2, Download, AlertCircle, RefreshCw, HardDrive, FolderOpen, SlidersHorizontal, Gauge } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import type { CollectionExportFormat, CollectionNoteSort, EmbeddingModelStatusDto } from "../../../shared/rpc/collections";

const MODEL_LABEL = "all-MiniLM-L6-v2";

const EXPORT_FORMAT_OPTIONS: { value: CollectionExportFormat; label: string }[] = [
	{ value: "markdown", label: "Markdown" },
	{ value: "pdf", label: "PDF" },
	{ value: "json", label: "JSON" },
];

const SORT_OPTIONS: { value: CollectionNoteSort; label: string }[] = [
	{ value: "updated", label: "Last updated" },
	{ value: "created", label: "Created" },
	{ value: "title", label: "Title A-Z" },
	{ value: "favorite", label: "Favorites first" },
];

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type LiveProgress = { status: "downloading" | "ready" | "error"; progress?: number; message?: string };

export function SettingsTab() {
	const [status, setStatus] = useState<EmbeddingModelStatusDto | null>(null);
	const [live, setLive] = useState<LiveProgress | null>(null);
	const [loading, setLoading] = useState(true);
	const [reindexing, setReindexing] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const result = await rpc.getEmbeddingModelStatus();
			setStatus(result);
		} catch (err) {
			console.error("Failed to load embedding model status:", err);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	// Live progress arrives via broadcast events while downloadEmbeddingModel() is
	// still pending — same fire-and-forget-events-alongside-a-pending-RPC shape the
	// app updater uses (see sidebar.tsx's agentdesk:update-status listener).
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<LiveProgress>).detail;
			setLive(detail);
			if (detail.status === "ready" || detail.status === "error") {
				refresh();
			}
		};
		window.addEventListener("agentdesk:collection-embedding-model-status", handler);
		return () => window.removeEventListener("agentdesk:collection-embedding-model-status", handler);
	}, [refresh]);

	async function handleDownload() {
		setLive({ status: "downloading", progress: 0, message: "Starting download…" });
		try {
			const result = await rpc.downloadEmbeddingModel();
			if (!result.success) {
				toast("error", "Model download failed — see Settings for details.");
			}
		} catch (err) {
			console.error("Failed to download embedding model:", err);
			toast("error", "Model download failed.");
		} finally {
			refresh();
		}
	}

	async function handleReindex() {
		setReindexing(true);
		try {
			const result = await rpc.reindexNotes();
			if (result.success) {
				toast("success", `Re-indexed ${result.indexed} note${result.indexed === 1 ? "" : "s"}.`);
			} else {
				toast("error", "Re-index failed — download the model first.");
			}
		} catch (err) {
			console.error("Failed to reindex notes:", err);
			toast("error", "Re-index failed.");
		} finally {
			setReindexing(false);
			refresh();
		}
	}

	const effectiveStatus = live?.status === "downloading" ? "downloading" : status?.status ?? "not_downloaded";
	const progress = live?.status === "downloading" ? live.progress ?? 0 : status?.progress ?? 0;
	const isBusy = effectiveStatus === "downloading";

	return (
		<div className="p-6 space-y-4">
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				<Card>
					<CardHeader>
						<div className="flex items-center gap-2">
							<Brain className="w-4 h-4 text-muted-foreground" />
							<CardTitle className="text-base">Embedding &amp; Chat</CardTitle>
						</div>
						<CardDescription>
							Local semantic search and the collections chat assistant run on a small model
							downloaded once and kept entirely on this device.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="flex items-center justify-between text-sm">
							<div>
								<div className="font-medium">{MODEL_LABEL}</div>
								<div className="text-xs text-muted-foreground">
									{status ? `${status.sizeMb} MB · ${status.dims} dimensions` : "…"}
								</div>
							</div>
							{!loading && <StatusPill status={effectiveStatus} />}
						</div>

						{isBusy && (
							<div className="space-y-1.5">
								<div className="text-xs text-muted-foreground truncate">
									{live?.message ?? "Downloading model…"}
								</div>
								<div className="w-full bg-muted rounded-full h-1.5">
									<div
										className="bg-indigo-500 h-1.5 rounded-full transition-all"
										style={{ width: `${progress}%` }}
									/>
								</div>
							</div>
						)}

						{effectiveStatus === "error" && live?.message && (
							<div className="text-xs text-destructive">{live.message}</div>
						)}

						{effectiveStatus === "ready" && status && (
							<div className="text-xs text-muted-foreground space-y-0.5">
								<div>{status.indexedCount} / {status.totalCount} notes indexed</div>
								<div>
									Last full re-index: {status.lastIndexedAt ? new Date(status.lastIndexedAt).toLocaleString() : "never"}
								</div>
							</div>
						)}
					</CardContent>
					<CardFooter className="gap-2">
						<Button size="sm" onClick={handleDownload} disabled={isBusy || loading}>
							<Download className="w-3.5 h-3.5" />
							{effectiveStatus === "ready" ? "Re-download" : effectiveStatus === "downloading" ? "Downloading…" : "Download"}
						</Button>
						{effectiveStatus === "ready" && (
							<Button size="sm" variant="outline" onClick={handleReindex} disabled={reindexing}>
								<RefreshCw className={`w-3.5 h-3.5 ${reindexing ? "animate-spin" : ""}`} />
								{reindexing ? "Re-indexing…" : "Re-index notes"}
							</Button>
						)}
					</CardFooter>
				</Card>

				<SearchTuningCard />
				<AttachmentStorageCard />
				<DefaultsCard />
			</div>
		</div>
	);
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.35;
const DEFAULT_TOP_K = 5;

function SearchTuningCard() {
	const [threshold, setThreshold] = useState(DEFAULT_SIMILARITY_THRESHOLD);
	const [topK, setTopK] = useState(DEFAULT_TOP_K);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		Promise.all([
			rpc.getSetting("semanticSimilarityThreshold", "collections"),
			rpc.getSetting("semanticTopK", "collections"),
		])
			.then(([storedThreshold, storedTopK]) => {
				if (typeof storedThreshold === "number") setThreshold(storedThreshold);
				if (typeof storedTopK === "number") setTopK(storedTopK);
			})
			.catch((err) => console.error("Failed to load search tuning settings:", err))
			.finally(() => setLoading(false));
	}, []);

	function handleThresholdChange(value: number) {
		setThreshold(value);
		rpc.saveSetting("semanticSimilarityThreshold", value, "collections").catch((err) => console.error("Failed to save similarity threshold:", err));
	}

	function handleTopKChange(value: number) {
		setTopK(value);
		rpc.saveSetting("semanticTopK", value, "collections").catch((err) => console.error("Failed to save results-per-search:", err));
	}

	function handleReset() {
		handleThresholdChange(DEFAULT_SIMILARITY_THRESHOLD);
		handleTopKChange(DEFAULT_TOP_K);
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<Gauge className="w-4 h-4 text-muted-foreground" />
					<CardTitle className="text-base">Chat Notes Search Tuning</CardTitle>
				</div>
				<CardDescription>
					Controls how the collections chat assistant&apos;s meaning-based (semantic) search decides
					which notes are relevant enough to use when answering a question.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<span className="text-sm">Similarity threshold</span>
						<span className="text-xs font-mono text-muted-foreground">{threshold.toFixed(2)}</span>
					</div>
					<input
						type="range"
						min={0}
						max={1}
						step={0.05}
						value={threshold}
						onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
						disabled={loading}
						className="w-full accent-primary"
					/>
					<p className="text-xs text-muted-foreground">
						How closely a note must match a question&apos;s meaning before semantic search will use it.
						Higher = stricter — fewer, more on-topic results. Lower = looser — more results that may drift off-topic.
					</p>
				</div>
				<div className="space-y-1.5">
					<div className="flex items-center justify-between gap-4">
						<span className="text-sm">Results per search</span>
						<input
							type="number"
							min={1}
							max={10}
							value={topK}
							onChange={(e) => handleTopKChange(Math.min(10, Math.max(1, parseInt(e.target.value, 10) || 1)))}
							disabled={loading}
							className="h-8 w-16 rounded-md border border-input bg-background px-2 text-xs text-right"
						/>
					</div>
					<p className="text-xs text-muted-foreground">
						How many of the closest-matching notes semantic search retrieves for each question.
					</p>
				</div>
			</CardContent>
			<CardFooter>
				<Button size="sm" variant="outline" onClick={handleReset} disabled={loading}>
					Reset to defaults
				</Button>
			</CardFooter>
		</Card>
	);
}

function AttachmentStorageCard() {
	const [info, setInfo] = useState<{ path: string; totalSizeBytes: number; fileCount: number } | null>(null);
	const [loading, setLoading] = useState(true);
	const [opening, setOpening] = useState(false);

	useEffect(() => {
		rpc
			.getAttachmentStorageInfo()
			.then(setInfo)
			.catch((err) => console.error("Failed to load attachment storage info:", err))
			.finally(() => setLoading(false));
	}, []);

	async function handleOpenFolder() {
		setOpening(true);
		try {
			const result = await rpc.openAttachmentStorageFolder();
			if (!result.success) throw new Error("openAttachmentStorageFolder returned success:false");
		} catch (err) {
			console.error("Failed to open attachment storage folder:", err);
			toast("error", "Failed to open folder.");
		} finally {
			setOpening(false);
		}
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<HardDrive className="w-4 h-4 text-muted-foreground" />
					<CardTitle className="text-base">Attachment Storage</CardTitle>
				</div>
				<CardDescription>Note attachments and exported files are kept on this device.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-2">
				<div className="text-xs font-mono text-muted-foreground break-all">{loading ? "…" : (info?.path ?? "—")}</div>
				<div className="text-xs text-muted-foreground">
					{loading ? "…" : `${formatFileSize(info?.totalSizeBytes ?? 0)} · ${info?.fileCount ?? 0} file${info?.fileCount === 1 ? "" : "s"}`}
				</div>
			</CardContent>
			<CardFooter>
				<Button size="sm" variant="outline" onClick={handleOpenFolder} disabled={opening}>
					<FolderOpen className="w-3.5 h-3.5" />
					Open Folder
				</Button>
			</CardFooter>
		</Card>
	);
}

function DefaultsCard() {
	const [exportFormat, setExportFormat] = useState<CollectionExportFormat>("markdown");
	const [sort, setSort] = useState<CollectionNoteSort>("updated");
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		Promise.all([rpc.getSetting("defaultExportFormat", "collections"), rpc.getSetting("defaultSort", "collections")])
			.then(([format, sortValue]) => {
				if (format === "markdown" || format === "pdf" || format === "json") setExportFormat(format);
				if (sortValue && SORT_OPTIONS.some((o) => o.value === sortValue)) setSort(sortValue as CollectionNoteSort);
			})
			.catch((err) => console.error("Failed to load Collections defaults:", err))
			.finally(() => setLoading(false));
	}, []);

	function handleExportFormatChange(value: CollectionExportFormat) {
		setExportFormat(value);
		rpc.saveSetting("defaultExportFormat", value, "collections").catch((err) => console.error("Failed to save default export format:", err));
	}

	function handleSortChange(value: CollectionNoteSort) {
		setSort(value);
		rpc.saveSetting("defaultSort", value, "collections").catch((err) => console.error("Failed to save default sort:", err));
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<SlidersHorizontal className="w-4 h-4 text-muted-foreground" />
					<CardTitle className="text-base">Defaults</CardTitle>
				</div>
				<CardDescription>Applied to every collection unless changed there.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex items-center justify-between gap-4">
					<span className="text-sm">Default export format</span>
					<Select value={exportFormat} onValueChange={(v) => handleExportFormatChange(v as CollectionExportFormat)} disabled={loading}>
						<SelectTrigger className="h-8 w-36 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{EXPORT_FORMAT_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex items-center justify-between gap-4">
					<span className="text-sm">Default sort</span>
					<Select value={sort} onValueChange={(v) => handleSortChange(v as CollectionNoteSort)} disabled={loading}>
						<SelectTrigger className="h-8 w-36 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{SORT_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</CardContent>
		</Card>
	);
}

function StatusPill({ status }: { status: EmbeddingModelStatusDto["status"] }) {
	if (status === "ready") {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400">
				<CheckCircle2 className="w-3.5 h-3.5" />
				Ready
			</span>
		);
	}
	if (status === "downloading") {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
				<Download className="w-3.5 h-3.5 animate-pulse" />
				Downloading
			</span>
		);
	}
	if (status === "error") {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
				<AlertCircle className="w-3.5 h-3.5" />
				Error
			</span>
		);
	}
	return <span className="text-xs font-medium text-muted-foreground">Not downloaded</span>;
}
