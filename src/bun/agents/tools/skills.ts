import { join } from "path";
import { existsSync } from "fs";
import { tool } from "ai";
import { z } from "zod";
import { skillRegistry } from "../../skills/registry";
import { parseSkillFile } from "../../skills/loader";
import type { ToolRegistryEntry } from "./index";

/**
 * Extract files referenced as MANDATORY in skill content and match them
 * to full paths from the supporting files list.
 * Looks for patterns like: "MANDATORY - READ ENTIRE FILE": Read [`docx-js.md`](docx-js.md)
 */
function extractMandatoryFiles(content: string, supportingFilePaths: string[]): string[] {
	const results: string[] = [];
	// Match markdown links in lines containing "MANDATORY" (case-insensitive)
	const mandatoryLines = content.split("\n").filter((line) => /mandatory/i.test(line));
	for (const line of mandatoryLines) {
		// Extract filenames from markdown links like [docx-js.md](docx-js.md) or [`ooxml.md`](ooxml.md)
		const linkMatches = line.matchAll(/\[`?([^`\]]+)`?\]\(([^)]+)\)/g);
		for (const match of linkMatches) {
			const linkTarget = match[2]; // e.g. "docx-js.md" or "scripts/html2pptx.cjs"
			// Find matching full path from supporting files
			const fullPath = supportingFilePaths.find((fp) => fp.endsWith("/" + linkTarget) || fp.endsWith("\\" + linkTarget));
			if (fullPath) {
				results.push(fullPath);
			}
		}
	}
	return results;
}

/**
 * Skill tools available to ALL agents (PM and sub-agents).
 * Agents see a compact listing of skill names/descriptions in their system
 * prompt and use these tools to load full content on demand.
 */
export const skillTools: Record<string, ToolRegistryEntry> = {
	read_skill: {
		category: "skills",
		tool: tool({
			description:
				"Load the full instructions of a skill by exact name. " +
				"Returns the resolved SKILL.md content with all substitutions applied, " +
				"plus the skill directory path and list of supporting files (with full paths). " +
				"Use this when a skill listed in Available Skills is relevant to your current task.",
			inputSchema: z.object({
				name: z.string().describe("Exact skill name as listed in Available Skills"),
			}),
			execute: async (args) => {
				const skill = skillRegistry.getByName(args.name);
				if (!skill) {
					const available = skillRegistry.getAll().map((s) => s.name);
					return JSON.stringify({
						error: `Skill "${args.name}" not found. Available skills: ${available.join(", ") || "none"}`,
					});
				}
				const resolvedContent = skillRegistry.resolveContent(skill);
				const parts: string[] = [];
				if (skill.preferredAgent) {
					parts.push(`[ROUTING] This skill requires agent: "${skill.preferredAgent}". You MUST delegate tasks using this skill to "${skill.preferredAgent}" — do not use any other agent.`);
					parts.push("");
				}
				parts.push(resolvedContent);

				// Append skill directory and supporting files with full paths (text files only)
				const textFiles: string[] = [];
				if (skill.supportingFiles.length > 0) {
					const dirPath = skill.dirPath.replace(/\\/g, "/");
					for (const relPath of skill.supportingFiles) {
						// Skip likely binary files (schemas, images, compiled, archives)
						if (/\.(xsd|xsl|wsdl|png|jpe?g|gif|ico|svg|bmp|webp|woff2?|ttf|eot|otf|zip|tar|gz|7z|rar|exe|dll|so|dylib|pyc|class|o|a|bin|dat|db|sqlite)$/i.test(relPath)) {
							continue;
						}
						textFiles.push(join(skill.dirPath, relPath).replace(/\\/g, "/"));
					}
					if (textFiles.length > 0) {
						parts.push("");
						parts.push(`[SKILL DIRECTORY] ${dirPath}`);
						parts.push(`[SUPPORTING FILES] Use read_skill_file to read these. When the skill content above references a file (e.g. in markdown links like [docx-js.md](docx-js.md)), find the matching path below:`);
						for (const fullPath of textFiles) {
							parts.push(`  - ${fullPath}`);
						}
					}
				}

				// Extract mandatory steps and build enforcement checklist
				const mandatoryFiles = extractMandatoryFiles(resolvedContent, textFiles);
				parts.push("");
				parts.push("[MANDATORY COMPLIANCE]");
				parts.push("You MUST follow the skill instructions above exactly. This is NON-NEGOTIABLE.");
				if (mandatoryFiles.length > 0) {
					parts.push("");
					parts.push("Required reads before implementation:");
					for (const mf of mandatoryFiles) {
						parts.push(`  ☐ Read: ${mf}`);
					}
				}
				parts.push("");
				parts.push("Before completing this task, verify:");
				parts.push("  ☐ Read ALL files referenced in the instructions above (use read_skill_file)");
				parts.push("  ☐ Followed the workflow steps in the exact order specified");
				parts.push("  ☐ Used the libraries/tools specified by the skill — not alternatives");
				parts.push("  ☐ Ran validation/verification steps if specified in the instructions");
				parts.push("Skipping any step violates the skill contract. Do NOT take shortcuts.");

				return parts.join("\n");
			},
		}),
	},

	read_skill_file: {
		category: "skills",
		tool: tool({
			description:
				"Read a supporting file from a skill's directory. " +
				"Use this after read_skill to access companion documentation, scripts, or reference files " +
				"listed under [SUPPORTING FILES]. Pass the full file path as shown in the read_skill output.",
			inputSchema: z.object({
				file_path: z.string().describe("Full absolute path to the skill file (as shown in read_skill output)"),
			}),
			execute: async (args) => {
				const filePath = args.file_path;

				// Security: verify the path is inside a known skills directory
				const normalizedPath = filePath.replace(/\\/g, "/");
				const bundledDir = skillRegistry.bundledDir.replace(/\\/g, "/");
				const userDir = skillRegistry.dir.replace(/\\/g, "/");
				if (!normalizedPath.startsWith(bundledDir) && !normalizedPath.startsWith(userDir)) {
					return JSON.stringify({
						error: "Access denied. Path must be inside a skills directory.",
					});
				}

				const file = Bun.file(filePath);
				if (!(await file.exists())) {
					return JSON.stringify({ error: `File not found: ${filePath}` });
				}

				try {
					const fileSize = file.size;

					// Binary guard: check first 8KB for null bytes
					const probeSize = Math.min(8192, fileSize);
					if (probeSize > 0) {
						const slice = await file.slice(0, probeSize).arrayBuffer();
						if (new Uint8Array(slice).includes(0)) {
							return JSON.stringify({
								error: `Binary file — cannot read: ${filePath} (${fileSize} bytes). Use is_binary to inspect.`,
							});
						}
					}

					// Size guard: cap at 512KB to protect agent context
					const MAX_SIZE = 512 * 1024;
					if (fileSize > MAX_SIZE) {
						return JSON.stringify({
							error: `File too large (${(fileSize / 1024).toFixed(0)}KB). Max ${MAX_SIZE / 1024}KB. Use read_file with startLine/endLine for partial reads.`,
						});
					}

					return await file.text();
				} catch (err) {
					return JSON.stringify({
						error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			},
		}),
	},

	find_skills: {
		category: "skills",
		tool: tool({
			description:
				"Search skills ALREADY INSTALLED in AgentDesk (bundled + user skills) by keyword. " +
				"Returns matching skill names and descriptions. This does NOT search any external " +
				"catalog or ecosystem — it only covers what's on this machine right now. If it returns " +
				"nothing, that means no *installed* skill matches, not that no skill exists anywhere: " +
				"check whether an installed skill's own job is discovering/installing more skills from " +
				"outside AgentDesk before concluding the capability isn't available.",
			inputSchema: z.object({
				query: z.string().describe("Search keyword(s)"),
			}),
			execute: async (args) => {
				const matches = skillRegistry.search(args.query);
				if (matches.length === 0) {
					return JSON.stringify({
						results: [],
						message: `No installed skill matches "${args.query}". This only searched skills already installed in AgentDesk — it does not mean no skill exists. If this is a specialized/uncommon capability, check the Available Skills list for one whose job is finding and installing skills from outside AgentDesk.`,
					});
				}
				return JSON.stringify({
					results: matches.map((s) => ({
						name: s.name,
						description: s.description,
						preferredAgent: s.preferredAgent ?? null,
					})),
				});
			},
		}),
	},

	list_skills: {
		category: "skills",
		tool: tool({
			description:
				"List ALL skills currently installed in AgentDesk — both pre-built (bundled with the app) " +
				"and user-created/custom skills — with their names, descriptions, and source. Unlike " +
				"find_skills (which filters by a keyword), this returns the complete catalog. Use it when " +
				"you want the full inventory of available skills rather than a keyword search. This only " +
				"covers what's installed on this machine — it does not search any external catalog.",
			inputSchema: z.object({}),
			execute: async () => {
				const skills = skillRegistry.getAll();
				if (skills.length === 0) {
					return JSON.stringify({ results: [], message: "No skills are installed in AgentDesk." });
				}
				return JSON.stringify({
					count: skills.length,
					results: skills.map((s) => ({
						name: s.name,
						description: s.description,
						source: s.isBundled ? "bundled" : "user",
						preferredAgent: s.preferredAgent ?? null,
					})),
				});
			},
		}),
	},

	validate_skill: {
		category: "skills",
		tool: tool({
			description:
				"Validate a skill directory after creating or editing it. " +
				"Parses SKILL.md, checks frontmatter fields, naming conventions, line count, " +
				"and structure. Returns validation results with any errors. " +
				"MUST be called after creating a skill to confirm it meets standards.",
			inputSchema: z.object({
				skill_dir: z.string().describe("Absolute path to the skill directory (the folder containing SKILL.md)"),
			}),
			execute: async (args) => {
				const skillDir = args.skill_dir;
				const skillFile = join(skillDir, "SKILL.md");

				if (!existsSync(skillDir)) {
					return JSON.stringify({ valid: false, errors: [{ field: "directory", message: `Directory not found: ${skillDir}` }] });
				}
				if (!existsSync(skillFile)) {
					return JSON.stringify({ valid: false, errors: [{ field: "SKILL.md", message: "SKILL.md not found in skill directory." }] });
				}

				// Parse the skill using the same logic as the skill registry
				const skill = parseSkillFile(skillDir);
				if (!skill) {
					return JSON.stringify({ valid: false, errors: [{ field: "parse", message: "Failed to parse SKILL.md. Check YAML frontmatter syntax." }] });
				}

				const warnings: string[] = [];

				// Check line count
				const lineCount = skill.content.split("\n").length;
				if (lineCount > 500) {
					skill.errors.push({ field: "content", message: `SKILL.md body is ${lineCount} lines (max 500). Move detailed content to supporting files.` });
				}

				// Check for hardcoded absolute paths (common mistake)
				const absPathMatch = skill.content.match(/[A-Z]:[/\\][^\s`"')}\]]+/);
				if (absPathMatch) {
					skill.errors.push({ field: "content", message: `Hardcoded absolute path found: "${absPathMatch[0]}". Use \${AGENTDESK_SKILL_DIR} or \${AGENTDESK_SKILLS_USER_DIR} instead.` });
				}

				// Check for bloat files
				const BLOAT_FILES = ["package.json", "README.md", ".gitignore", ".env.example", "INSTALLATION.md"];
				for (const bloat of BLOAT_FILES) {
					if (existsSync(join(skillDir, bloat))) {
						warnings.push(`Unnecessary file "${bloat}" found. Skills should be lean — SKILL.md + optional scripts/ and references/ only.`);
					}
				}

				const result: Record<string, unknown> = {
					valid: skill.errors.length === 0,
					name: skill.name,
					description: skill.description.slice(0, 120),
					lineCount,
					preferredAgent: skill.preferredAgent ?? null,
					allowedTools: skill.allowedTools,
					supportingFiles: skill.supportingFiles,
					errors: skill.errors,
				};
				if (warnings.length > 0) result.warnings = warnings;

				return JSON.stringify(result, null, 2);
			},
		}),
	},
};
