// Local/offline TTS voice ("Ryan", Piper/VITS via sherpa-onnx) for Ambient Mode —
// download/verify/status lifecycle, mirroring collections/embeddings/model-manager.ts's
// pattern (marker-file-based readiness, no DB row, broadcastToWebview progress).
//
// Deliberately NOT an npm dependency of this app — the whole point (per explicit
// product decision) is that neither the ~23MB native inference binary nor the ~115MB
// voice model may add one byte to AgentDesk's own installer/bundle size. Both are
// fetched directly from their public npm/GitHub sources at DOWNLOAD time, into
// Utils.paths.userData, and loaded from there via an absolute-path require() —
// never through node_modules or Bun's own bundler. This module is statically
// imported by rpc/ambient.ts (part of the app-boot RPC graph), so anything that
// touches the downloaded engine is called lazily from inside functions, never at
// module top level.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Utils } from "electrobun/bun";
import { broadcastToWebview } from "../engine-manager";
import type { AmbientLocalVoiceStatus, AmbientLocalVoiceStatusDto } from "../../shared/rpc/ambient";
import { logAmbient } from "./debug-log";

// Sentinel providerId used by the Settings > General "Voice" picker to select
// this offline voice instead of a real aiProviders row — generateAmbientSpeech
// (rpc/ambient.ts) branches on this before treating providerId as a DB lookup.
export const LOCAL_VOICE_PROVIDER_ID = "local";

// Pinned (not "latest") — this integration relies on this exact version's on-disk
// layout (sherpa-onnx-node's addon.js resolving a sibling `node_modules/sherpa-onnx-
// <platform>-<arch>/sherpa-onnx.node`); an upstream layout change should be a
// deliberate version bump here, not a silent break.
const SHERPA_VERSION = "1.13.4";
const MODEL_ARCHIVE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-ryan-high.tar.bz2";
const APPROX_SIZE_MB = 140; // ~10MB engine + ~116MB model, rounded

function rootDir(): string {
	return join(Utils.paths.userData, "ambient", "local-voice");
}
function engineDir(): string {
	return join(rootDir(), "node_modules", "sherpa-onnx-node");
}
function enginePlatformDir(platformArch: string): string {
	return join(engineDir(), "node_modules", `sherpa-onnx-${platformArch}`);
}
function modelDir(): string {
	return join(rootDir(), "model", "vits-piper-en_US-ryan-high");
}
function markerPath(): string {
	return join(rootDir(), ".ready.json");
}
function entryFile(): string {
	return join(engineDir(), "sherpa-onnx.js");
}

// Mirrors sherpa-onnx-node's OWN addon.js naming exactly (os.platform()==='win32' ?
// 'win' : os.platform(), plus os.arch()) — computed from the CURRENT user's actual
// platform at download time, so this works for every OS the published npm packages
// cover (win-x64/ia32, darwin-x64/arm64, linux-x64/arm64) without any per-platform
// build step of our own.
function platformArch(): string {
	const platform = process.platform === "win32" ? "win" : process.platform;
	return `${platform}-${process.arch}`;
}

interface ReadyMarker {
	version: string;
	downloadedAt: string;
}

// In-memory only — a fresh process always re-derives "ready" from the marker file
// on disk (see currentStatus()), same as the embedding model.
let activeProgress: number | null = null;
let lastError: string | null = null;
let inFlightDownload: Promise<{ success: boolean }> | null = null;
let cachedTts: { generate: (opts: unknown) => { samples: Float32Array; sampleRate: number } } | null = null;

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

export function isLocalVoiceReady(): boolean {
	return readMarker() !== null;
}

function currentStatus(): AmbientLocalVoiceStatus {
	if (activeProgress !== null) return "downloading";
	if (readMarker()) return "ready";
	if (lastError) return "error";
	return "not_downloaded";
}

export function getLocalVoiceStatus(): AmbientLocalVoiceStatusDto {
	const status = currentStatus();
	const sizeMb = status === "ready" ? Math.round(directorySizeBytes(rootDir()) / (1024 * 1024)) : APPROX_SIZE_MB;
	return { status, progress: status === "downloading" ? activeProgress : null, sizeMb };
}

