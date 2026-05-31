import { getAllServerDefs, SERVER_DEFS } from "../lsp/servers";
import { getInstallStatus, installServer, uninstallServer, checkPrerequisite } from "../lsp/installer";
import type { LspServerStatus } from "../../shared/rpc/lsp";
import { db } from "../db";
import { plugins as pluginsTable } from "../db/schema";
import { eq } from "drizzle-orm";

/** Manifest defaults for LSP settings. */
import manifestJson from "../plugins/lsp-manager/manifest.json";

const manifestDefaults: Record<string, unknown> = Object.fromEntries(
	Object.entries(manifestJson.settings).map(([k, v]) => [k, v.default ?? null]),
);

/** Load LSP-related plugin settings from the DB, falling back to manifest defaults. */
async function getLspSettings(): Promise<Record<string, unknown>> {
	let dbSettings: Record<string, unknown> = {};
	try {
		const rows = await db.select().from(pluginsTable).where(eq(pluginsTable.name, "lsp-manager")).limit(1);
		if (rows.length > 0 && rows[0].settings) {
			dbSettings = JSON.parse(rows[0].settings);
		}
	} catch {
		// Fall through
	}
	return { ...manifestDefaults, ...dbSettings };
}

export async function getLspStatus(): Promise<LspServerStatus[]> {
	const settings = await getLspSettings();
	const defs = getAllServerDefs();
	const results: LspServerStatus[] = [];

	for (const def of defs) {
		const enabledKey = `${def.id}_enabled`;
		const binaryKey = `${def.id}_binary`;
		const isEnabled = settings[enabledKey] !== false;

		if (!isEnabled) {
			results.push({
				id: def.id,
				displayName: def.displayName,
				extensions: def.extensions,
				status: "disabled",
			});
			continue;
		}

		const installStatus = await getInstallStatus(def, settings[binaryKey] as string | undefined);

		let prereq: LspServerStatus["prereq"] | undefined;
		if (def.install.prereq) {
			const missing = !(await checkPrerequisite(def.install.prereq.binary));
			prereq = { tool: def.install.prereq.tool, installUrl: def.install.prereq.installUrl, missing };
		}

		results.push({
			id: def.id,
			displayName: def.displayName,
			extensions: def.extensions,
			status: installStatus.status === "installed" ? "installed" : installStatus.status,
			source: installStatus.source,
			prereq,
		});
	}

	return results;
}

export async function installLspServerHandler(serverId: string): Promise<{ success: boolean; error?: string }> {
	const def = SERVER_DEFS[serverId];
	if (!def) {
		return { success: false, error: `Unknown server: ${serverId}` };
	}

	try {
		await installServer(def);
		return { success: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, error: msg };
	}
}

export async function uninstallLspServerHandler(serverId: string): Promise<{ success: boolean; error?: string }> {
	const def = SERVER_DEFS[serverId];
	if (!def) {
		return { success: false, error: `Unknown server: ${serverId}` };
	}

	try {
		await uninstallServer(def);
		return { success: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, error: msg };
	}
}
