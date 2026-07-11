import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "AgentDesk",
		identifier: "com.sarfrazai.agentdesk",
		version: "2.5.5",
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
			// binaries there so the flattened bundle can still find them.
			"node_modules/onnxruntime-node/bin": "bin",
			"release-notes.json": "release-notes.json",
			"assets/uninstall.ps1": "uninstall.ps1",
		},
		// Ignore Vite output and the React source tree in `electrobun dev --watch`.
		// Vite's own HMR handles src/mainview/* — letting Electrobun also watch it
		// would trigger a full app restart on every React edit and clobber HMR.
		watchIgnore: ["dist/**", "src/mainview/**"],
		mac: {
			bundleCEF: false,
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
