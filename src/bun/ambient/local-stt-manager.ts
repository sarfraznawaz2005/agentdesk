// Local/offline STT (speech-to-text) for Ambient Mode — continuous mic
// capture (node-cpal) -> Silero VAD (sherpa-onnx) -> Whisper small.en
// (sherpa-onnx) -> transcript segments. See docs/ambient-voice-barge-in-research.md
// for why this exists: the Web Speech API used by use-voice-input.ts has no
// raw-audio access at all, which makes real barge-in (knowing definitively
// when speech starts/stops) impossible to build on top of it.
//
// Deliberately NOT an npm dependency of this app, for the same reason as
// local-voice-manager.ts's TTS voice: node-cpal's native binary and the ASR
// model weights (hundreds of MB) may not add a byte to AgentDesk's own
// installer. Both are fetched at DOWNLOAD time into Utils.paths.userData and
// loaded from there via an absolute-path require() — never through
// node_modules or Bun's own bundler. This module is statically imported by
// rpc/ambient.ts (part of the app-boot RPC graph), so the native mic
// capture/ASR engines are only ever required lazily from inside functions.
//
// The sherpa-onnx engine itself is shared infrastructure with the TTS voice
// (local-voice-manager.ts) — if that's already downloaded, its copy is reused
// read-only (no coupling to that module's internals, just the same stable
// on-disk layout) instead of fetching a second copy of the same binary.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Utils } from "electrobun/bun";
import { broadcastToWebview } from "../engine-manager";
import type { AmbientLocalSttStatus, AmbientLocalSttStatusDto } from "../../shared/rpc/ambient";
import { logAmbient } from "./debug-log";

// Sentinel providerId used by the Settings > General "Speech input" picker to
// select this offline pipeline instead of the default Web Speech API path.
export const LOCAL_STT_PROVIDER_ID = "local";

// Same pinned-not-latest reasoning as local-voice-manager.ts's SHERPA_VERSION —
// this integration relies on this exact version's on-disk layout.
const SHERPA_VERSION = "1.13.4";
const NODE_CPAL_VERSION = "0.1.1";
const SILERO_VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
const WHISPER_MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2";

// Exact, measured byte sizes of what actually gets DOWNLOADED — not the
// smaller post-prune footprint (pruneNonInt8Whisper deletes ~970MB of unused
// fp32 weights only AFTER the whole archive has already been fetched, so the
// network transfer is the archive's full size regardless). Measured directly
// (npm pack / a real download), not guessed — a rounded single-number guess
// here previously undersold the real download by ~230MB. Engine sizes are
// win-x64's real numbers; other platforms' native binaries are the same
// ballpark but not individually verified, so this is exact for Windows and a
// close approximation elsewhere.
const NODE_CPAL_SIZE_BYTES = 1_548_695;
const SHERPA_ENGINE_SIZE_BYTES = 11_469 + 8_661_664; // sherpa-onnx-node wrapper + platform native binary
const SILERO_VAD_SIZE_BYTES = 643_854;
const WHISPER_ARCHIVE_SIZE_BYTES = 635_693_775;

function estimatedDownloadMb(): number {
	const sharedEntry = join(ttsEngineDir(), "sherpa-onnx.js");
	const needsEngine = !existsSync(sharedEntry);
	const totalBytes = NODE_CPAL_SIZE_BYTES + SILERO_VAD_SIZE_BYTES + WHISPER_ARCHIVE_SIZE_BYTES + (needsEngine ? SHERPA_ENGINE_SIZE_BYTES : 0);
	return Math.round(totalBytes / (1024 * 1024));
}

function rootDir(): string {
	return join(Utils.paths.userData, "ambient", "local-stt");
}
function ttsEngineDir(): string {
	// Mirrors local-voice-manager.ts's engineDir() exactly — read-only reuse,
	// never written to from here.
	return join(Utils.paths.userData, "ambient", "local-voice", "node_modules", "sherpa-onnx-node");
}
function ownEngineDir(): string {
	return join(rootDir(), "node_modules", "sherpa-onnx-node");
}
function ownEnginePlatformDir(platformArch: string): string {
	return join(ownEngineDir(), "node_modules", `sherpa-onnx-${platformArch}`);
}
function cpalDir(): string {
	return join(rootDir(), "node_modules", "node-cpal");
}
function modelDir(): string {
	return join(rootDir(), "model", "sherpa-onnx-whisper-small.en");
}
function vadModelPath(): string {
	return join(rootDir(), "model", "silero_vad.onnx");
}
function markerPath(): string {
	return join(rootDir(), ".ready.json");
}

