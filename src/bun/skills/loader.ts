import { join, relative, basename } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import { execSync } from "child_process";
import matter from "gray-matter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillValidationError {
	field: string;
	message: string;
}

export interface Skill {
	name: string;
	description: string;
	dirPath: string;
	filePath: string;
	content: string;
	allowedTools: string[];
	argumentHint?: string;
	preferredAgent?: string;
	supportingFiles: string[];
	errors: SkillValidationError[];
	/** Whether this skill ships with the app (true) or is user-installed (false). */
	isBundled: boolean;
	/** Hidden skills are not shown in the Skills UI but are available to agents. */
	hidden: boolean;
	/**
	 * Optional feature gate. When set, the skill is only included in agent
	 * system prompts when the named feature is enabled (e.g. "freelance").
	 */
	feature?: string;
}

interface SkillFrontmatter {
	name?: string;
	description?: string;
	"allowed-tools"?: string;
	"argument-hint"?: string;
	agent?: string;
	hidden?: boolean;
	feature?: string;
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

/**
 * Scan a directory for subdirectories containing SKILL.md.
 * Returns absolute paths to each skill directory found.
 */
export function scanSkillsDirectory(dir: string): string[] {
	if (!existsSync(dir)) return [];

	const results: string[] = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillDir = join(dir, entry.name);
			const skillFile = join(skillDir, "SKILL.md");
			if (existsSync(skillFile)) {
				results.push(skillDir);
			}
		}
	} catch (err) {
		console.warn(`[skills] Failed to scan directory ${dir}:`, err instanceof Error ? err.message : err);
	}
	return results;
}

// ---------------------------------------------------------------------------
// SKILL.md parsing
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md file into a Skill object.
 * Returns null if the file cannot be read or parsed.
 */
