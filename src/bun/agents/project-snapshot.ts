import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

/** Module-level cache: workspace path → snapshot string */
const snapshotCache = new Map<string, string>();

/** Clear the snapshot cache for a specific path or all paths. */
export function clearProjectSnapshotCache(workspacePath?: string): void {
	if (workspacePath) snapshotCache.delete(workspacePath);
	else snapshotCache.clear();
}

/**
 * Build or return a cached lightweight project snapshot for the workspace.
 * Includes: top-level directory listing, package.json tech stack summary.
 */
export function getProjectSnapshot(workspacePath?: string | null): string {
	if (!workspacePath) return "";
	const cached = snapshotCache.get(workspacePath);
	if (cached !== undefined) return cached;

	try {
		const lines: string[] = ["## Project Snapshot (shared context — read this before exploring the codebase)"];

		// Top-level directory listing
		try {
			const entries = readdirSync(workspacePath, { withFileTypes: true })
				.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist" && e.name !== "build")
				.slice(0, 40);
			const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`);
			const files = entries.filter((e) => e.isFile()).map((e) => e.name);
			lines.push("", "### Workspace structure", "```", ...dirs, ...files, "```");
		} catch { /* skip if unreadable */ }

		// Detect project type from manifest files
		const manifests: Array<{ file: string; label: string; parser?: (raw: string) => string[] }> = [
			{ file: "package.json", label: "Node.js / JS", parser: (raw) => {
				const pkg = JSON.parse(raw);
				const out: string[] = [];
				const deps = Object.keys(pkg.dependencies ?? {}).slice(0, 20);
				const devDeps = Object.keys(pkg.devDependencies ?? {}).slice(0, 15);
				const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 10);
				if (deps.length) out.push(`Dependencies: ${deps.join(", ")}`);
				if (devDeps.length) out.push(`Dev deps: ${devDeps.join(", ")}`);
				if (scripts.length) out.push(`Scripts: ${scripts.join(", ")}`);
				return out;
			}},
			{ file: "composer.json", label: "PHP (Composer)" },
			{ file: "Cargo.toml", label: "Rust (Cargo)" },
			{ file: "go.mod", label: "Go" },
			{ file: "requirements.txt", label: "Python" },
			{ file: "pyproject.toml", label: "Python" },
			{ file: "Gemfile", label: "Ruby" },
			{ file: "pom.xml", label: "Java (Maven)" },
			{ file: "build.gradle", label: "Java/Kotlin (Gradle)" },
			{ file: "CMakeLists.txt", label: "C/C++ (CMake)" },
			{ file: "Makefile", label: "Make-based project" },
		];

		for (const m of manifests) {
			const mPath = join(workspacePath, m.file);
			if (existsSync(mPath)) {
				try {
					lines.push("", `### Tech stack: ${m.label}`);
					if (m.parser) {
						const raw = readFileSync(mPath, "utf-8");
						lines.push(...m.parser(raw));
					}
				} catch { /* skip malformed manifest */ }
				break;
			}
		}

		// Show first matching source directory layout
		const sourceDirs = ["src", "lib", "app", "include", "cmd", "pkg", "internal"];
		for (const dir of sourceDirs) {
			const dirPath = join(workspacePath, dir);
			if (existsSync(dirPath)) {
				try {
					const entries = readdirSync(dirPath, { withFileTypes: true }).slice(0, 30);
					const subDirs = entries.filter((e) => e.isDirectory()).map((e) => `${dir}/${e.name}/`);
					const subFiles = entries.filter((e) => e.isFile()).map((e) => `${dir}/${e.name}`);
					if (subDirs.length || subFiles.length) {
						lines.push("", `### ${dir}/ layout`, "```", ...subDirs, ...subFiles, "```");
					}
				} catch { /* skip */ }
				break;
			}
		}

		const result = lines.join("\n");
		snapshotCache.set(workspacePath, result);
		return result;
	} catch {
		return "";
	}
}
