import { db } from "../db";
import { projects, deployEnvironments, deployHistory } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { eventBus } from "../scheduler";
import { logAudit } from "../db/audit";
import { runGit } from "../lib/git-runner";

// Hard cap on a single deploy so a hung command never leaves a row stuck on "running".
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function getEnvironments(projectId: string) {
  return db.select().from(deployEnvironments).where(eq(deployEnvironments.projectId, projectId));
}

export async function saveEnvironment(params: {
  projectId: string;
  id?: string;
  name: string;
  branch?: string;
  command: string;
  url?: string;
}) {
  if (params.id) {
    await db.update(deployEnvironments)
      .set({
        name: params.name,
        branch: params.branch ?? null,
        command: params.command,
        url: params.url ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(deployEnvironments.id, params.id));
    return { id: params.id };
  }
  const result = await db.insert(deployEnvironments).values({
    projectId: params.projectId,
    name: params.name,
    branch: params.branch ?? null,
    command: params.command,
    url: params.url ?? null,
  }).returning({ id: deployEnvironments.id });
  return { id: result[0].id };
}

export async function deleteEnvironment(id: string) {
  await db.delete(deployEnvironments).where(eq(deployEnvironments.id, id));
  return { success: true };
}

export async function getDeployHistory(environmentId: string, limit = 20) {
  return db.select()
    .from(deployHistory)
    .where(eq(deployHistory.environmentId, environmentId))
    .orderBy(desc(deployHistory.createdAt))
    .limit(limit);
}

export async function executeDeploy(environmentId: string) {
  const rows = await db.select()
    .from(deployEnvironments)
    .where(eq(deployEnvironments.id, environmentId))
    .limit(1);

  if (rows.length === 0) {
    return { success: false, error: "Environment not found" };
  }

  const env = rows[0];

  const projectRows = await db.select({ workspacePath: projects.workspacePath })
    .from(projects)
    .where(eq(projects.id, env.projectId))
    .limit(1);

  if (projectRows.length === 0) {
    return { success: false, error: "Project not found" };
  }

  const workspacePath = projectRows[0].workspacePath;

  const historyResult = await db.insert(deployHistory).values({
    environmentId,
    status: "running",
    triggeredBy: "human",
  }).returning({ id: deployHistory.id });
  const historyId = historyResult[0].id;

  const startTime = Date.now();

  // Record a failure + emit the completion event, then return.
  const fail = async (message: string) => {
    const durationMs = Date.now() - startTime;
    await db.update(deployHistory)
      .set({ status: "failed", logOutput: message, durationMs })
      .where(eq(deployHistory.id, historyId));
    eventBus.emit({ type: "deploy:completed", projectId: env.projectId, environmentId, status: "error" });
    return { success: false as const, error: message, historyId, durationMs };
  };

  try {
    // 1. Honor the configured branch: check it out first. This fails loudly if the
    //    working tree is dirty, so we never deploy an unexpected branch/state.
    if (env.branch && env.branch.trim()) {
      const branch = env.branch.trim();
      const current = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath);
      if (current.exitCode !== 0) {
        return await fail(`Not a git repository (or git is unavailable), so branch "${branch}" can't be checked out:\n${current.stderr}`);
      }
      if (current.stdout !== branch) {
        const co = await runGit(["checkout", branch], workspacePath);
        if (co.exitCode !== 0) {
          return await fail(`Could not switch to branch "${branch}" before deploying:\n${co.stderr || co.stdout}\n\nCommit or stash your changes, then retry.`);
        }
      }
    }

    // 2. Run the deploy command through a shell so &&, pipes, quotes, env-vars, and
    //    Windows .cmd shims (npm/vercel/etc.) all work — not a naive space-split.
    const shellArgs = process.platform === "win32"
      ? ["cmd", "/c", env.command]
      : ["bash", "-lc", env.command];
    const proc = Bun.spawn(shellArgs, {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
    });

    // 3. Timeout guard — kill a hung deploy so the row never sticks on "running".
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* already exited */ }
    }, DEPLOY_TIMEOUT_MS);

    let stdout = "", stderr = "", exitCode = 1;
    try {
      const res = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      stdout = res[0]; stderr = res[1]; exitCode = res[2];
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      return await fail(`Deploy timed out after ${Math.round(DEPLOY_TIMEOUT_MS / 60000)} minutes and was aborted.\n\n$ ${env.command}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`);
    }

    const durationMs = Date.now() - startTime;
    const status = exitCode === 0 ? "success" : "failed";
    const logOutput = `$ ${env.command}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;

    await db.update(deployHistory)
      .set({ status, logOutput, durationMs })
      .where(eq(deployHistory.id, historyId));

    eventBus.emit({ type: "deploy:completed", projectId: env.projectId, environmentId, status: exitCode === 0 ? "success" : "error" });
    logAudit({ action: "deploy.execute", entityType: "deploy", entityId: environmentId, details: { status, durationMs } });

    return { success: exitCode === 0, historyId, durationMs };
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Mark any deploy_history rows left in "running" as failed. Deploys are tied to the
 * app's lifetime (synchronous spawn), so a "running" row at startup means the app was
 * closed/crashed mid-deploy — reconcile it so the UI never shows a perpetual spinner.
 */
export async function reconcileStuckDeploys(): Promise<void> {
  await db.update(deployHistory)
    .set({ status: "failed", logOutput: "Interrupted — the app was closed or restarted while this deploy was running." })
    .where(eq(deployHistory.status, "running"));
}