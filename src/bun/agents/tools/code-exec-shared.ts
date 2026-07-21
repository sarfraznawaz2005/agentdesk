// ---------------------------------------------------------------------------
// Shared Python/JavaScript execution helpers — used by both
// general-chat-code-exec.ts (General Chat Assistant's own ephemeral,
// always-ungated scratch-folder tool) and code-exec.ts (the real-workspace,
// approval-gated version for project/Quick Chat sub-agents and Playground).
// Kept here so interpreter resolution, the dangerous-pattern blocklist, and
// the base64-image-capture logic aren't duplicated between the two.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import path from "node:path";

// Best-effort backstop against blatant, catastrophic footguns — not
// adversarial-proof (trivially bypassable via string-building, base64,
// etc.), same honest limitation as shell.ts's own BLOCKED_PATTERNS.
const BLOCKED_PATTERNS = [
	"rm -rf /", "rm -rf ~", "rm -rf .",
	"format c:", "format d:",
	"drop database", "drop table", "truncate table",
	"shutil.rmtree(\"/\")", "shutil.rmtree('/')",
	"mkfs.", "dd if=", "> /dev/sda",
	"shutdown", "reboot",
];

export function isBlockedCode(code: string): boolean {
	const lower = code.toLowerCase();
	return BLOCKED_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

export function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore", windowsHide: true });
		} else {
			try { process.kill(-pid, "SIGTERM"); } catch { /* ignore */ }
			setTimeout(() => {
				try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
			}, 200);
		}
	} catch { /* already dead */ }
}

// Every install has its own set of interpreters on PATH (this app runs on
// many users' machines, not just the one it was built on) — resolved once
// per app session (interpreters don't change mid-session) and cached, never
// re-probed per call. Some machines have "python3" but not "python", or vice
// versa; check both.
let _pythonBin: string | null | undefined;
export function resolvePython(): string | null {
	if (_pythonBin === undefined) _pythonBin = Bun.which("python3") ?? Bun.which("python") ?? null;
	return _pythonBin;
}

// The app's own bundled Bun runtime — NOT `Bun.which("bun")` (which only
// finds a separately-installed, PATH-registered bun binary; most end users
// running the packaged app never installed Bun themselves, so that lookup
// would fail for nearly everyone). process.execPath is the exact binary
// already running this backend process, proven elsewhere in this codebase
// (lsp/installer.ts's `Bun.spawn([process.execPath, "add"/"remove", ...])`)
// to work as a genuine bun CLI invocation regardless of packaging — so it's
// always available, no detection/fallback needed.
export function resolveJsInterpreter(): string {
	return process.execPath;
}

/** Interpreter availability line, shared by both tools' descriptions. */
export function describeInterpreterAvailability(): string {
	const python = resolvePython();
	const pythonLine = python
		? `Python: available (found "${path.basename(python)}" on PATH).`
		: `Python: NOT installed on this machine (or not on PATH) — language: "python" will fail immediately. Don't call it; if the user needs Python specifically, tell them it isn't available here.`;
	return `Interpreter availability on THIS machine (checked once per session, do not re-probe yourself): JavaScript: always available (runs via the app's own bundled runtime). ${pythonLine}`;
}

// Matches a bare `data:image/<mime>;base64,<data>` line the script printed —
// deliberately NOT a markdown image link. Only the first match is captured
// (mirrors generate_image's single-image-per-call assumption); the rest of
// stdout is left untouched around it.
export const DATA_IMAGE_URI = /data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/i;

/**
 * Extracts the first embedded data-URI image from raw stdout (call this
 * BEFORE any truncation — truncating first would corrupt a large base64
 * blob mid-string). Returns the cleaned stdout (image replaced with a short
 * placeholder note) and the extracted payload, if any.
 */
export function extractAndStripImage(stdout: string): {
	cleanedStdout: string;
	imagePayload: { mimeType: string; base64: string } | null;
} {
	const imageMatch = stdout.match(DATA_IMAGE_URI);
	if (!imageMatch) return { cleanedStdout: stdout, imagePayload: null };
	return {
		cleanedStdout: stdout.replace(
			imageMatch[0],
			"[image captured — already shown to the user in the chat; do not describe or reproduce it]",
		),
		imagePayload: { mimeType: `image/${imageMatch[1]}`, base64: imageMatch[2] },
	};
}

export const IMAGE_RECIPE_DESCRIPTION =
	"To show an IMAGE (a chart, plot, generated picture, etc.): render it to an in-memory buffer, " +
	"base64-encode the bytes, and print ONLY the bare data URI on its own line — e.g. in Python: " +
	"`print(f'data:image/png;base64,{b64_string}')` (no markdown brackets, just that string). It's " +
	"captured automatically and shown to the user in the chat — do NOT retype, describe, or re-encode " +
	"the base64 data yourself in your reply; just refer to it naturally (e.g. \"here's the chart\"). " +
	"Only the first image printed by a run is captured.";