function broadcast(status: "downloading" | "ready" | "error", progress?: number, message?: string) {
	broadcastToWebview("ambientLocalVoiceStatus", { status, progress, message });
}

async function downloadWithProgress(url: string, destFile: string, onProgress: (pct: number) => void): Promise<void> {
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} (${url})`);
	const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let downloaded = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		downloaded += value.length;
		if (contentLength > 0) onProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
	}
	const buffer = new Uint8Array(downloaded);
	let pos = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, pos);
		pos += chunk.length;
	}
	await Bun.write(destFile, buffer);
}

// Shells out to the system `tar` (present on Windows 10+, macOS, and Linux by
// default) rather than adding a bzip2-capable npm dependency — GitHub's model
// archive is .tar.bz2, which Node's zlib (and the `tar` npm package already used
// elsewhere in this app) can't decode; plain system tar auto-detects the
// compression from the file itself, so one code path covers both the .tar.bz2
// model archive and the .tgz npm packages below.
async function extractTar(archivePath: string, destDir: string, opts: { stripComponents?: number } = {}): Promise<void> {
	mkdirSync(destDir, { recursive: true });
	const args = ["tar", "-xf", archivePath, "-C", destDir];
	if (opts.stripComponents) args.push(`--strip-components=${opts.stripComponents}`);
	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`Extraction failed for ${archivePath}: ${stderr.trim() || `tar exited with code ${exitCode}`}`);
	}
}

function setStageProgress(base: number, span: number, pct: number, message: string) {
	activeProgress = Math.min(100, base + Math.round((pct / 100) * span));
	broadcast("downloading", activeProgress, message);
}

// Standard 16-bit PCM WAV encoding — sherpa-onnx's own writeWave() only writes to
// a file path, but the ambient TTS playback path (use-ambient-voice-playback.ts)
// wants an in-memory {base64, mimeType} pair, same shape generateAmbientSpeech
// already returns for the OpenAI provider path.
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
	const bytesPerSample = 2;
	const dataSize = samples.length * bytesPerSample;
	const buffer = Buffer.alloc(44 + dataSize);
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8);
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // mono
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
	buffer.writeUInt16LE(bytesPerSample, 32); // block align
	buffer.writeUInt16LE(16, 34); // bits per sample
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataSize, 40);
	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		buffer.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), offset);
		offset += bytesPerSample;
	}
	return buffer;
}

async function loadEngine() {
	if (cachedTts) {
		logAmbient("loadEngine — already cached, no-op");
		return cachedTts;
	}
	const t0 = performance.now();
	const require = createRequire(import.meta.url);
	const sherpaOnnx = require(entryFile()) as {
		OfflineTts: new (config: unknown) => { generate: (opts: unknown) => { samples: Float32Array; sampleRate: number } };
	};
	const tts = new sherpaOnnx.OfflineTts({
		model: {
			vits: {
				model: join(modelDir(), "en_US-ryan-high.onnx"),
				tokens: join(modelDir(), "tokens.txt"),
				dataDir: join(modelDir(), "espeak-ng-data"),
			},
			numThreads: 2,
			provider: "cpu",
		},
		maxNumSentences: 1,
	});
	logAmbient(`loadEngine — cold load took ${Math.round(performance.now() - t0)}ms`);
	cachedTts = tts;
	return tts;
}

// Best-effort warmup — called when Ambient Mode opens (if the local voice is
// selected) so the onnxruntime session is already loaded by the time a reply
// actually needs to be spoken, instead of paying that cold-load cost on the
// first utterance of the session. Silently a no-op if the voice isn't
// downloaded yet or is already loaded; synthesizeLocalVoice still surfaces
// the real error to the user if loading genuinely fails.
export async function preloadLocalVoice(): Promise<{ success: boolean }> {
	if (!isLocalVoiceReady()) {
		logAmbient("preloadLocalVoice — not downloaded yet, skipping");
		return { success: true };
	}
	if (cachedTts) {
		logAmbient("preloadLocalVoice — already warm, skipping");
		return { success: true };
	}
	try {
		await loadEngine();
		return { success: true };
	} catch (err) {
		logAmbient(`preloadLocalVoice failed: ${err instanceof Error ? err.message : String(err)}`);
		return { success: false };
	}
}

export async function synthesizeLocalVoice(text: string): Promise<{ base64: string; mimeType: string }> {
	if (!isLocalVoiceReady()) throw new Error("The offline voice hasn't been downloaded yet — download it in Settings first.");
	const t0 = performance.now();
	const tts = await loadEngine();
	const tLoaded = performance.now();
	const audio = tts.generate({ text, generationConfig: { sid: 0, speed: 1.0 } });
	logAmbient(`synthesizeLocalVoice — engine ready in ${Math.round(tLoaded - t0)}ms, generate() in ${Math.round(performance.now() - tLoaded)}ms — "${text}"`);
	const wav = encodeWav(audio.samples, audio.sampleRate);
	return { base64: wav.toString("base64"), mimeType: "audio/wav" };
}

export async function downloadLocalVoice(): Promise<{ success: boolean }> {
	if (inFlightDownload) return inFlightDownload;
	inFlightDownload = runDownload().finally(() => {
		inFlightDownload = null;
	});
	return inFlightDownload;
}

async function runDownload(): Promise<{ success: boolean }> {
	activeProgress = 0;
	lastError = null;
	cachedTts = null; // force a fresh load once the new files are in place
	broadcast("downloading", 0, "Starting download…");

	const tmpDir = join(rootDir(), ".tmp");
	try {
		// Clean slate — a re-download shouldn't leave stale files from a previous
		// (possibly corrupt/incompatible) attempt mixed in with the new ones.
		rmSync(rootDir(), { recursive: true, force: true });
		mkdirSync(tmpDir, { recursive: true });

		const arch = platformArch();

		setStageProgress(0, 3, 0, "Downloading speech engine…");
		const engineTgz = join(tmpDir, "sherpa-onnx-node.tgz");
		await downloadWithProgress(
			`https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-${SHERPA_VERSION}.tgz`,
			engineTgz,
			(pct) => setStageProgress(0, 3, pct, "Downloading speech engine…"),
		);
		await extractTar(engineTgz, engineDir(), { stripComponents: 1 });

		setStageProgress(3, 10, 0, "Downloading speech engine binary…");
		const platformTgz = join(tmpDir, "sherpa-onnx-platform.tgz");
		await downloadWithProgress(
			`https://registry.npmjs.org/sherpa-onnx-${arch}/-/sherpa-onnx-${arch}-${SHERPA_VERSION}.tgz`,
			platformTgz,
			(pct) => setStageProgress(3, 10, pct, "Downloading speech engine binary…"),
		);
		await extractTar(platformTgz, enginePlatformDir(arch), { stripComponents: 1 });

		setStageProgress(13, 82, 0, "Downloading voice model…");
		const modelArchive = join(tmpDir, "voice-model.tar.bz2");
		await downloadWithProgress(MODEL_ARCHIVE_URL, modelArchive, (pct) => setStageProgress(13, 82, pct, "Downloading voice model…"));
		// The archive's own top-level folder is "vits-piper-en_US-ryan-high" — extract
		// one level up so modelDir() (which already includes that name) lines up.
		await extractTar(modelArchive, join(rootDir(), "model"));

		activeProgress = 95;
		broadcast("downloading", 95, "Verifying…");
		const tts = await loadEngine();
		const audio = tts.generate({ text: "AgentDesk voice check.", generationConfig: { sid: 0, speed: 1.0 } });
		if (!audio.samples || audio.samples.length === 0) throw new Error("Verification synthesis produced no audio.");

		const marker: ReadyMarker = { version: SHERPA_VERSION, downloadedAt: new Date().toISOString() };
		writeFileSync(markerPath(), JSON.stringify(marker, null, 2));

		rmSync(tmpDir, { recursive: true, force: true });
		activeProgress = null;
		broadcast("ready", 100, "Ready");
		return { success: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		activeProgress = null;
		lastError = message;
		cachedTts = null;
		broadcast("error", undefined, message);
		return { success: false };
	}
}
