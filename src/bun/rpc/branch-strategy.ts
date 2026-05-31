import { db } from "../db";
import { branchStrategies } from "../db/schema";
import { eq } from "drizzle-orm";
import * as gitRpc from "./git";

// ── Branch Strategy CRUD ──────────────────────────────────────────────────────

export async function getBranchStrategy(projectId: string) {
	const rows = await db
		.select()
		.from(branchStrategies)
		.where(eq(branchStrategies.projectId, projectId))
		.limit(1);
	const r = rows[0];
	if (!r) return null;
	return {
		id: r.id,
		projectId: r.projectId,
		model: r.model,
		defaultBranch: r.defaultBranch,
		featureBranchPrefix: r.featureBranchPrefix,
		releaseBranchPrefix: r.releaseBranchPrefix,
		hotfixBranchPrefix: r.hotfixBranchPrefix,
		namingTemplate: r.namingTemplate,
		protectedBranches: JSON.parse(r.protectedBranches) as string[],
		autoCleanup: r.autoCleanup === 1,
	};
}

export async function saveBranchStrategy(params: {
	projectId: string;
	model?: string;
	defaultBranch?: string;
	featureBranchPrefix?: string;
	releaseBranchPrefix?: string;
	hotfixBranchPrefix?: string;
	namingTemplate?: string;
	protectedBranches?: string[];
	autoCleanup?: boolean;
}) {
	const existing = await db
		.select({ id: branchStrategies.id })
		.from(branchStrategies)
		.where(eq(branchStrategies.projectId, params.projectId))
		.limit(1);

	const data = {
		model: params.model,
		defaultBranch: params.defaultBranch,
		featureBranchPrefix: params.featureBranchPrefix,
		releaseBranchPrefix: params.releaseBranchPrefix,
		hotfixBranchPrefix: params.hotfixBranchPrefix,
		namingTemplate: params.namingTemplate,
		protectedBranches: params.protectedBranches
			? JSON.stringify(params.protectedBranches)
			: undefined,
		autoCleanup: params.autoCleanup !== undefined ? (params.autoCleanup ? 1 : 0) : undefined,
		updatedAt: new Date().toISOString(),
	};

	// Remove undefined values
	const cleanData = Object.fromEntries(
		Object.entries(data).filter(([, v]) => v !== undefined),
	) as Partial<typeof branchStrategies.$inferInsert>;

	if (existing.length > 0) {
		await db
			.update(branchStrategies)
			.set(cleanData)
			.where(eq(branchStrategies.projectId, params.projectId));
	} else {
		await db.insert(branchStrategies).values({
			id: crypto.randomUUID(),
			projectId: params.projectId,
			model: params.model ?? "github-flow",
			defaultBranch: params.defaultBranch ?? "main",
			featureBranchPrefix: params.featureBranchPrefix ?? "feature/",
			releaseBranchPrefix: params.releaseBranchPrefix ?? "release/",
			hotfixBranchPrefix: params.hotfixBranchPrefix ?? "hotfix/",
			namingTemplate: params.namingTemplate ?? "feature/{task-id}-{slug}",
			protectedBranches: JSON.stringify(params.protectedBranches ?? ["main", "master"]),
			autoCleanup: params.autoCleanup ? 1 : 0,
		});
	}
	return { success: true };
}

// ── Auto-create feature branch for task ───────────────────────────────────────

export async function createFeatureBranch(
	projectId: string,
	taskId: string,
	taskTitle: string,
): Promise<{ success: boolean; branchName?: string; error?: string }> {
	const strategy = await getBranchStrategy(projectId);
	const template = strategy?.namingTemplate ?? "feature/{task-id}-{slug}";
	const prefix = strategy?.featureBranchPrefix ?? "feature/";

	// Build slug from task title
	const slug = taskTitle
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.slice(0, 40);

	const shortId = taskId.slice(0, 8);
	const branchName = template
		.replace("{task-id}", shortId)
		.replace("{slug}", slug)
		.replace("{prefix}", prefix);

	const result = await gitRpc.gitCreateBranch(projectId, branchName);
	if (!result.success) {
		return { success: false, error: result.error };
	}
	return { success: true, branchName };
}

// ── Proxy cleanup methods ─────────────────────────────────────────────────────

export async function getMergedBranches(projectId: string) {
	return gitRpc.getMergedBranches(projectId);
}

export async function cleanupMergedBranches(projectId: string) {
	return gitRpc.cleanupMergedBranches(projectId);
}
