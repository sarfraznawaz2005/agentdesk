// ---------------------------------------------------------------------------
// Auto-Earn — freelance-expert tools (factory)
//
// FX-specific tools, created per run with the job context baked in and injected
// as `extraTools` into the inline agent. Generic file/shell/git/web/skills/MCP
// tools come from the normal registry; these add the freelance-specific powers:
// send reply/bid, store + use client credentials (git clone, SFTP/FTP), download
// attachments, bootstrap the project on a won job, escalate, and drive the job
// state machine.
// ---------------------------------------------------------------------------

import { tool, generateText, type Tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { aiProviders } from "../../db/schema";
import { createProviderAdapter } from "../../providers";
import { join, isAbsolute, basename } from "node:path";
import { Session } from "electrobun/bun";
import { sqlite } from "../../db/connection";
import { getPlatform } from "../../../shared/freelance/platforms";
import { createRemoteClient, type RemoteCredentials, type RemoteProtocol } from "../../remote-sync/client";
import { createProjectFromListing } from "../project-bootstrap";
import { storeCredential, getCredential, listCredentialSummaries } from "./vault";
import { escalateToHuman, notifyJobEvent, type Severity } from "./notify";
import { setJobState, logJobAction, getJobById, saveJobFact, listJobFacts, isDeliveryApproved, type JobState, type FactCategory } from "./jobs";

const DELIVERY_GATE_MSG =
	"Delivery requires the user's approval. Call freelance_request_delivery_approval with a summary of what you'll hand over, then STOP. The user approves and you are re-run to deliver. Do not push/upload/hand over before approval.";

export interface FxToolContext {
	jobId: string;
	platform: string;
	threadId: string | null;
	listingId: string | null;
	workspacePath: string;
}

function ok(data: Record<string, unknown>): string {
	return JSON.stringify({ ok: true, ...data });
}
function err(message: string): string {
	return JSON.stringify({ ok: false, error: message });
}

function safeDest(workspacePath: string, name: string): string {
	const dest = isAbsolute(name) ? name : join(workspacePath, name);
	const root = join(workspacePath);
	if (!dest.startsWith(root)) throw new Error("Path escapes the workspace");
	return dest;
}

function authUrl(url: string, token: string | null): string {
	if (!token) return url;
	try {
		const u = new URL(url);
		if (u.protocol !== "https:") return url;
		if (/(^|\.)github\.com$/i.test(u.hostname)) {
			u.username = "x-access-token";
			u.password = token;
		} else if (/(^|\.)gitlab\.com$/i.test(u.hostname)) {
			u.username = "oauth2";
			u.password = token;
		} else {
			u.username = token;
			u.password = "";
		}
		return u.toString();
	} catch {
		return url;
	}
}

async function runGit(args: string[], cwd: string): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, errOut] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	return { code, out: (out + errOut).trim().slice(0, 4000) };
}

function credToRemote(credId: string): RemoteCredentials {
	const c = getCredential(credId);
	if (!c) throw new Error("credential not found");
	const meta = (c.meta ?? {}) as { protocol?: string; authType?: string };
	const protocol = (meta.protocol as RemoteProtocol) ?? (c.kind === "ftp" ? "ftp" : "sftp");
	const useKey = meta.authType === "key";
	return {
		protocol,
		host: c.host ?? "",
		port: c.port ?? (protocol === "ftp" || protocol === "ftps" ? 21 : 22),
		username: c.username ?? "",
		password: useKey ? undefined : c.secret,
		privateKey: useKey ? c.secret : undefined,
		rejectUnauthorized: false,
	};
}

