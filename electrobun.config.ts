import { readdirSync } from "node:fs";
import type { ElectrobunConfig } from "electrobun";

// onnxruntime-node ships prebuilt native binaries for every OS/arch (win32, darwin, linux)
// bundled inside a single npm package, unlike sharp's per-platform optionalDependencies.
// Each release is built on its own native CI runner (see .github/workflows/release.yml —
// ubuntu-latest / windows-latest / macos-latest, no cross-compilation), so process.platform
// and process.arch here always match the platform being packaged — scope the copy to just
// that one platform/arch instead of shipping all ~127MB of every OS's binaries in every build.
const onnxPlatformBinDir = `node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}`;
const onnxPlatformBinDest = `bin/napi-v6/${process.platform}/${process.arch}`;

// On Windows, that same directory also bundles the DirectML execution provider's redistributables
// (DirectML.dll, dxcompiler.dll, dxil.dll — ~24MB combined). Collections' embedding pipeline
// (src/bun/collections/embeddings/embedder.ts) never passes a `device` option to `pipeline()`, so
// transformers.js falls back to its Node default, which is always "cpu" (never "dml") — see
// DEFAULT_DEVICE in @huggingface/transformers. ONNX Runtime only LoadLibrary()s an execution
// provider's DLL when that provider is actually requested at session creation, so these three
// files are dead weight here. Verified empirically: removing them and running a real CPU-EP
// session (InferenceSession.create + session.run) against the downloaded model.onnx still
// succeeds. Only applies to win32 — darwin/linux builds of onnxruntime-node don't bundle
// separate CoreML/CUDA redistributables in this directory, so there's nothing to trim there.
const WIN_DML_ONLY_FILES = new Set(["DirectML.dll", "dxcompiler.dll", "dxil.dll"]);

const onnxCopyEntries = Object.fromEntries(
	readdirSync(onnxPlatformBinDir)
		.filter((file) => process.platform !== "win32" || !WIN_DML_ONLY_FILES.has(file))
		.map((file) => [`${onnxPlatformBinDir}/${file}`, `${onnxPlatformBinDest}/${file}`]),
);

