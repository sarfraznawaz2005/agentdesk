import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "AgentDesk",
		identifier: "com.sarfrazai.agentdesk",
		version: "2.1.5",
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