export function buildFreelanceExpertTools(ctx: FxToolContext): Record<string, Tool> {
	const log = (action: string, detail?: string, outcome: "ok" | "error" | "info" = "ok") =>
		logJobAction(ctx.jobId, action, detail, outcome);

	const tools: Record<string, Tool> = {
		notify_human: tool({
			description:
				"Escalate to the human when you are blocked or hit something you must NOT do autonomously " +
				"(ambiguous requirements, missing/invalid credentials, payment/banking, contracts/NDAs, calls, " +
				"off-platform requests, repeated failures). Posts to the in-app inbox + desktop + channels, and " +
				"PARKS the job. Use this instead of guessing or looping.",
			inputSchema: z.object({
				reason: z.string().describe("Short reason shown to the user"),
				detail: z.string().optional().describe("Fuller explanation / what you need"),
				severity: z.enum(["info", "warn", "blocker"]).optional(),
			}),
			execute: async ({ reason, detail, severity }): Promise<string> => {
				await escalateToHuman({
					jobId: ctx.jobId,
					platform: ctx.platform,
					threadId: ctx.threadId ?? undefined,
					reason,
					detail,
					severity: (severity as Severity) ?? "warn",
				});
				return ok({ escalated: true });
			},
		}),

		freelance_request_delivery_approval: tool({
			description:
				"Request the user's approval to deliver finished work. Call this ONLY after a passing freelance_self_review and BEFORE any push/upload/hand-over. It escalates to the user and PARKS the job — then STOP. The user approves (a button in the dashboard) and you are re-run to actually deliver.",
			inputSchema: z.object({
				summary: z.string().describe("Exactly what you will deliver and how (files, repo, on-platform, etc.)"),
			}),
			execute: async ({ summary }): Promise<string> => {
				await escalateToHuman({
					jobId: ctx.jobId,
					platform: ctx.platform,
					threadId: ctx.threadId ?? undefined,
					reason: "Ready to deliver — approve",
					detail: summary,
					severity: "warn",
					park: true,
				});
				log("delivery_approval_requested", summary.slice(0, 200));
				return ok({ requested: true, note: "Escalated for delivery approval. Stop now — you'll be re-run after the user approves." });
			},
		}),

		freelance_mark_state: tool({
			description:
				"Move this job to a new lifecycle state: lead, negotiating, awarded, in_progress, delivered, " +
				"revisions, complete, or parked. Keep it accurate so the pipeline knows what to do next.",
			inputSchema: z.object({
				state: z.enum([
					"lead",
					"negotiating",
					"awarded",
					"in_progress",
					"delivered",
					"revisions",
					"complete",
					"parked",
				]),
				detail: z.string().optional(),
			}),
			execute: async ({ state, detail }): Promise<string> => {
				// Recording a delivery is itself gated — never mark delivered without approval.
				if (state === "delivered" && !isDeliveryApproved(ctx.jobId)) return err(DELIVERY_GATE_MSG);
				setJobState(ctx.jobId, state as JobState, detail);
				const job = getJobById(ctx.jobId);
				const title = job?.title || "a job";
				if (state === "awarded") await notifyJobEvent("🎉 You won a freelance job!", `${title}${detail ? `\n${detail}` : ""}`);
				if (state === "delivered") await notifyJobEvent("✅ Freelance job delivered", title);
				return ok({ state });
			},
		}),

		save_important_client_detail: tool({
			description:
				"Remember an important NON-SECRET fact about this client/job for future replies: a communication " +
				"rule, where/how the client wants to talk, a link or repo, a preference, or a requirement. These are " +
				"injected into your context on every run so you stay consistent. (Secrets like passwords/tokens/keys " +
				"go to freelance_store_credential instead — never store secrets here.)",
			inputSchema: z.object({
				category: z.enum(["rule", "contact", "access", "preference", "requirement", "other"]),
				detail: z.string().min(1),
			}),
			execute: async ({ category, detail }): Promise<string> => {
				const id = saveJobFact(ctx.jobId, category as FactCategory, detail);
				return ok({ factId: id });
			},
		}),

		list_important_client_details: tool({
			description: "List the important client/job facts you have remembered for this job.",
			inputSchema: z.object({}),
			execute: async (): Promise<string> => ok({ facts: listJobFacts(ctx.jobId) }),
		}),

		freelance_store_credential: tool({
			description:
				"Securely store client-provided access (FTP/SFTP/git token/CMS login) in the encrypted vault. " +
				"The secret is encrypted at rest and never echoed back. Returns a credentialId to use with " +
				"git_clone / remote_* tools. Extract host/user/secret from the client's message and store them here.",
			inputSchema: z.object({
				kind: z.enum(["ftp", "sftp", "git", "cms", "other"]),
				secret: z.string().describe("Password, token, or private key — encrypted before storage"),
				label: z.string().optional(),
				host: z.string().optional(),
				port: z.number().int().optional(),
				username: z.string().optional(),
				meta: z.record(z.unknown()).optional().describe("e.g. { protocol, authType:'key', repoUrl, path }"),
			}),
			execute: async (a): Promise<string> => {
				const id = storeCredential({
					jobId: ctx.jobId,
					kind: a.kind,
					label: a.label,
					host: a.host,
					port: a.port,
					username: a.username,
					secret: a.secret,
					meta: a.meta as Record<string, unknown> | undefined,
				});
				log("store_credential", `${a.kind}${a.host ? " @ " + a.host : ""}`);
				return ok({ credentialId: id });
			},
		}),

		freelance_list_credentials: tool({
			description: "List the (redacted) credentials stored for this job. Secrets are never returned.",
			inputSchema: z.object({}),
			execute: async (): Promise<string> => ok({ credentials: listCredentialSummaries(ctx.jobId) }),
		}),

		git_clone: tool({
			description:
				"Clone a client git repository into the workspace. Public repos need no credential; for a private " +
				"repo pass a credentialId for a stored git token. The token is used only for the clone and stripped " +
				"from the saved remote afterward.",
			inputSchema: z.object({
				url: z.string().url(),
				credentialId: z.string().optional().describe("vault id of a 'git' credential holding the token"),
				branch: z.string().optional(),
				dirName: z.string().optional().describe("destination folder name in the workspace"),
			}),
			execute: async ({ url, credentialId, branch, dirName }): Promise<string> => {
				try {
					const token = credentialId ? getCredential(credentialId)?.secret ?? null : null;
					const name = dirName || basename(url).replace(/\.git$/i, "") || "repo";
					const dest = safeDest(ctx.workspacePath, name);
					const cloneArgs = ["-c", "credential.helper=", "clone"];
					if (branch) cloneArgs.push("-b", branch);
					cloneArgs.push(authUrl(url, token), dest);
					const res = await runGit(cloneArgs, ctx.workspacePath);
					if (res.code !== 0) {
						log("clone", `${url} failed`, "error");
						return err(`clone failed: ${res.out}`);
					}
					if (token) await runGit(["-C", dest, "remote", "set-url", "origin", url], ctx.workspacePath); // strip token
					log("clone", `${url} -> ${name}`);
					return ok({ path: dest, message: res.out.slice(0, 500) });
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			},
		}),

		remote_list: tool({
			description: "List a directory on a client SFTP/FTP server using a stored credential.",
			inputSchema: z.object({ credentialId: z.string(), remoteDir: z.string().default("/") }),
			execute: async ({ credentialId, remoteDir }): Promise<string> => {
				const rc = createRemoteClient(credToRemote(credentialId));
				try {
					await rc.connect();
					const entries = await rc.list(remoteDir);
					log("remote_list", remoteDir);
					return ok({ entries });
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				} finally {
					try {
						await rc.disconnect();
					} catch {
						/* ignore */
					}
				}
			},
		}),

		remote_download: tool({
			description: "Download a file from a client SFTP/FTP server into the workspace.",
			inputSchema: z.object({ credentialId: z.string(), remotePath: z.string(), localPath: z.string() }),
			execute: async ({ credentialId, remotePath, localPath }): Promise<string> => {
				const rc = createRemoteClient(credToRemote(credentialId));
				try {
					const dest = safeDest(ctx.workspacePath, localPath);
					await rc.connect();
					await rc.downloadFile(remotePath, dest);
					log("remote_download", `${remotePath} -> ${localPath}`);
					return ok({ path: dest });
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				} finally {
					try {
						await rc.disconnect();
					} catch {
						/* ignore */
					}
				}
			},
		}),

		remote_upload: tool({
			description: "Upload a deliverable from the workspace to a client SFTP/FTP server. (Requires delivery approval.)",
			inputSchema: z.object({ credentialId: z.string(), localPath: z.string(), remotePath: z.string() }),
			execute: async ({ credentialId, localPath, remotePath }): Promise<string> => {
				if (!isDeliveryApproved(ctx.jobId)) return err(DELIVERY_GATE_MSG);
				const rc = createRemoteClient(credToRemote(credentialId));
				try {
					const src = safeDest(ctx.workspacePath, localPath);
					await rc.connect();
					await rc.ensureRemoteDir(remotePath.replace(/\/[^/]*$/, "") || "/");
					await rc.uploadFile(src, remotePath);
					log("remote_upload", `${localPath} -> ${remotePath}`);
					return ok({ remotePath });
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				} finally {
					try {
						await rc.disconnect();
					} catch {
						/* ignore */
					}
				}
			},
		}),

		freelance_download_attachment: tool({
			description:
				"Download a client message attachment (a URL captured from the platform) into the workspace, " +
				"using the logged-in session. Use for specs/assets the client shared in chat.",
			inputSchema: z.object({ url: z.string().url(), localName: z.string() }),
			execute: async ({ url, localName }): Promise<string> => {
				try {
					const domain = getPlatform(ctx.platform).cookieDomain;
					let cookieHeader = "";
					try {
						const cookies = (Session.fromPartition(`persist:freelance-${ctx.platform}`).cookies.get({ domain }) ??
							[]) as Array<{ name?: string; value?: string }>;
						cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
					} catch {
						/* no cookies */
					}
					const resp = await fetch(url, { headers: cookieHeader ? { Cookie: cookieHeader } : {} });
					if (!resp.ok) return err(`HTTP ${resp.status}`);
					const dest = safeDest(ctx.workspacePath, localName);
					await Bun.write(dest, await resp.arrayBuffer());
					log("download_attachment", localName);
					return ok({ path: dest });
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			},
		}),

		freelance_send_reply: tool({
			description:
				"Queue a reply to the client for this thread. It is sent through the human-paced governor in the " +
				"live session (not a raw API call). Keep replies concise, professional, and on-platform.",
			inputSchema: z.object({ text: z.string().min(1) }),
			execute: async ({ text }): Promise<string> => {
				if (!ctx.threadId) return err("no thread for this job");
				const id = crypto.randomUUID();
				const now = new Date().toISOString();
				sqlite
					.prepare(
						`INSERT INTO freelance_outbox (id, platform, kind, thread_id, draft_body, status, autonomy_mode, created_at, updated_at)
						 VALUES (?, ?, 'reply', ?, ?, 'draft', 'full_auto', ?, ?)`,
					)
					.run(id, ctx.platform, ctx.threadId, text, now, now);
				log("reply", text.slice(0, 120));
				return ok({ queued: true, outboxId: id });
			},
		}),

		freelance_submit_bid: tool({
			description:
				"Queue a proposal (bid) for this listing. Sent governor-paced via the live session. Vary your " +
				"wording — never reuse a template.",
			inputSchema: z.object({ proposal: z.string().min(1) }),
			execute: async ({ proposal }): Promise<string> => {
				if (!ctx.listingId) return err("no listing for this job");
				const id = crypto.randomUUID();
				const now = new Date().toISOString();
				sqlite
					.prepare(
						`INSERT INTO freelance_outbox (id, platform, kind, listing_id, draft_body, status, autonomy_mode, created_at, updated_at)
						 VALUES (?, ?, 'bid', ?, ?, 'draft', 'full_auto', ?, ?)`,
					)
					.run(id, ctx.platform, ctx.listingId, proposal, now, now);
				log("bid", proposal.slice(0, 120));
				return ok({ queued: true, outboxId: id });
			},
		}),

		freelance_self_review: tool({
			description:
				"MANDATORY before any client delivery: run an independent review/QA pass over the work. Provide a " +
				"summary of what you built and how you verified it. Returns a verdict + blocking issues. You may " +
				"ONLY deliver if it passes; otherwise fix the issues or escalate.",
			inputSchema: z.object({
				summary: z.string().min(1).describe("What was built + how it was tested/verified"),
				changedFiles: z.array(z.string()).optional(),
			}),
			execute: async ({ summary, changedFiles }): Promise<string> => {
				try {
					const row =
						(await db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).limit(1))[0] ??
						(await db.select().from(aiProviders).limit(1))[0];
					if (!row) return err("no AI provider configured for review");
					const adapter = createProviderAdapter({
						id: row.id,
						name: row.name,
						providerType: row.providerType,
						apiKey: row.apiKey,
						baseUrl: row.baseUrl ?? null,
						defaultModel: row.defaultModel ?? null,
					});
					const diff = (await runGit(["-C", ctx.workspacePath, "--no-pager", "diff", "--stat"], ctx.workspacePath)).out;
					const { text } = await generateText({
						model: adapter.createModel(row.defaultModel ?? "gpt-4o-mini"),
						system:
							"You are a strict senior reviewer doing final QA before delivering paid freelance work to a client. " +
							"Reply with a JSON object {\"pass\": boolean, \"issues\": string[]}. Fail (pass=false) if anything is " +
							"incomplete, untested, low quality, or does not meet the stated requirements. Be honest and demanding.",
						prompt: `Work summary:\n${summary}\n\nChanged files: ${(changedFiles ?? []).join(", ") || "(unknown)"}\n\ngit diff --stat:\n${diff.slice(0, 3000)}`,
						temperature: 0.2,
					});
					let verdict: { pass?: boolean; issues?: string[] } = {};
					try {
						verdict = JSON.parse(text.replace(/^[^{]*/, "").replace(/[^}]*$/, "")) as typeof verdict;
					} catch {
						verdict = { pass: false, issues: ["review output unparseable — treat as not ready"] };
					}
					log("self_review", verdict.pass ? "pass" : `fail: ${(verdict.issues ?? []).join("; ")}`, verdict.pass ? "ok" : "error");
					return ok({ pass: !!verdict.pass, issues: verdict.issues ?? [] });
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			},
		}),

		freelance_create_project: tool({
			description:
				"Bootstrap the AgentDesk project for this WON job (creates the workspace + conversation and starts " +
				"the build pipeline). Only call once the job is awarded. Idempotent.",
			inputSchema: z.object({}),
			execute: async (): Promise<string> => {
				if (!ctx.listingId) return err("no listing linked to this job");
				try {
					const wasAwarded = getJobById(ctx.jobId)?.awardedAt != null;
					const { projectId } = await createProjectFromListing(ctx.listingId);
					setJobState(ctx.jobId, "awarded");
					setJobState(ctx.jobId, "in_progress", `project ${projectId}`);
					sqlite.prepare(`UPDATE freelance_jobs SET project_id = ?, updated_at = ? WHERE id = ?`).run(projectId, new Date().toISOString(), ctx.jobId);
					log("create_project", projectId);
					if (!wasAwarded) await notifyJobEvent("🎉 You won a freelance job!", getJobById(ctx.jobId)?.title || "Project created");
					return ok({ projectId });
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			},
		}),
	};

	// Reference jobId so a stale ctx is obvious during debugging.
	void getJobById;
	return tools;
}