export function parseSkillFile(skillDir: string): Skill | null {
	const filePath = join(skillDir, "SKILL.md");
	try {
		const raw = readFileSync(filePath, "utf-8");
		const { data, content } = matter(raw);
		const fm = data as SkillFrontmatter;

		const dirName = basename(skillDir);
		const errors = validateSkill(fm, dirName);
		const name = resolveSkillName(fm.name, dirName);
		const description = fm.description || extractFirstParagraph(content) || "";

		// Parse allowed-tools: accept both comma-delimited and space-delimited
		const allowedTools: string[] = [];
		if (fm["allowed-tools"]) {
			const raw = String(fm["allowed-tools"]);
			// Split by comma or whitespace (handles "Read, Grep" and "Read Grep")
			for (const t of raw.split(/[,\s]+/)) {
				const trimmed = t.trim();
				if (trimmed) allowedTools.push(trimmed);
			}
		}

		const supportingFiles = loadSupportingFiles(skillDir);

		return {
			name,
			description,
			dirPath: skillDir,
			filePath,
			content: content.trim(),
			allowedTools,
			argumentHint: fm["argument-hint"] ?? undefined,
			preferredAgent: fm.agent ?? undefined,
			supportingFiles,
			errors,
			isBundled: false,
			hidden: fm.hidden === true,
			feature: fm.feature ?? undefined,
		};
	} catch (err) {
		console.warn(`[skills] Failed to parse ${filePath}:`, err instanceof Error ? err.message : err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * Validate a skill's frontmatter against the Agent Skills specification.
 * Returns an array of validation errors (empty = valid).
 */
export function validateSkill(
	fm: SkillFrontmatter,
	dirName: string,
): SkillValidationError[] {
	const errors: SkillValidationError[] = [];

	// name — required
	if (!fm.name || !fm.name.trim()) {
		errors.push({ field: "name", message: "Required field \"name\" is missing in frontmatter." });
	} else {
		const name = fm.name.trim();
		if (name.length > MAX_NAME_LENGTH) {
			errors.push({ field: "name", message: `Name exceeds ${MAX_NAME_LENGTH} characters (got ${name.length}).` });
		}
		if (!NAME_PATTERN.test(name)) {
			errors.push({ field: "name", message: "Name must contain only lowercase letters, numbers, and hyphens. Must not start or end with a hyphen." });
		}
		if (/--/.test(name)) {
			errors.push({ field: "name", message: "Name must not contain consecutive hyphens (--)." });
		}
		if (name !== dirName) {
			errors.push({ field: "name", message: `Name "${name}" must match parent directory name "${dirName}".` });
		}
	}

	// description — required
	if (!fm.description || !fm.description.trim()) {
		errors.push({ field: "description", message: "Required field \"description\" is missing in frontmatter." });
	} else if (fm.description.trim().length > MAX_DESCRIPTION_LENGTH) {
		errors.push({
			field: "description",
			message: `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters (got ${fm.description.trim().length}).`,
		});
	}

	return errors;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve skill name: use frontmatter name if valid, otherwise fall back to directory name.
 * Name must be lowercase letters, numbers, and hyphens only (max 64 chars).
 */
function resolveSkillName(frontmatterName: string | undefined, dirName: string): string {
	if (frontmatterName && NAME_PATTERN.test(frontmatterName) && !(/--/.test(frontmatterName)) && frontmatterName.length <= MAX_NAME_LENGTH) {
		return frontmatterName;
	}
	// Normalize directory name: lowercase, replace underscores/spaces with hyphens
	const normalized = dirName.toLowerCase().replace(/[_\s]+/g, "-").replace(/[^a-z0-9-]/g, "");
	return normalized.slice(0, 64) || "unnamed-skill";
}

/**
 * Extract the first non-empty paragraph from markdown content.
 * Used as fallback description when frontmatter description is missing.
 */
function extractFirstParagraph(content: string): string {
	const lines = content.split("\n");
	const paragraph: string[] = [];
	let started = false;

	for (const line of lines) {
		const trimmed = line.trim();
		// Skip headings and empty lines at the start
		if (!started) {
			if (!trimmed || trimmed.startsWith("#")) continue;
			started = true;
		}
		if (started) {
			if (!trimmed) break; // end of paragraph
			paragraph.push(trimmed);
		}
	}
	return paragraph.join(" ").slice(0, 200);
}

/**
 * List supporting files in a skill directory (everything except SKILL.md).
 * Returns relative paths from the skill directory.
 */
export function loadSupportingFiles(skillDir: string): string[] {
	const files: string[] = [];
	try {
		collectFiles(skillDir, skillDir, files);
	} catch (err) {
		console.warn(`[skills] Failed to list supporting files in ${skillDir}:`, err instanceof Error ? err.message : err);
	}
	return files;
}

function collectFiles(baseDir: string, currentDir: string, results: string[]): void {
	const entries = readdirSync(currentDir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(currentDir, entry.name);
		if (entry.isDirectory()) {
			collectFiles(baseDir, fullPath, results);
		} else if (entry.isFile() && entry.name !== "SKILL.md") {
			results.push(relative(baseDir, fullPath).replace(/\\/g, "/"));
		}
	}
}

/**
 * Load all skills from a directory. Convenience function that combines
 * scanSkillsDirectory + parseSkillFile for each found skill.
 */
export function loadAllSkills(dir: string): Skill[] {
	const skillDirs = scanSkillsDirectory(dir);
	const skills: Skill[] = [];

	for (const skillDir of skillDirs) {
		const skill = parseSkillFile(skillDir);
		if (skill) {
			skills.push(skill);
		}
	}

	console.log(`[skills] Loaded ${skills.length} skill(s) from ${dir}`);
	return skills;
}

// ---------------------------------------------------------------------------
// Content Resolution
// ---------------------------------------------------------------------------

/**
 * Process !`command` bash injection blocks in skill content.
 * Executes each command and replaces the placeholder with its output.
 * Failed commands produce an error message instead of crashing.
 */
export function executeBashInjections(content: string): string {
	// Match !`command` syntax — backtick-wrapped shell commands prefixed with !
	return content.replace(/!`([^`]+)`/g, (_match, command: string) => {
		try {
			const output = execSync(command.trim(), {
				encoding: "utf-8",
				timeout: 10_000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			return output.trim();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return `[Error running command: ${command.trim()}] ${msg}`;
		}
	});
}

/**
 * Replace argument placeholders in skill content.
 *
 * Supported placeholders:
 * - $ARGUMENTS — all arguments as a single string
 * - $ARGUMENTS[N] — specific argument by 0-based index
 * - $N — shorthand for $ARGUMENTS[N] (e.g. $0, $1)
 * - ${AGENTDESK_SKILL_DIR} — absolute path to the skill directory
 * - ${AGENTDESK_SKILLS_USER_DIR} — absolute path to the user skills directory (for creating new skills)
 */
export function substituteArguments(
	content: string,
	skillDirPath: string,
	args?: string,
	userSkillsDir?: string,
): string {
	const argString = args ?? "";
	const argParts = argString.trim() ? argString.trim().split(/\s+/) : [];

	let result = content;

	// ${AGENTDESK_SKILL_DIR}
	result = result.replace(/\$\{AGENTDESK_SKILL_DIR\}/g, skillDirPath.replace(/\\/g, "/"));

	// ${AGENTDESK_SKILLS_USER_DIR}
	if (userSkillsDir) {
		result = result.replace(/\$\{AGENTDESK_SKILLS_USER_DIR\}/g, userSkillsDir.replace(/\\/g, "/"));
	}

	// $ARGUMENTS[N] — must come before $ARGUMENTS to avoid partial match
	result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) => {
		const i = parseInt(index, 10);
		return argParts[i] ?? "";
	});

	// $ARGUMENTS
	result = result.replace(/\$ARGUMENTS/g, argString);

	// $N shorthand (only single/double digit to avoid false positives in content)
	// Must not match ${...} patterns or $ARGUMENTS
	result = result.replace(/\$(\d{1,2})(?!\w)/g, (_match, index: string) => {
		const i = parseInt(index, 10);
		return argParts[i] ?? "";
	});

	return result;
}

/**
 * Full content resolution pipeline: bash injection → argument substitution.
 * Returns the final content ready for injection into an agent's system prompt.
 */
export function resolveSkillContent(
	skill: Skill,
	args?: string,
	userSkillsDir?: string,
): string {
	let content = skill.content;
	content = executeBashInjections(content);
	content = substituteArguments(content, skill.dirPath, args, userSkillsDir);
	return content;
}
