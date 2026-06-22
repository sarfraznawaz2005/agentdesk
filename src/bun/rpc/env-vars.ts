import { db } from "../db";
import { customEnvVars } from "../db/schema";
import { isUniqueViolation } from "../db/errors";
import { and, eq, ne } from "drizzle-orm";
import type { CustomEnvVar } from "../../shared/rpc/env-vars";

// ---------------------------------------------------------------------------
// OS environment persistence helpers
// Each helper is best-effort: errors are logged but never thrown to callers.
// ---------------------------------------------------------------------------

async function setOsEnvVar(name: string, value: string): Promise<void> {
	// Always update the current process immediately — agents read process.env
	process.env[name] = value;

	try {
		if (process.platform === "win32") {
			// Persist to HKCU\Environment (user-level, survives reboots)
			const proc = Bun.spawn(
				["reg", "add", "HKCU\\Environment", "/v", name, "/t", "REG_SZ", "/d", value, "/f"],
				{ stdout: "ignore", stderr: "ignore" },
			);
			await proc.exited;
		} else if (process.platform === "darwin") {
			// Set for the current launchd session
			const proc = Bun.spawn(["launchctl", "setenv", name, value], {
				stdout: "ignore",
				stderr: "ignore",
			});
			await proc.exited;
			// Also persist to shell profile so new terminal sessions pick it up
			await upsertShellProfileLine(name, value);
		} else {
			// Linux: persist to shell profile
			await upsertShellProfileLine(name, value);
		}
	} catch (err) {
		console.warn(`[env-vars] OS persist failed for ${name}:`, err);
	}
}

async function deleteOsEnvVar(name: string): Promise<void> {
	// Remove from current process immediately (use Object.assign workaround for no-dynamic-delete)
	// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
	delete process.env[name];

	try {
		if (process.platform === "win32") {
			const proc = Bun.spawn(
				["reg", "delete", "HKCU\\Environment", "/v", name, "/f"],
				{ stdout: "ignore", stderr: "ignore" },
			);
			await proc.exited;
		} else if (process.platform === "darwin") {
			const proc = Bun.spawn(["launchctl", "unsetenv", name], {
				stdout: "ignore",
				stderr: "ignore",
			});
			await proc.exited;
			await removeShellProfileLine(name);
		} else {
			await removeShellProfileLine(name);
		}
	} catch (err) {
		console.warn(`[env-vars] OS delete failed for ${name}:`, err);
	}
}

// Dedicated section markers used to manage the lines we own in shell profiles
const SECTION_START = "# >>> AgentDesk managed env vars >>>";
const SECTION_END   = "# <<< AgentDesk managed env vars <<<";

function getShellProfilePath(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (process.platform === "darwin") {
		return `${home}/.zprofile`;
	}
	return `${home}/.profile`;
}

async function upsertShellProfileLine(name: string, value: string): Promise<void> {
	const path = getShellProfilePath();
	const file = Bun.file(path);
	const existing = (await file.exists()) ? await file.text() : "";

	const exportLine = `export ${name}="${value.replace(/"/g, '\\"')}"`;

	if (existing.includes(SECTION_START)) {
		// Replace the export line inside the managed section (or add it)
		const sections = existing.split(SECTION_START);
		const before = sections[0];
		const after = sections[1].split(SECTION_END);
		const inner = after[0];
		const rest  = after[1] ?? "";

		const namePattern = new RegExp(`^export ${name}=.*$`, "m");
		const newInner = namePattern.test(inner)
			? inner.replace(namePattern, exportLine)
			: `${inner}${exportLine}\n`;

		await Bun.write(path, `${before}${SECTION_START}${newInner}${SECTION_END}${rest}`);
	} else {
		// Append a new managed section at the end
		const sep = existing.endsWith("\n") ? "" : "\n";
		await Bun.write(path, `${existing}${sep}\n${SECTION_START}\n${exportLine}\n${SECTION_END}\n`);
	}
}

async function removeShellProfileLine(name: string): Promise<void> {
	const path = getShellProfilePath();
	const file = Bun.file(path);
	if (!(await file.exists())) return;

	const existing = await file.text();
	if (!existing.includes(SECTION_START)) return;

	const sections = existing.split(SECTION_START);
	const before = sections[0];
	const after = sections[1].split(SECTION_END);
	const inner = after[0];
	const rest  = after[1] ?? "";

	const namePattern = new RegExp(`^export ${name}=.*\n?`, "m");
	const newInner = inner.replace(namePattern, "");

	await Bun.write(path, `${before}${SECTION_START}${newInner}${SECTION_END}${rest}`);
}

