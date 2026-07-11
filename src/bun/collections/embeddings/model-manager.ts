// Embedding model download/verify/status lifecycle for Collections (docs/collections-plan.md §7).
// Progress streaming reuses the same fetch-progress → broadcastToWebview pattern as the app
// updater (src/bun/rpc/updater.ts), driven here by @huggingface/transformers' own
// progress_callback instead of a hand-rolled fetch loop (see TASK-534's spike notes for why the
// library's own download path is trustworthy under Bun).
//
// embedder.ts (a later task) is responsible for loading the model for actual inference — this
// module only owns download/verify/status so Settings can gate the chat FAB correctly.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Utils } from "electrobun/bun";
import { pipeline, env, type ProgressInfo } from "@huggingface/transformers";
import { db } from "../../db";
import { collectionNotes } from "../../db/schema";
import { broadcastToWebview } from "../../engine-manager";
import type { EmbeddingModelStatus, EmbeddingModelStatusDto } from "../../../shared/rpc/collections";

export const EMBEDDING_MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2";
export const EMBEDDING_MODEL_DIMS = 384;
const APPROX_DOWNLOAD_SIZE_MB = 90;

export function embeddingModelDir(): string {
	return join(Utils.paths.userData, "collections", "embed-model");
}

function markerPath(): string {
	return join(embeddingModelDir(), ".ready.json");
}

// Points @huggingface/transformers' shared env at our controlled download directory instead of
// its package-relative default (see TASK-534's spike notes) — embedder.ts calls this too, so both
// modules always agree on where the model lives regardless of call order.
export function configureEmbeddingModelEnv(): void {
	const dir = embeddingModelDir();
	env.cacheDir = dir.endsWith(sep) ? dir : dir + sep;
}

export function isEmbeddingModelDownloaded(): boolean {
	return readMarker() !== null;
}

interface ReadyMarker {
	modelId: string;
	dims: number;
	downloadedAt: string;
}

// In-memory only — a fresh process always re-derives "ready" from the marker file on disk
// (see currentStatus()), so this just tracks the current/last download attempt.
let activeDownloadProgress: number | null = null;
let lastError: string | null = null;
let inFlightDownload: Promise<{ success: boolean }> | null = null;

function readMarker(): ReadyMarker | null {
	try {
		if (!existsSync(markerPath())) return null;
		return JSON.parse(readFileSync(markerPath(), "utf-8")) as ReadyMarker;
	} catch {
		return null;
	}
}

function directorySizeBytes(dir: string): number {
	if (!existsSync(dir)) return 0;
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		total += entry.isDirectory() ? directorySizeBytes(full) : statSync(full).size;
	}
	return total;
}

function currentStatus(): EmbeddingModelStatus {
	if (activeDownloadProgress !== null) return "downloading";
	if (readMarker()) return "ready";
	if (lastError) return "error";
	return "not_downloaded";
}

export async function getEmbeddingModelStatus(): Promise<EmbeddingModelStatusDto> {
	const status = currentStatus();
	const sizeMb = status === "ready"
		? Math.round(directorySizeBytes(embeddingModelDir()) / (1024 * 1024))
		: APPROX_DOWNLOAD_SIZE_MB;

	const [totalRow] = await db
		.select({ n: sql<number>`count(*)` })
		.from(collectionNotes)
		.where(eq(collectionNotes.isDeleted, 0));
	const [indexedRow] = await db
		.select({ n: sql<number>`count(*)` })
		.from(collectionNotes)
		.where(and(eq(collectionNotes.isDeleted, 0), isNotNull(collectionNotes.embedding)));

	return {
		status,
		progress: status === "downloading" ? activeDownloadProgress : null,
		dims: EMBEDDING_MODEL_DIMS,
		sizeMb,
		lastIndexedAt: null, // set once the re-index pipeline (a later task) actually runs
		indexedCount: indexedRow?.n ?? 0,
		totalCount: totalRow?.n ?? 0,
	};
}

export async function downloadEmbeddingModel(): Promise<{ success: boolean }> {
	if (inFlightDownload) return inFlightDownload;
	inFlightDownload = runDownload().finally(() => {
		inFlightDownload = null;
	});
	return inFlightDownload;
}

async function runDownload(): Promise<{ success: boolean }> {
	activeDownloadProgress = 0;
	lastError = null;
	broadcastToWebview("collectionEmbeddingModelStatus", {
		status: "downloading",
		progress: 0,
		message: "Starting download…",
	});

	try {
		mkdirSync(embeddingModelDir(), { recursive: true });
		configureEmbeddingModelEnv();
		env.allowRemoteModels = true;

		const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL_ID, {
			progress_callback: (info: ProgressInfo) => {
				if (info.status !== "progress_total") return;
				const progress = Math.round(info.progress);
				activeDownloadProgress = progress;
				broadcastToWebview("collectionEmbeddingModelStatus", {
					status: "downloading",
					progress,
					message: `Downloading model… ${progress}%`,
				});
			},
		});

		// Verify the download actually produces a working embedding before marking ready —
		// mirrors the smoke test that validated this approach under Bun in TASK-534's spike.
		const output = await extractor("AgentDesk embedding model verification", {
			pooling: "mean",
			normalize: true,
		});
		const dims = (output.data as Float32Array).length;
		if (dims !== EMBEDDING_MODEL_DIMS) {
			throw new Error(`Expected a ${EMBEDDING_MODEL_DIMS}-dim embedding, got ${dims}`);
		}
		await extractor.model.dispose();

		const marker: ReadyMarker = {
			modelId: EMBEDDING_MODEL_ID,
			dims: EMBEDDING_MODEL_DIMS,
			downloadedAt: new Date().toISOString(),
		};
		writeFileSync(markerPath(), JSON.stringify(marker, null, 2));

		activeDownloadProgress = null;
		broadcastToWebview("collectionEmbeddingModelStatus", { status: "ready", progress: 100, message: "Ready" });
		return { success: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		activeDownloadProgress = null;
		lastError = message;
		broadcastToWebview("collectionEmbeddingModelStatus", { status: "error", message });
		return { success: false };
	}
}
