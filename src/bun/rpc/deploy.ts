import { db } from "../db";
import { projects, deployEnvironments, deployHistory } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { eventBus } from "../scheduler";
import { logAudit } from "../db/audit";

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

  try {
    const proc = Bun.spawn(env.command.split(" "), {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    const durationMs = Date.now() - startTime;
    const status = exitCode === 0 ? "success" : "failed";
    const logOutput = `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;

    await db.update(deployHistory)
      .set({ status, logOutput, durationMs })
      .where(eq(deployHistory.id, historyId));

    eventBus.emit({ type: "deploy:completed", projectId: env.projectId, environmentId, status: exitCode === 0 ? "success" : "error" });
    logAudit({ action: "deploy.execute", entityType: "deploy", entityId: environmentId, details: { status, durationMs } });

    return { success: exitCode === 0, historyId, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);

    await db.update(deployHistory)
      .set({ status: "failed", logOutput: error, durationMs })
      .where(eq(deployHistory.id, historyId));

    eventBus.emit({ type: "deploy:completed", projectId: env.projectId, environmentId, status: "error" });

    return { success: false, error };
  }
}