function platformArch(): string {
	const platform = process.platform === "win32" ? "win" : process.platform;
	return `${platform}-${process.arch}`;
}

interface ReadyMarker {
	version: string;
	downloadedAt: string;
	usingSharedEngine: boolean;
}

let activeProgress: number | null = null;
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

export function isLocalSttReady(): boolean {
	return readMarker() !== null;
}

function currentStatus(): AmbientLocalSttStatus {
	if (activeProgress !== null) return "downloading";
	if (readMarker()) return "ready";
	if (lastError) return "error";
	return "not_downloaded";
}

export function getLocalSttStatus(): AmbientLocalSttStatusDto {
	const status = currentStatus();
	// Once ready, show the real installed footprint (smaller — fp32 files
	// already pruned); before that, show the real total that will be
	// downloaded (bigger — the archive is fetched whole before pruning).
	// These are genuinely different numbers, same as an installer's
	// "download size" vs "installed size" — not a bug if they don't match.
	const sizeMb = status === "ready" ? Math.round(directorySizeBytes(rootDir()) / (1024 * 1024)) : estimatedDownloadMb();
	return { status, progress: status === "downloading" ? activeProgress : null, sizeMb };
}

function broadcast(status: AmbientLocalSttStatus, progress?: number, message?: string) {
	broadcastToWebview("ambientLocalSttStatus", { status, progress, message });
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

// Shells out to the system `tar` — see local-voice-manager.ts's extractTar for
// why (bzip2 archives, no extra npm dependency needed).
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

// The whisper archive bundles the full fp32 weights alongside the int8 ones —
// only the int8 files + tokens are ever loaded (see loadEngine below), so the
// fp32 copies are deleted right after extraction rather than left on disk
// (~970MB wasted otherwise for a model whose useful footprint is ~375MB).
function pruneNonInt8Whisper(): void {
	for (const name of ["small.en-encoder.onnx", "small.en-decoder.onnx"]) {
		const p = join(modelDir(), name);
		if (existsSync(p)) rmSync(p);
	}
}

let engineRequirePath: string | null = null;

async function ensureEngine(onProgress: (base: number, span: number, pct: number, message: string) => void, base: number, span: number): Promise<string> {
	// Reuse the TTS voice's already-downloaded engine if present — same
	// version, same on-disk layout, no coupling beyond that path constant.
	const sharedEntry = join(ttsEngineDir(), "sherpa-onnx.js");
	if (existsSync(sharedEntry)) {
		logAmbient("local-stt: reusing TTS voice's sherpa-onnx-node engine");
		onProgress(base, span, 100, "Reusing existing speech engine…");
		return join(ttsEngineDir(), "package.json");
	}

	const arch = platformArch();
	const tmpDir = join(rootDir(), ".tmp");
	mkdirSync(tmpDir, { recursive: true });

	onProgress(base, span, 0, "Downloading speech engine…");
	const engineTgz = join(tmpDir, "sherpa-onnx-node.tgz");
	await downloadWithProgress(
		`https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-${SHERPA_VERSION}.tgz`,
		engineTgz,
		(pct) => onProgress(base, span * 0.4, pct, "Downloading speech engine…"),
	);
	await extractTar(engineTgz, ownEngineDir(), { stripComponents: 1 });

	onProgress(base + span * 0.4, span * 0.6, 0, "Downloading speech engine binary…");
	const platformTgz = join(tmpDir, "sherpa-onnx-platform.tgz");
	await downloadWithProgress(
		`https://registry.npmjs.org/sherpa-onnx-${arch}/-/sherpa-onnx-${arch}-${SHERPA_VERSION}.tgz`,
		platformTgz,
		(pct) => onProgress(base + span * 0.4, span * 0.6, pct, "Downloading speech engine binary…"),
	);
	await extractTar(platformTgz, ownEnginePlatformDir(arch), { stripComponents: 1 });

	return join(ownEngineDir(), "package.json");
}

async function ensureCpal(onProgress: (pct: number) => void): Promise<void> {
	if (existsSync(join(cpalDir(), "index.js"))) {
		onProgress(100);
		return;
	}
	const tmpDir = join(rootDir(), ".tmp");
	mkdirSync(tmpDir, { recursive: true });
	const cpalTgz = join(tmpDir, "node-cpal.tgz");
	await downloadWithProgress(`https://registry.npmjs.org/node-cpal/-/node-cpal-${NODE_CPAL_VERSION}.tgz`, cpalTgz, onProgress);
	await extractTar(cpalTgz, cpalDir(), { stripComponents: 1 });
}

async function runDownload(): Promise<{ success: boolean }> {
	activeProgress = 0;
	lastError = null;
	broadcast("downloading", 0, "Starting download…");

	const tmpDir = join(rootDir(), ".tmp");
	try {
		rmSync(tmpDir, { recursive: true, force: true });
		mkdirSync(rootDir(), { recursive: true });

		const engineRequire = await ensureEngine((base, span, pct, message) => setStageProgress(base, span, pct, message), 0, 20);
		engineRequirePath = engineRequire;

		await ensureCpal((pct) => setStageProgress(20, 10, pct, "Downloading mic capture library…"));

		setStageProgress(30, 5, 0, "Downloading voice activity detector…");
		mkdirSync(join(rootDir(), "model"), { recursive: true });
		await downloadWithProgress(SILERO_VAD_URL, vadModelPath(), (pct) => setStageProgress(30, 5, pct, "Downloading voice activity detector…"));

		setStageProgress(35, 55, 0, "Downloading speech recognition model…");
		const modelArchive = join(tmpDir, "whisper-small-en.tar.bz2");
		await downloadWithProgress(WHISPER_MODEL_URL, modelArchive, (pct) => setStageProgress(35, 55, pct, "Downloading speech recognition model…"));
		await extractTar(modelArchive, join(rootDir(), "model"));
		pruneNonInt8Whisper();

		activeProgress = 95;
		broadcast("downloading", 95, "Verifying…");
		const engine = loadEngine();
		const vad = new engine.Vad({ sileroVad: { model: vadModelPath(), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, windowSize: 512 }, sampleRate: 16000, numThreads: 1, debug: false }, 5);
		vad.acceptWaveform(new Float32Array(512));
		const recognizer = loadRecognizer(engine);
		const stream = recognizer.createStream();
		stream.acceptWaveform({ samples: new Float32Array(1600), sampleRate: 16000 });
		recognizer.decode(stream);
		recognizer.getResult(stream);

		const marker: ReadyMarker = { version: SHERPA_VERSION, downloadedAt: new Date().toISOString(), usingSharedEngine: engineRequirePath === join(ttsEngineDir(), "package.json") };
		writeFileSync(markerPath(), JSON.stringify(marker, null, 2));

		rmSync(tmpDir, { recursive: true, force: true });
		activeProgress = null;
		broadcast("ready", 100, "Ready");
		return { success: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logAmbient(`local-stt download failed: ${message}`);
		activeProgress = null;
		lastError = message;
		broadcast("error", undefined, message);
		return { success: false };
	}
}

export async function downloadLocalStt(): Promise<{ success: boolean }> {
	if (inFlightDownload) return inFlightDownload;
	inFlightDownload = runDownload().finally(() => {
		inFlightDownload = null;
	});
	return inFlightDownload;
}

// Frees the (typically) ~650MB+ download. Stops any active capture session
// and drops every cached handle first, since they hold onnxruntime/native
// references into the files about to be removed.
export async function deleteLocalStt(): Promise<{ success: boolean; error?: string }> {
	if (inFlightDownload) return { success: false, error: "A download is already in progress." };
	try {
		stopLocalListening();
		if (decodeWorkerHandle) {
			decodeWorkerHandle.worker.terminate();
			decodeWorkerHandle = null;
		}
		cachedEngine = null;
		cachedRecognizer = null;
		cachedCpal = null;
		engineRequirePath = null;
		rmSync(rootDir(), { recursive: true, force: true });
		lastError = null;
		activeProgress = null;
		broadcast("not_downloaded");
		return { success: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logAmbient(`deleteLocalStt failed: ${message}`);
		return { success: false, error: message };
	}
}

// ---------------------------------------------------------------------------
// Engine loading + the continuous capture/VAD/ASR loop
// ---------------------------------------------------------------------------

interface SpeechSegment {
	samples: Float32Array;
	start: number;
}
interface VadHandle {
	acceptWaveform(samples: Float32Array): void;
	isEmpty(): boolean;
	/** True while VAD currently considers itself inside an active speech segment (before minSilenceDuration closes it) — the real "user is talking right now" signal, well before that segment is complete/queued. */
	isDetected(): boolean;
	front(): SpeechSegment;
	pop(): void;
	flush(): void;
}
interface OfflineStreamHandle {
	acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
}
interface RecognizerHandle {
	createStream(): OfflineStreamHandle;
	decode(stream: OfflineStreamHandle): void;
	getResult(stream: OfflineStreamHandle): { text: string };
}
interface ResamplerHandle {
	resample(samples: Float32Array): Float32Array;
}
interface SherpaEngine {
	Vad: new (config: unknown, bufferSizeInSeconds: number) => VadHandle;
	OfflineRecognizer: new (config: unknown) => RecognizerHandle;
	LinearResampler: new (inputRate: number, outputRate: number) => ResamplerHandle;
}
interface CpalModule {
	getDefaultInputDevice(): { deviceId: string; name: string };
	getDefaultInputConfig(deviceId: string): { sampleRate: number; channels: number; sampleFormat: string };
	createStream(deviceId: string, isInput: boolean, config: unknown, onData: (data: Float32Array) => void): { deviceId: string; streamId: string };
	closeStream(handle: { deviceId: string; streamId: string }): void;
}

function resolveEngineRequirePath(): string {
	if (!engineRequirePath) {
		const shared = join(ttsEngineDir(), "package.json");
		engineRequirePath = existsSync(shared) ? shared : join(ownEngineDir(), "package.json");
	}
	return engineRequirePath;
}

let cachedEngine: SherpaEngine | null = null;
function loadEngine(): SherpaEngine {
	if (cachedEngine) return cachedEngine;
	const requirePath = resolveEngineRequirePath();
	const t0 = performance.now();
	const require2 = createRequire(requirePath);
	cachedEngine = require2("sherpa-onnx-node") as SherpaEngine;
	logAmbient(`local-stt: engine loaded in ${Math.round(performance.now() - t0)}ms (${requirePath.includes("local-voice") ? "shared with TTS" : "own copy"})`);
	return cachedEngine;
}

let cachedCpal: CpalModule | null = null;
function loadCpal(): CpalModule {
	if (cachedCpal) return cachedCpal;
	const require2 = createRequire(join(cpalDir(), "package.json"));
	cachedCpal = require2("node-cpal") as CpalModule;
	return cachedCpal;
}

let cachedRecognizer: RecognizerHandle | null = null;
function loadRecognizer(engine: SherpaEngine): RecognizerHandle {
	if (cachedRecognizer) return cachedRecognizer;
	const t0 = performance.now();
	cachedRecognizer = new engine.OfflineRecognizer({
		modelConfig: {
			whisper: {
				encoder: join(modelDir(), "small.en-encoder.int8.onnx"),
				decoder: join(modelDir(), "small.en-decoder.int8.onnx"),
				language: "en",
			},
			tokens: join(modelDir(), "small.en-tokens.txt"),
			numThreads: 2,
			provider: "cpu",
		},
	});
	logAmbient(`local-stt: recognizer loaded in ${Math.round(performance.now() - t0)}ms`);
	return cachedRecognizer;
}

// ---------------------------------------------------------------------------
// Decode worker — runs Whisper inference off the main thread
// ---------------------------------------------------------------------------
// Whisper decode measured at 1.3-10s per segment in real use, and
// startLocalListening's onData callback (VAD + decode) runs on the same JS
// thread as everything else (RPC handling, other capture callbacks, timers).
// Decoding inline there blocked the whole backend for the duration of every
// segment — including the VAD processing for audio arriving DURING that
// decode, so a user's own continuation of an utterance wasn't even detected
// until the prior segment finished transcribing. Moving just the decode step
// (not VAD, which is cheap) into a persistent worker thread keeps the main
// loop free to keep accepting waveform/detecting new segments in real time
// regardless of how long a decode takes. Mirrors db/maintenance.ts's
// runVacuumInWorker pattern: worker source is written to disk at runtime
// (works identically in dev and the flattened production bundle, since
// Bun/Electrobun's bundler has no static-import visibility into a script
// path assembled at runtime) rather than imported as a module — unlike that
// one-shot vacuum worker, this one is long-lived and reused across
// start/stop cycles the same way cachedEngine/cachedRecognizer are.
interface DecodeWorkerHandle {
	worker: Worker;
	pending: Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>;
	nextId: number;
}

function buildDecodeWorkerSrc(enginePackageJsonPath: string, encoderPath: string, decoderPath: string, tokensPath: string): string {
	return [
		'import { createRequire } from "node:module";',
		`const require2 = createRequire(${JSON.stringify(enginePackageJsonPath)});`,
		'const engine = require2("sherpa-onnx-node");',
		"const recognizer = new engine.OfflineRecognizer({",
		"  modelConfig: {",
		`    whisper: { encoder: ${JSON.stringify(encoderPath)}, decoder: ${JSON.stringify(decoderPath)}, language: "en" },`,
		`    tokens: ${JSON.stringify(tokensPath)},`,
		"    numThreads: 2,",
		'    provider: "cpu",',
		"  },",
		"});",
		"self.onmessage = (ev) => {",
		"  const { id, samples, sampleRate } = ev.data;",
		"  try {",
		"    const stream = recognizer.createStream();",
		"    stream.acceptWaveform({ samples, sampleRate });",
		"    recognizer.decode(stream);",
		"    const result = recognizer.getResult(stream);",
		"    postMessage({ id, ok: true, text: result.text });",
		"  } catch (err) {",
		"    postMessage({ id, ok: false, error: String((err && err.message) || err) });",
		"  }",
		"};",
	].join("\n");
}

let decodeWorkerHandle: DecodeWorkerHandle | null = null;

function getDecodeWorker(): DecodeWorkerHandle {
	if (decodeWorkerHandle) return decodeWorkerHandle;
	const requirePath = resolveEngineRequirePath();
	const workerFile = join(rootDir(), "decode-worker.mjs");
	writeFileSync(
		workerFile,
		buildDecodeWorkerSrc(requirePath, join(modelDir(), "small.en-encoder.int8.onnx"), join(modelDir(), "small.en-decoder.int8.onnx"), join(modelDir(), "small.en-tokens.txt")),
	);
	const worker = new Worker(pathToFileURL(workerFile).href, { type: "module" });
	const handle: DecodeWorkerHandle = { worker, pending: new Map(), nextId: 0 };
	worker.onmessage = (ev) => {
		const data = ev.data as { id: number; ok: boolean; text?: string; error?: string };
		const entry = handle.pending.get(data.id);
		if (!entry) return;
		handle.pending.delete(data.id);
		if (data.ok) entry.resolve(data.text ?? "");
		else entry.reject(new Error(data.error || "decode failed"));
	};
	worker.onerror = (err) => {
		logAmbient(`local-stt: decode worker error: ${err instanceof Error ? err.message : String(err)}`);
	};
	decodeWorkerHandle = handle;
	return handle;
}

function decodeInWorker(samples: Float32Array, sampleRate: number): Promise<string> {
	const handle = getDecodeWorker();
	const id = handle.nextId++;
	return new Promise((resolve, reject) => {
		handle.pending.set(id, { resolve, reject });
		handle.worker.postMessage({ id, samples, sampleRate });
	});
}

const WINDOW = 512;
const VAD_SAMPLE_RATE = 16000;

interface CaptureSession {
	cpal: CpalModule;
	streamHandle: { deviceId: string; streamId: string };
}

let activeSession: CaptureSession | null = null;

function downmix(interleaved: Float32Array, channels: number): Float32Array {
	if (channels === 1) return interleaved;
	const frames = interleaved.length / channels;
	const mono = new Float32Array(frames);
	for (let i = 0; i < frames; i++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) sum += interleaved[i * channels + c];
		mono[i] = sum / channels;
	}
	return mono;
}

interface LocalSttCallbacks {
	/**
	 * Fired the instant `vad.isDetected()` flips true — i.e. within
	 * minSpeechDuration (0.25s) of the user actually starting to talk again —
	 * NOT when a segment finishes and is popped from the queue, which would
	 * only happen once the user's entire continuation is already spoken.
	 * The frontend relies on this firing early so its flush-backstop timer
	 * can hold off for however long the corresponding decode ends up taking.
	 */
	onSegmentStart: () => void;
	/**
	 * Fired once a segment finishes decoding. `silenceBeforeMs` is the true
	 * audio-domain gap since the previous segment ended (null for the first
	 * segment of the session) — computed from VAD sample counts, so it's
	 * accurate regardless of how long decode itself took.
	 */
	onSegment: (text: string, silenceBeforeMs: number | null) => void;
}

/**
 * Starts continuous native mic capture, gated through Silero VAD so each
 * callback fires with one complete, VAD-bounded utterance (not an interim
 * transcript the way the Web Speech API path works) — decoded with Whisper
 * small.en in a background worker (see decode-worker comment above) so a
 * slow decode never blocks capture/VAD from processing the next segment in
 * real time. A no-op if a session is already running (idempotent, mirrors
 * useAmbientVoiceTurn's own start/stop contract on the frontend).
 */
export function startLocalListening(callbacks: LocalSttCallbacks): { success: boolean; error?: string } {
	if (activeSession) return { success: true };
	if (!isLocalSttReady()) return { success: false, error: "Local speech input hasn't been downloaded yet." };

	try {
		const engine = loadEngine();
		const cpal = loadCpal();
		// Pre-warm the decode worker (its own recognizer load takes several
		// seconds — see the log's "recognizer loaded in 6731ms") in parallel
		// with capture startup below, instead of blocking it the way the old
		// synchronous main-thread loadRecognizer() call used to.
		getDecodeWorker();

		const device = cpal.getDefaultInputDevice();
		const nativeConfig = cpal.getDefaultInputConfig(device.deviceId);
		logAmbient(`local-stt: capture starting on "${device.name}" @ ${nativeConfig.sampleRate}Hz ${nativeConfig.channels}ch`);

		const resampler = new engine.LinearResampler(nativeConfig.sampleRate, VAD_SAMPLE_RATE);
		const vad = new engine.Vad(
			{
				sileroVad: { model: vadModelPath(), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, windowSize: WINDOW },
				sampleRate: VAD_SAMPLE_RATE,
				numThreads: 1,
				debug: false,
			},
			60,
		);

		let pending = new Float32Array(0);
		// Sample index (in the VAD's 16kHz clock) where the previous segment
		// ended — lets each new segment's silenceBeforeMs be computed from
		// real audio timing, not from decode-latency-affected arrival times.
		let previousSegmentEndSample: number | null = null;
		// Edge-triggers onSegmentStart off vad.isDetected() transitioning to
		// true — NOT off popping a completed segment from the queue, which
		// only happens once the user's ENTIRE continuation has already been
		// spoken (defeating the point: the frontend needs to know a
		// continuation is under way as soon as the user starts talking again,
		// not once they've finished). isDetected() flips true within
		// minSpeechDuration (0.25s) of real speech resuming, which is what
		// actually lets the flush-backstop hold off in time.
		let wasSpeechDetected = false;

		const streamHandle = cpal.createStream(device.deviceId, true, nativeConfig, (data: Float32Array) => {
			const mono = downmix(new Float32Array(data), nativeConfig.channels);
			const resampled = resampler.resample(mono);

			const merged = new Float32Array(pending.length + resampled.length);
			merged.set(pending, 0);
			merged.set(resampled, pending.length);

			let offset = 0;
			while (offset + WINDOW <= merged.length) {
				vad.acceptWaveform(merged.subarray(offset, offset + WINDOW));
				offset += WINDOW;
				const isSpeechDetected = vad.isDetected();
				if (isSpeechDetected && !wasSpeechDetected) callbacks.onSegmentStart();
				wasSpeechDetected = isSpeechDetected;
			}
			pending = merged.subarray(offset);

			while (!vad.isEmpty()) {
				const segment = vad.front();
				vad.pop();

				const silenceBeforeMs =
					previousSegmentEndSample !== null ? Math.round(((segment.start - previousSegmentEndSample) / VAD_SAMPLE_RATE) * 1000) : null;
				previousSegmentEndSample = segment.start + segment.samples.length;

				const t0 = performance.now();
				void decodeInWorker(segment.samples, VAD_SAMPLE_RATE)
					.then((text) => {
						logAmbient(
							`local-stt: segment (${(segment.samples.length / VAD_SAMPLE_RATE).toFixed(2)}s) decoded in ${Math.round(performance.now() - t0)}ms -> "${text}" (silenceBeforeMs=${silenceBeforeMs})`,
						);
						const trimmed = text.trim();
						if (trimmed) callbacks.onSegment(trimmed, silenceBeforeMs);
					})
					.catch((err) => {
						logAmbient(`local-stt: decode failed: ${err instanceof Error ? err.message : String(err)}`);
					});
			}
		});

		activeSession = { cpal, streamHandle };
		return { success: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logAmbient(`local-stt: failed to start capture: ${message}`);
		return { success: false, error: message };
	}
}

export function stopLocalListening(): { success: boolean } {
	if (!activeSession) return { success: true };
	try {
		activeSession.cpal.closeStream(activeSession.streamHandle);
	} catch (err) {
		logAmbient(`local-stt: error closing capture stream: ${err instanceof Error ? err.message : String(err)}`);
	}
	activeSession = null;
	return { success: true };
}

export function isLocalListeningActive(): boolean {
	return activeSession !== null;
}
