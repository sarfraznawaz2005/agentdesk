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
		version: "2.6.1",
	},
	build: {
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"assets/icon.png": "views/assets/icon.png",
			"assets/tray-icon.png": "views/assets/tray-icon.png",
			"assets/icon.ico": "views/assets/icon.ico",
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
			// WKWebView requires this entitlement to even prompt for the mic (voice input).
			entitlements: {
				"com.apple.security.device.audio-input": "Microphone access for voice-to-text input",
			},
		},
		linux: {
			bundleCEF: true,
		},
		win: {
			bundleCEF: false,
		},
	},
	// Update distribution — point to your GitHub Releases page.
	// Format: "https://github.com/YOUR_ORG/YOUR_REPO/releases/latest/download"
	// The updater fetches {baseUrl}/{channel}-{os}-{arch}-update.json to check for updates.
	release: {
		baseUrl: "https://github.com/sarfraznawaz2005/agentdesk/releases/latest/download",
	},
} satisfies ElectrobunConfig;
