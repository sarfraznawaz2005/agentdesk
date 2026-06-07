import { db } from "../db";
import { aiProviders } from "../db/schema";
import { eq } from "drizzle-orm";
import { broadcastToWebview } from "../engine-manager";
import { runInlineAgent } from "../agents/agent-loop";
import { autoApprovedShellTool } from "../agents/tools/shell";
import { getDefaultModel } from "../providers/models";
import type { ProviderConfig } from "../providers/types";
import type { DependencyId, DependencyStatus } from "../../shared/rpc/recommendations";

// ---------------------------------------------------------------------------
// Dependency definitions
// ---------------------------------------------------------------------------

interface DepInfo {
	name: string;
	description: string;
	verifyCmd: string;
	checkCommands: [string, string[]][];
	installCommands: { windows: string; mac: string; linux: string };
}

const DEPENDENCIES: Record<DependencyId, DepInfo> = {
	git: {
		name: "Git",
		description: "Version control — required for all project and branch workflows",
		verifyCmd: "git --version",
		checkCommands: [["git", ["--version"]]],
		installCommands: {
			windows: "winget install --id Git.Git -e --source winget",
			mac: "brew install git",
			linux: `# Debian / Ubuntu:
sudo apt-get update && sudo apt-get install -y git
# RHEL / CentOS / Fedora:
# sudo yum install -y git   OR   sudo dnf install -y git
# Arch Linux:
# sudo pacman -S git`,
		},
	},
	node: {
		name: "Node.js",
		description: "JavaScript runtime — needed for web apps, npm, and npx tooling",
		verifyCmd: "node --version && npm --version",
		checkCommands: [["node", ["--version"]]],
		installCommands: {
			windows: "winget install OpenJS.NodeJS.LTS",
			mac: "brew install node",
			linux: `# NodeSource LTS (Debian / Ubuntu):
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs
# RHEL / Fedora:
# curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - && sudo yum install -y nodejs`,
		},
	},
	bun: {
		name: "Bun",
		description: "Fast JS runtime, bundler and package manager — the runtime AgentDesk itself uses",
		verifyCmd: "bun --version",
		checkCommands: [["bun", ["--version"]]],
		installCommands: {
			windows: `powershell -c "irm bun.sh/install.ps1 | iex"`,
			mac: "curl -fsSL https://bun.sh/install | bash",
			linux: "curl -fsSL https://bun.sh/install | bash",
		},
	},
	python: {
		name: "Python 3",
		description: "Programming language for AI / ML scripts, automation and data processing",
		verifyCmd: "python3 --version",
		checkCommands: [
			["python3", ["--version"]],
			["python",  ["--version"]],
			["py",      ["--version"]], // Windows Python Launcher
		],
		installCommands: {
			windows: "winget install Python.Python.3",
			mac: "brew install python3",
			linux: "sudo apt-get update && sudo apt-get install -y python3 python3-pip",
		},
	},
};

// ---------------------------------------------------------------------------
// Version checks
// ---------------------------------------------------------------------------

async function tryGetVersion(cmd: string, args: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		return proc.exitCode === 0 && text.trim()
			? text.trim().split("\n")[0].trim()
			: null;
	} catch {
		return null;
	}
}

async function checkDependency(id: DependencyId): Promise<DependencyStatus> {
	const dep = DEPENDENCIES[id];
	for (const [cmd, args] of dep.checkCommands) {
		const version = await tryGetVersion(cmd, args);
		if (version) {
			// For python: only accept Python 3.x
			if (id === "python" && !version.includes("3.")) continue;
			return { id, installed: true, version };
		}
	}
	return { id, installed: false };
}

export async function checkDependencies(): Promise<DependencyStatus[]> {
	return Promise.all(
		(Object.keys(DEPENDENCIES) as DependencyId[]).map(checkDependency),
	);
}

// ---------------------------------------------------------------------------
// Install agent
// ---------------------------------------------------------------------------

// Guard against duplicate concurrent install runs
const installing = new Set<DependencyId>();

function buildInstallTask(depId: DependencyId): string {
	const dep = DEPENDENCIES[depId];
	return `Install ${dep.name} on this system.

STEPS:
1. Call \`environment_info\` to determine the OS (windows / darwin / linux) and architecture.
2. Run the install command for that OS (listed below).
3. If the primary method fails, use \`web_search\` or \`web_fetch\` to find an alternative.
4. On Linux, if \`apt-get\` is unavailable, detect the package manager (yum / dnf / pacman) and adapt the command.
5. Verify the installation by running: \`${dep.verifyCmd}\`
6. Report the installed version in your final response. Be brief.

## Install commands

### Windows
\`\`\`
${dep.installCommands.windows}
\`\`\`

### macOS
\`\`\`
${dep.installCommands.mac}
\`\`\`

### Linux
\`\`\`
${dep.installCommands.linux}
\`\`\`

Focus only on this installation task. Do not modify any files.`;
}

async function resolveProviderConfig(): Promise<{ config: ProviderConfig; modelId: string }> {
	let row = db.select().from(aiProviders).where(eq(aiProviders.isDefault, 1)).get();
	if (!row) row = db.select().from(aiProviders).limit(1).get();
	if (!row) throw new Error("No AI provider configured. Add one in Settings → AI → AI Providers first.");
	const modelId = row.defaultModel ?? getDefaultModel(row.providerType);
	return {
		config: {
			id: row.id,
			name: row.name,
			providerType: row.providerType,
			apiKey: row.apiKey ?? "",
			baseUrl: row.baseUrl ?? null,
			defaultModel: row.defaultModel ?? null,
		},
		modelId,
	};
}

export async function installDependency(params: { dependencyId: DependencyId }): Promise<{ queued: boolean }> {
	const { dependencyId } = params;

	if (installing.has(dependencyId)) return { queued: true };

	const { config: providerConfig, modelId } = await resolveProviderConfig();

	installing.add(dependencyId);

	const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? undefined;

	void runInlineAgent({
		conversationId: crypto.randomUUID(),
		agentName: "devops-engineer",
		agentDisplayName: "Dependency Installer",
		task: buildInstallTask(dependencyId),
		projectContext: "Installing system dependencies from AgentDesk settings — no project context.",
		providerConfig,
		modelId,
		projectId: "__recommendations__",
		persistToDb: false,
		workspacePath: homeDir,
		extraTools: { run_shell: autoApprovedShellTool },
		excludeTools: [
			"request_human_input",
			"run_agent", "run_agents_parallel",
			"request_plan_approval", "create_tasks_from_plan",
			"define_tasks",
		],
		callbacks: {
			onPartCreated: () => {},
			onPartUpdated: () => {},
			onTextDelta: () => {},
			onAgentStart: () => {},
			onAgentComplete: (_mid, _name, _status) => {
				installing.delete(dependencyId);
				checkDependency(dependencyId)
					.then((status) => {
						broadcastToWebview("recommendationStatusChanged", {
							dependencyId,
							installed: status.installed,
							version: status.version,
						});
					})
					.catch(() => {
						broadcastToWebview("recommendationStatusChanged", {
							dependencyId,
							installed: false,
							version: undefined,
						});
					});
			},
		},
	}).catch((err: unknown) => {
		installing.delete(dependencyId);
		console.error(`[recommendations] Install agent error for ${dependencyId}:`, err);
		broadcastToWebview("recommendationStatusChanged", {
			dependencyId,
			installed: false,
			version: undefined,
		});
	});

	return { queued: true };
}
