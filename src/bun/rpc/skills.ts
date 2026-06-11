import { exec } from "child_process";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { skillRegistry } from "../skills/registry";
import { getToolDefinitions } from "../agents/tools/index";
import { isFreelanceEnabled } from "../freelance/feature-flag";

function isSkillVisible(s: { hidden: boolean; feature?: string }): boolean {
	if (s.hidden) return false;
	if (s.feature === "freelance" && !isFreelanceEnabled()) return false;
	return true;
}

export function getSkills() {
	return skillRegistry.getAll().filter(isSkillVisible).map((s) => ({
		name: s.name,
		description: s.description,
		preferredAgent: s.preferredAgent ?? null,
		allowedTools: s.allowedTools,
		argumentHint: s.argumentHint ?? null,
		supportingFileCount: s.supportingFiles.length,
		errors: s.errors,
		isBundled: s.isBundled,
	}));
}

export function getSkill(name: string) {
	const skill = skillRegistry.getByName(name);
	if (!skill) return null;
	return {
		name: skill.name,
		description: skill.description,
		preferredAgent: skill.preferredAgent ?? null,
		allowedTools: skill.allowedTools,
		argumentHint: skill.argumentHint ?? null,
		content: skill.content,
		supportingFiles: skill.supportingFiles,
		dirPath: skill.dirPath,
		errors: skill.errors,
	};
}

export function refreshSkills() {
	skillRegistry.reload();
	return { count: skillRegistry.getAll().length };
}

export function getSkillsDirectory() {
	return { path: skillRegistry.dir };
}

export function openSkillsFolder() {
	const dir = skillRegistry.dir;
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const platform = process.platform;
	const cmd =
		platform === "win32" ? `explorer "${dir}"`
		: platform === "darwin" ? `open "${dir}"`
		: `xdg-open "${dir}"`;

	exec(cmd, (err) => {
		// Windows explorer.exe returns non-zero exit code even on success — ignore it
		if (err && platform !== "win32") console.error(`[skills] Failed to open folder: ${err.message}`);
	});

	return { success: true };
}

export function openSkillInEditor(name: string) {
	const skill = skillRegistry.getByName(name);
	if (!skill) return { success: false, error: `Skill "${name}" not found` };

	const skillMdPath = join(skill.dirPath, "SKILL.md");

	// Open in OS default editor
	const platform = process.platform;
	const cmd =
		platform === "win32" ? `start "" "${skillMdPath}"`
		: platform === "darwin" ? `open "${skillMdPath}"`
		: `xdg-open "${skillMdPath}"`;

	exec(cmd, (err) => {
		if (err && platform !== "win32") console.error(`[skills] Failed to open editor: ${err.message}`);
	});

	return { success: true };
}

export function deleteSkill(name: string) {
	return skillRegistry.deleteSkill(name);
}

export function getAvailableTools() {
	return getToolDefinitions();
}
