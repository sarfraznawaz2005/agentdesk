import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/bun/db/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		// Runtime path is resolved dynamically via Utils.paths.userData.
		// This placeholder is only used by the drizzle-kit CLI for local
		// migration generation — not at application runtime.
		url: "./agentdesk.db",
	},
});
