import path from "node:path";

// ---------------------------------------------------------------------------
// Shared .gitignore + default-ignore utility
//
// All file-discovery tools (list_directory, search_files, search_content,
// find_dead_code, directory_tree) use this module to respect .gitignore
// patterns and always-skip common non-essential directories/files.
//
// Features:
//   - Case-insensitive matching for both hardcoded patterns and .gitignore
//   - Nested .gitignore support (loads per-directory .gitignore files)
//   - Caching of parsed .gitignore globs per directory path
// ---------------------------------------------------------------------------

/** Directories/files to ALWAYS ignore (stored lowercase for case-insensitive matching). */
const ALWAYS_IGNORE = new Set([
	// Version control
	".git", ".hg", ".svn",
	// JS/TS
	"node_modules", ".npm", ".yarn", ".pnp", "bower_components",
	// Build outputs
	"dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit",
	".turbo", ".vercel", ".netlify", ".parcel-cache",
	// Python
	"__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache",
	".pytest_cache", ".ruff_cache",
	// Rust
	"target",
	// .NET
	"bin", "obj", "packages",
	// Java/Kotlin
	".gradle", ".idea",
	// Go / PHP
	"vendor",
	// Ruby
	".bundle",
	// Elixir
	"_build", "deps",
	// General
	".ds_store", "thumbs.db", "coverage", ".nyc_output",
	".cache", ".temp", ".tmp", "tmp",
	// IDE
	".vscode", ".idea", ".eclipse",
]);

export interface IgnoreFilter {
	/** Returns true if the entry name should be ignored (case-insensitive). */
	isIgnored(name: string): boolean;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** Cached parsed .gitignore globs per directory absolute path. */
const gitignoreCache = new Map<string, Bun.Glob[]>();

/** Cached root IgnoreFilter per directory absolute path. */
const filterCache = new Map<string, IgnoreFilter>();

/** Clear all ignore-related caches (call at workflow start). */
export function clearIgnoreCache(): void {
	gitignoreCache.clear();
	filterCache.clear();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates an IgnoreFilter for a single directory.
 *
 * Combines ALWAYS_IGNORE + that directory's .gitignore patterns.
 * Result is cached per directory path.
 */
export async function createIgnoreFilter(dir: string): Promise<IgnoreFilter> {
	const absDir = path.resolve(dir);
	const cached = filterCache.get(absDir);
	if (cached) return cached;

	const globs = await loadDirGitignore(absDir);
	const filter: IgnoreFilter = {
		isIgnored(name: string): boolean {
			const lower = name.toLowerCase();
			if (ALWAYS_IGNORE.has(lower)) return true;
			return globs.some((g) => g.match(lower));
		},
	};

	filterCache.set(absDir, filter);
	return filter;
}

/**
 * Extend a parent IgnoreFilter with an additional directory's .gitignore.
 *
 * Used by recursive traversal (directory_tree's buildTree) so that nested
 * .gitignore rules accumulate as we descend into subdirectories.
 */
export async function extendIgnoreFilter(parent: IgnoreFilter, dir: string): Promise<IgnoreFilter> {
	const absDir = path.resolve(dir);
	const localGlobs = await loadDirGitignore(absDir);

	// If this directory has no .gitignore, just reuse the parent filter
	if (localGlobs.length === 0) return parent;

	return {
		isIgnored(name: string): boolean {
			if (parent.isIgnored(name)) return true;
			const lower = name.toLowerCase();
			return localGlobs.some((g) => g.match(lower));
		},
	};
}

/**
 * Check if a relative path should be ignored, considering nested .gitignore
 * files in each parent directory along the path.
 *
 * Used by tools that get flat relative paths from Bun.Glob.scan()
 * (search_files, search_content, find_dead_code).
 */
export async function isPathIgnored(relPath: string, rootDir: string): Promise<boolean> {
	const segments = relPath.split(/[/\\]/);
	let currentDir = path.resolve(rootDir);

	// Load the root .gitignore globs once
	const rootGlobs = await loadDirGitignore(currentDir);

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const lower = seg.toLowerCase();

		// Always-ignore check (case-insensitive)
		if (ALWAYS_IGNORE.has(lower)) return true;

		// Root .gitignore applies to all levels
		if (rootGlobs.some((g) => g.match(lower))) return true;

		// Nested .gitignore for intermediate directories
		if (i > 0) {
			const dirGlobs = await loadDirGitignore(currentDir);
			if (dirGlobs.some((g) => g.match(lower))) return true;
		}

		// Move into this segment for next iteration (only if not the last segment, i.e. a file)
		if (i < segments.length - 1) {
			currentDir = path.join(currentDir, seg);
		}
	}

	return false;
}

// ---------------------------------------------------------------------------
// Internal: .gitignore loader with caching
// ---------------------------------------------------------------------------

async function loadDirGitignore(absDir: string): Promise<Bun.Glob[]> {
	const cached = gitignoreCache.get(absDir);
	if (cached) return cached;

	let globs: Bun.Glob[];
	try {
		const content = await Bun.file(path.join(absDir, ".gitignore")).text();
		globs = parseGitignore(content);
	} catch {
		globs = [];
	}

	gitignoreCache.set(absDir, globs);
	return globs;
}

function parseGitignore(content: string): Bun.Glob[] {
	const globs: Bun.Glob[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Strip leading slash (root-anchored) — we match against names only
		let pattern = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
		// Strip trailing slash (directory indicator) for matching
		if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
		if (!pattern) continue;

		// Lowercase for case-insensitive matching
		pattern = pattern.toLowerCase();

		try {
			globs.push(new Bun.Glob(pattern));
		} catch {
			// Invalid glob pattern — skip
		}
	}
	return globs;
}