// ---------------------------------------------------------------------------
// Startup loader — call once after DB migrations to inject stored vars
// ---------------------------------------------------------------------------

export async function loadCustomEnvVarsIntoProcess(): Promise<void> {
	try {
		const rows = db.select().from(customEnvVars).all();
		for (const row of rows) {
			process.env[row.name] = row.value;
		}
		if (rows.length > 0) {
			console.log(`[env-vars] Loaded ${rows.length} custom env var(s) into process.`);
		}
	} catch (err) {
		console.error("[env-vars] Failed to load custom env vars on startup:", err);
	}
}

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

function toDto(row: typeof customEnvVars.$inferSelect): CustomEnvVar {
	return {
		id:        row.id,
		name:      row.name,
		value:     row.value,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function listCustomEnvVars(): CustomEnvVar[] {
	return db.select().from(customEnvVars).all().map(toDto);
}

export async function createCustomEnvVar(params: { name: string; value: string }): Promise<CustomEnvVar> {
	const trimmedName = params.name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
	if (!trimmedName) throw new Error("Variable name cannot be empty.");

	const existing = db.select().from(customEnvVars).where(eq(customEnvVars.name, trimmedName)).get();
	if (existing) throw new Error(`A variable named "${trimmedName}" already exists.`);

	// The check above is a fast, friendly path — but it is not atomic with the
	// insert, so a rapid retry / double-submit can pass the check twice and let
	// the UNIQUE(name) constraint throw an unfriendly SQLiteError to the error
	// log. `onConflictDoNothing` makes the constraint the single source of truth:
	// a losing race inserts nothing, `returning()` comes back empty, and we
	// translate that into the same friendly message instead of crashing.
	const [row] = await db
		.insert(customEnvVars)
		.values({ name: trimmedName, value: params.value })
		.onConflictDoNothing({ target: customEnvVars.name })
		.returning();

	if (!row) throw new Error(`A variable named "${trimmedName}" already exists.`);

	await setOsEnvVar(trimmedName, params.value);
	return toDto(row);
}

export async function updateCustomEnvVar(params: { id: string; name?: string; value?: string }): Promise<CustomEnvVar> {
	const existing = db.select().from(customEnvVars).where(eq(customEnvVars.id, params.id)).get();
	if (!existing) throw new Error("Environment variable not found.");

	const updates: Partial<typeof customEnvVars.$inferInsert> = {
		updatedAt: new Date().toISOString(),
	};

	let newName = existing.name;
	let newValue = existing.value;

	if (params.name !== undefined) {
		newName = params.name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
		if (!newName) throw new Error("Variable name cannot be empty.");
		const conflict = db.select().from(customEnvVars)
			.where(and(eq(customEnvVars.name, newName), ne(customEnvVars.id, params.id)))
			.get();
		if (conflict) throw new Error(`A variable named "${newName}" already exists.`);
		updates.name = newName;
	}
	if (params.value !== undefined) {
		newValue = params.value;
		updates.value = newValue;
	}

	let row: typeof customEnvVars.$inferSelect | undefined;
	try {
		[row] = await db
			.update(customEnvVars)
			.set(updates)
			.where(eq(customEnvVars.id, params.id))
			.returning();
	} catch (err) {
		// Mirror createCustomEnvVar: the conflict pre-check is not atomic with the
		// UPDATE, so a concurrent rename can still trip UNIQUE(name). Translate that
		// into the same friendly message rather than leaking a raw SQLiteError.
		if (isUniqueViolation(err)) {
			throw new Error(`A variable named "${newName}" already exists.`, { cause: err });
		}
		throw err;
	}
	if (!row) throw new Error("Environment variable not found.");

	// If name changed: remove old key from process.env and OS, set new one
	if (params.name !== undefined && newName !== existing.name) {
		await deleteOsEnvVar(existing.name);
	}
	await setOsEnvVar(newName, newValue);

	return toDto(row);
}

export async function deleteCustomEnvVar(params: { id: string }): Promise<{ success: boolean }> {
	const existing = db.select().from(customEnvVars).where(eq(customEnvVars.id, params.id)).get();
	if (!existing) return { success: false };

	await db.delete(customEnvVars).where(eq(customEnvVars.id, params.id));
	await deleteOsEnvVar(existing.name);

	return { success: true };
}