export default {
	app: {
		name: "AgentDesk",
		identifier: "com.sarfrazai.agentdesk",
		version: "2.7.0",
		// macOS Quick Chat deep link — the Finder Quick Action bundle
		// (quick-chat/os-integration.ts) invokes `open agentdesk://quick-chat?path=...`,
		// which macOS delivers to a running AgentDesk instance (or launches one) via
		// Electrobun's open-url event, handled in index.ts. Windows/Linux ignore this.
		urlSchemes: ["agentdesk"],
	},
	build: {
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"assets/icon.png": "views/assets/icon.png",
			"assets/tray-icon.png": "views/assets/tray-icon.png",
			// Read at runtime as appIconPath (src/bun/lib/app-icon.ts) for the Explorer
			// "Open in AgentDesk" registry entry's icon, and by scripts/postbuild-win-
			// icon.ts for the rcedit embed. `copy` is keyed by source path (one dest
			// per source), so this used to also list a "views/assets/icon.ico" mapping
			// under the same "assets/icon.ico" key — object keys can't collide, so that
			// entry silently never applied, and nothing in the app ever read it from
			// there anyway (the frontend favicon uses icon.png, not icon.ico) — removed.
			"assets/icon.ico": "app.ico",
			"plugins": "plugins",
			"skills": "skills",
			// onnxruntime-node's native binding (used by @huggingface/transformers for Collections'
			// local embedding model) is loaded via a require() relative to its own dist/ folder.
			// Bun's bundler flattens src/bun into a single bun/index.js, so that relative require
			// resolves to Resources/app/bin/napi-v6/... at runtime — copy the prebuilt .node
			// binaries there so the flattened bundle can still find them. Scoped to the current
			// build's platform/arch only, minus the unused DirectML files on Windows (see
			// onnxCopyEntries above) — copying the whole package's bin/ folder shipped every OS's
			// binaries (~127MB) in every release regardless of target.
			...onnxCopyEntries,
			// sharp (a transitive dependency of @huggingface/transformers, used for image
			// preprocessing) resolves its native binding via a bare `require("@img/sharp-<platform>-
			// <arch>/...")` — ordinary node_modules resolution, not a relative path. Bun's bundler
			// can't statically inline that dynamic specifier, so it survives as a real require() at
			// runtime; since node_modules is never shipped, that require always failed and crashed
			// the app on every startup (the sharp import is unconditional — see model-manager.ts).
			// Copying @img here lets Node's directory-walk-up resolution find it from
			// Resources/app/bun/index.js. Only copies whatever platform packages are installed on
			// the machine that ran this build, so each OS/arch's own CI build picks up its own.
			"node_modules/@img": "node_modules/@img",
			"release-notes.json": "release-notes.json",
			"assets/uninstall.ps1": "uninstall.ps1",
		},
		// Ignore Vite output and the React source tree in `electrobun dev --watch`.
		// Vite's own HMR handles src/mainview/* — letting Electrobun also watch it
		// would trigger a full app restart on every React edit and clobber HMR.
		watchIgnore: ["dist/**", "src/mainview/**"],
		mac: {
			bundleCEF: false,
			// .iconset folder (generated from assets/icon.png via sharp — see PR that
			// added this) — Electrobun converts it to .icns via iconutil during the
			// mac build. iconutil only exists on macOS, so this is a no-op warning on
			// any non-mac build host; harmless here since mac builds only ever run on
			// macos-latest CI (see the onnxruntime-node comment above for why).
			icons: "assets/icon.iconset",
			// WKWebView requires this entitlement to even prompt for the mic (voice input).
			entitlements: {
				"com.apple.security.device.audio-input": "Microphone access for voice-to-text input",
			},
		},
		linux: {
			bundleCEF: true,
			icon: "assets/icon.png",
		},
		win: {
			bundleCEF: false,
			// Embedded into launcher.exe/bun.exe via rcedit during the build. Confirmed
			// via live UI inspection this only brands File Explorer / the exe file
			// itself — Electrobun's native window class does NOT pick this up for the
			// running window's taskbar/titlebar icon, so src/bun/lib/app-icon.ts's
			// runtime user32.dll WM_SETICON call is still required for that (called
			// from index.ts and quick-chat/window.ts on dom-ready) — keep both. NOTE:
			// Electrobun's own embed step for this currently fails silently on Windows
			// (its precompiled CLI binary's require.resolve for "rcedit" resolves
			// against its own CI build path, not this project's node_modules) —
			// scripts.postBuild below redoes it as a plain `bun` process, which
			// resolves rcedit correctly. See that script's comment.
			icon: "assets/icon.ico",
		},
	},
	scripts: {
		postBuild: "scripts/postbuild-win-icon.ts",
	},
	// Update distribution — point to your GitHub Releases page.
	// Format: "https://github.com/YOUR_ORG/YOUR_REPO/releases/latest/download"
	// The updater fetches {baseUrl}/{channel}-{os}-{arch}-update.json to check for updates.
	release: {
		baseUrl: "https://github.com/sarfraznawaz2005/agentdesk/releases/latest/download",
		// A non-dev Electrobun build downloads the CURRENTLY-PUBLISHED release
		// tarball from baseUrl to compute a binary diff (so the auto-updater can
		// ship small incremental patches to real users) — real for CI release
		// builds (release.yml), but a local dev build (build.ps1) has no need
		// for that: it just wants a fast, offline, runnable build of whatever's
		// on disk right now. build.ps1 sets AGENTDESK_SKIP_PATCH=1 to skip it.
		generatePatch: process.env.AGENTDESK_SKIP_PATCH !== "1",
	},
} satisfies ElectrobunConfig;
