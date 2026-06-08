// ---------------------------------------------------------------------------
// Auto-Earn — reusable project bootstrap
//
// Extracted from approveListing so BOTH the manual Approve button (RPC) and the
// autonomous freelance-expert (won-job trigger) create the AgentDesk project the
// same way: workspace dir + project row + conversation + kick off the PM/build
// pipeline. Idempotent on the listing.
// ---------------------------------------------------------------------------

import { eq, and, count } from "drizzle-orm";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { db } from "../db";
import { sqlite } from "../db/connection";
import { freelanceListings, settings } from "../db/schema";
import { formatBudget } from "./budget";
import { FREELANCE_EVENTS } from "./events";
import { getOrCreateEngine, broadcastToWebview } from "../engine-manager";

export interface BootstrapResult {
	projectId: string;
	conversationId: string;
}

/**
 * Create an AgentDesk project from a freelance listing and start the PM so it
 * plans + builds the work. Idempotent: an already-approved listing returns its
 * existing project. `autoplan=false` skips the PM kickoff (caller drives it).
 */
export async function createProjectFromListing(
	listingId: string,
	opts: { autoplan?: boolean } = {},
): Promise<BootstrapResult> {
	const listingRows = await db.select().from(freelanceListings).where(eq(freelanceListings.id, listingId)).limit(1);
	if (!listingRows[0]) throw new Error(`Listing ${listingId} not found`);
	const listing = listingRows[0];

	// Idempotent — already approved with a project.
	if (listing.status === "approved" && listing.projectId) {
		const convo = sqlite
			.prepare(`SELECT id FROM conversations WHERE project_id = ? ORDER BY created_at ASC LIMIT 1`)
			.get(listing.projectId) as { id: string } | undefined;
		return { projectId: listing.projectId, conversationId: convo?.id ?? "" };
	}
	if (listing.status === "closed") {
		throw new Error("Cannot create a project from a closed listing.");
	}

	// Resolve global workspace path.
	const gwpRows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "global_workspace_path")).limit(1);
	let globalWorkspace = "";
	if (gwpRows[0]) {
		try {
			globalWorkspace = JSON.parse(gwpRows[0].value) as string;
		} catch {
			globalWorkspace = gwpRows[0].value;
		}
	}

	const slug = listing.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
	const workspacePath = globalWorkspace ? join(globalWorkspace, slug) : slug;
	try {
		mkdirSync(workspacePath, { recursive: true });
	} catch {
		/* may exist */
	}

	const projectId = crypto.randomUUID();
	const conversationId = crypto.randomUUID();
	const now = new Date().toISOString();

	sqlite.transaction(() => {
		sqlite
			.prepare(
				"INSERT INTO projects (id, name, description, workspace_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
			)
			.run(projectId, listing.title, listing.description ?? null, workspacePath, now, now);
		sqlite
			.prepare("UPDATE freelance_listings SET status = 'approved', project_id = ?, updated_at = ? WHERE id = ?")
			.run(projectId, now, listingId);
		sqlite
			.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
			.run(conversationId, projectId, listing.title, now, now);
	})();

	if (opts.autoplan !== false) {
		const skills: string[] = (() => {
			try {
				return JSON.parse(listing.skills) as string[];
			} catch {
				return [];
			}
		})();
		const platformName = listing.platform === "upwork" ? "Upwork" : "Freelancer.com";
		const budgetStr = formatBudget(listing.budgetMin, listing.budgetMax, listing.budgetType, listing.currency);
		const initialMessage = `You have been assigned a new freelance project fetched from ${platformName}.

**Project:** ${listing.title}
**Budget:** ${budgetStr}
**Skills Required:** ${skills.length > 0 ? skills.join(", ") : "Not specified"}
**Platform URL:** ${listing.url}

**Project Description:**
${listing.fullDescription || listing.description}

Please create a plan for delivering this project. Use the task planner to define all tasks needed to complete this work.`;
		try {
			const engine = getOrCreateEngine(projectId);
			await engine.sendMessage(conversationId, initialMessage);
		} catch (err) {
			console.error("[freelance] PM kickoff failed (project created, can trigger manually):", err);
		}
	}

	const [{ count: newCount }] = await db
		.select({ count: count() })
		.from(freelanceListings)
		.where(and(eq(freelanceListings.status, "new"), eq(freelanceListings.isDeleted, 0)));
	broadcastToWebview(FREELANCE_EVENTS.LISTINGS_UPDATED, { count: newCount });

	return { projectId, conversationId };
}
