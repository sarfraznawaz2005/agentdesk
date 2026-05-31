import { join, resolve } from "path";
import { existsSync, mkdirSync, rmSync } from "fs";
import { Utils } from "electrobun/bun";
import { loadAllSkills, resolveSkillContent } from "./loader";
import type { Skill } from "./loader";

export type { Skill } from "./loader";

// ---------------------------------------------------------------------------
// SkillRegistry — in-memory singleton
// ---------------------------------------------------------------------------

class SkillRegistry {
	private skills = new Map<string, Skill>();
	private _userDir: string | null = null;
	private _bundledDir: string | null = null;

	/** Absolute path to the user skills directory (read-write). */
	get dir(): string {
		if (!this._userDir) {
			this._userDir = join(Utils.paths.userData, "skills");
		}
		return this._userDir;
	}

	/** Absolute path to the bundled skills directory (read-only, shipped with app). */
	get bundledDir(): string {
		if (!this._bundledDir) {
			// In production, Electrobun bundles into Resources/app/bun/,
			// so ../skills/ reaches the copied skills/ directory.
			const buildResolved = resolve(import.meta.dir, "../skills");

			// In dev mode, process.cwd() is the project root (run.ps1 launches from there).
			// Prefer project-root skills/ so new skills are picked up on Refresh
			// without rebuilding.
			const projectRoot = join(process.cwd(), "skills");
			if (existsSync(projectRoot) && resolve(projectRoot) !== resolve(buildResolved)) {
				this._bundledDir = projectRoot;
			} else {
				this._bundledDir = buildResolved;
			}
		}
		return this._bundledDir;
	}

	/**
	 * Load all skills from both bundled and user directories.
	 * Bundled skills load first; user skills can override by name.
	 * Creates the user directory if it doesn't exist.
	 */
	loadAll(): void {
		const userDir = this.dir;
		if (!existsSync(userDir)) {
			mkdirSync(userDir, { recursive: true });
			console.log(`[skills] Created user skills directory: ${userDir}`);
		}

		this.skills.clear();

		// 1. Load bundled (built-in) skills first
		const bundledDir = this.bundledDir;
		if (existsSync(bundledDir)) {
			const bundled = loadAllSkills(bundledDir);
			for (const skill of bundled) {
				if (this.skills.has(skill.name)) {
					console.warn(`[skills] Duplicate bundled skill "${skill.name}" — skipping ${skill.dirPath}`);
					continue;
				}
				skill.isBundled = true;
				this.skills.set(skill.name, skill);
			}
			if (bundled.length > 0) {
				console.log(`[skills] Loaded ${bundled.length} built-in skill(s) from ${bundledDir}`);
			}
		}

		// 2. Load user skills — overrides bundled skills with same name
		const userSkills = loadAllSkills(userDir);
		for (const skill of userSkills) {
			if (this.skills.has(skill.name)) {
				console.log(`[skills] User skill "${skill.name}" overrides built-in`);
			}
			this.skills.set(skill.name, skill);
		}
	}

	/** Re-scan both skill directories. */
	reload(): void {
		this.loadAll();
	}

	/** Get all loaded skills. */
	getAll(): Skill[] {
		return Array.from(this.skills.values());
	}

	/** Get a skill by exact name. */
	getByName(name: string): Skill | null {
		return this.skills.get(name) ?? null;
	}

	/**
	 * Search skills by keyword query.
	 * Case-insensitive substring match on name and description.
	 */
	search(query: string): Skill[] {
		const q = query.toLowerCase();
		return this.getAll().filter(
			(s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
		);
	}

	/**
	 * Resolve a skill's content with optional arguments.
	 * Runs bash injections and argument substitutions.
	 */
	resolveContent(skill: Skill, args?: string): string {
		return resolveSkillContent(skill, args, this.dir);
	}

	/**
	 * Delete a user-installed skill by name.
	 * Returns { success, error? }. Refuses to delete bundled skills.
	 */
	deleteSkill(name: string): { success: boolean; error?: string } {
		const skill = this.skills.get(name);
		if (!skill) return { success: false, error: `Skill "${name}" not found.` };
		if (skill.isBundled) return { success: false, error: `Cannot delete bundled skill "${name}".` };

		try {
			rmSync(skill.dirPath, { recursive: true, force: true });
			this.skills.delete(name);
			console.log(`[skills] Deleted user skill "${name}" from ${skill.dirPath}`);
			return { success: true };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[skills] Failed to delete "${name}":`, msg);
			return { success: false, error: msg };
		}
	}

	/** Number of loaded skills. */
	get count(): number {
		return this.skills.size;
	}
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const skillRegistry = new SkillRegistry();
