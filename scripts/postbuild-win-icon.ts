// electrobun.config.ts's scripts.postBuild hook — Windows only.
//
// electrobun.config.ts's build.win.icon setting SHOULD be enough on its own
// (Electrobun embeds it into launcher.exe/bun.exe via rcedit during the
// build). It isn't, currently: the installed electrobun.exe is a Bun
// single-file-compiled binary, and its internal require.resolve("rcedit/
// package.json") call resolves against an absolute path baked in at
// Electrobun's OWN release-build time (its CI checkout path, something like
// "D:\a\electrobun\electrobun\package\node_modules\rcedit\..."), not this
// project's real node_modules — so the embed silently fails with "Cannot
// find module" on every Windows build (caught internally, only a console
// warning, never fails the build outright).
//
// This hook redoes the embed ourselves, as an ordinary `bun <script>`
// process (not the compiled electrobun.exe), where require.resolve("rcedit/
// package.json") resolves correctly against our own real node_modules/rcedit.
// Runs after Electrobun's own build (postBuild fires once launcher.exe/
// bun.exe already exist in the build output) for both `electrobun dev` and
// `electrobun build` (run.ps1 and CI use the same hook path either way).
//
// Safe to delete once a future Electrobun release fixes the underlying
// require.resolve bug — this becomes a harmless no-op re-embed at that
// point, not a source of drift.

import { execFileSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";

if (process.env.ELECTROBUN_OS !== "win") process.exit(0);

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const iconPath = join(process.cwd(), "assets", "icon.ico");
if (!buildDir || !existsSync(buildDir) || !existsSync(iconPath)) process.exit(0);

function findTargets(dir: string, names: Set<string>, found: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (stat.isDirectory()) { findTargets(full, names, found); continue; }
		if (names.has(entry.toLowerCase())) found.push(full);
	}
	return found;
}

const targets = findTargets(buildDir, new Set(["launcher.exe", "bun.exe"]));
if (targets.length === 0) {
	console.warn("[postBuild:win-icon] No launcher.exe/bun.exe found under", buildDir);
	process.exit(0);
}

const rceditPkgPath = require.resolve("rcedit/package.json");
const rceditDir = dirname(rceditPkgPath);
const rceditX64 = join(rceditDir, "bin", "rcedit-x64.exe");
const rceditExe = existsSync(rceditX64) ? rceditX64 : join(rceditDir, "bin", "rcedit.exe");

for (const target of targets) {
	try {
		execFileSync(rceditExe, [target, "--set-icon", iconPath]);
		console.log(`[postBuild:win-icon] Embedded icon into ${target}`);
	} catch (err) {
		console.warn(`[postBuild:win-icon] Failed to embed icon into ${target}:`, err);
	}
}
