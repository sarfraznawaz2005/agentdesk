import { useState, useEffect, useCallback } from "react";
import {
	GitBranch,
	Server,
	Zap,
	Code2,
	CheckCircle2,
	AlertCircle,
	Loader2,
	RefreshCw,
	Download,
	Info,
} from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import type { DependencyId, DependencyStatus } from "../../../shared/rpc/recommendations";

// ---------------------------------------------------------------------------
// Static metadata (display only — install logic lives in the backend)
// ---------------------------------------------------------------------------

interface DepMeta {
	label: string;
	description: string;
	note?: string;
	Icon: React.ComponentType<{ className?: string }>;
}

const DEP_META: Record<DependencyId, DepMeta> = {
	git: {
		label: "Git",
		description: "Version control system — required for all project and branch workflows",
		Icon: GitBranch,
	},
	node: {
		label: "Node.js",
		description: "JavaScript runtime — needed for web apps, npm packages and npx tooling",
		Icon: Server,
	},
	bun: {
		label: "Bun",
		description: "Fast JS runtime, bundler and package manager — used by AgentDesk itself",
		Icon: Zap,
	},
	python: {
		label: "Python 3",
		description: "Programming language for AI / ML scripts, automation and data processing",
		Icon: Code2,
	},
};

const DEP_ORDER: DependencyId[] = ["git", "node", "bun", "python"];

// ---------------------------------------------------------------------------
// Per-card state
// ---------------------------------------------------------------------------

type CardState = "checking" | "installed" | "not-installed" | "installing";

interface CardStatus extends DependencyStatus {
	cardState: CardState;
}

function buildInitialCards(): CardStatus[] {
	return DEP_ORDER.map((id) => ({ id, installed: false, cardState: "checking" }));
}

function applyCheckResult(cards: CardStatus[], results: DependencyStatus[]): CardStatus[] {
	const map = new Map(results.map((r) => [r.id, r]));
	return cards.map((c) => {
		const r = map.get(c.id);
		if (!r) return c;
		// Don't overwrite an actively installing card
		if (c.cardState === "installing") return c;
		return { ...c, ...r, cardState: r.installed ? "installed" : "not-installed" };
	});
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecommendationsSettings() {
	const [cards, setCards] = useState<CardStatus[]>(buildInitialCards);
	const [refreshing, setRefreshing] = useState(false);

	const runCheck = useCallback(async () => {
		setRefreshing(true);
		// Reset non-installing cards to "checking" state
		setCards((prev) =>
			prev.map((c) => (c.cardState === "installing" ? c : { ...c, cardState: "checking" })),
		);
		try {
			const results = await rpc.checkDependencies();
			setCards((prev) => applyCheckResult(prev, results));
		} catch {
			toast("error", "Failed to check dependency status.");
			setCards((prev) =>
				prev.map((c) =>
					c.cardState === "checking" ? { ...c, cardState: "not-installed" } : c,
				),
			);
		} finally {
			setRefreshing(false);
		}
	}, []);

	// Initial check on mount
	useEffect(() => {
		runCheck();
	}, [runCheck]);

	// Listen for install-complete broadcasts
	useEffect(() => {
		const handler = (e: Event) => {
			const { dependencyId, installed, version } = (e as CustomEvent<{
				dependencyId: DependencyId;
				installed: boolean;
				version?: string;
			}>).detail;
			setCards((prev) =>
				prev.map((c) =>
					c.id === dependencyId
						? { ...c, installed, version, cardState: installed ? "installed" : "not-installed" }
						: c,
				),
			);
			if (installed) {
				toast("success", `${DEP_META[dependencyId]?.label ?? dependencyId} installed successfully.`);
			} else {
				toast("error", `${DEP_META[dependencyId]?.label ?? dependencyId} installation failed. Check console for details.`);
			}
		};
		window.addEventListener("agentdesk:recommendation-status-changed", handler);
		return () => window.removeEventListener("agentdesk:recommendation-status-changed", handler);
	}, []);

	const handleInstall = useCallback(async (id: DependencyId) => {
		setCards((prev) =>
			prev.map((c) => (c.id === id ? { ...c, cardState: "installing" } : c)),
		);
		try {
			await rpc.installDependency(id);
		} catch (err) {
			toast("error", err instanceof Error ? err.message : "Failed to start installation.");
			setCards((prev) =>
				prev.map((c) =>
					c.id === id ? { ...c, cardState: "not-installed" } : c,
				),
			);
		}
	}, []);

	const installedCount = cards.filter((c) => c.cardState === "installed").length;

	return (
		<div className="space-y-6 py-4">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h3 className="text-lg font-semibold text-foreground">Recommendations</h3>
					<p className="text-sm text-muted-foreground mt-1">
						System tools recommended for building and managing projects with AgentDesk.
						When you click <strong>Install</strong>, an AI agent installs the tool automatically
						using the best method for your OS.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="shrink-0"
					onClick={runCheck}
					disabled={refreshing || cards.some((c) => c.cardState === "checking")}
				>
					<RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
					Refresh
				</Button>
			</div>

			{/* Progress summary */}
			<div className="text-xs text-muted-foreground">
				{installedCount} of {DEP_ORDER.length} installed
				{cards.some((c) => c.cardState === "installing") && (
					<span className="ml-2 text-blue-500 dark:text-blue-400 flex items-center gap-1 inline-flex">
						<Loader2 className="h-3 w-3 animate-spin" />
						Installation in progress…
					</span>
				)}
			</div>

			{/* Dependency cards */}
			<div className="space-y-2">
				{cards.map((card) => {
					const meta = DEP_META[card.id];
					const { Icon } = meta;
					return (
						<DependencyCard
							key={card.id}
							card={card}
							meta={meta}
							Icon={Icon}
							onInstall={handleInstall}
						/>
					);
				})}
			</div>

			{/* Info note */}
			<div className="flex items-start gap-2 text-xs text-muted-foreground border border-border rounded-lg p-3 bg-muted/40">
				<Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
				<span>
					Installations run via an AI agent using your configured AI provider.
					The agent checks your OS, runs the appropriate install command, and verifies the result.
					Some tools (e.g. Docker on Windows) open a GUI installer that you must complete manually.
				</span>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Single dependency card
// ---------------------------------------------------------------------------

interface DependencyCardProps {
	card: CardStatus;
	meta: DepMeta;
	Icon: React.ComponentType<{ className?: string }>;
	onInstall: (id: DependencyId) => void;
}

function DependencyCard({ card, meta, Icon, onInstall }: DependencyCardProps) {
	const { cardState } = card;

	return (
		<div className="flex items-center gap-4 px-4 py-3 rounded-lg border border-border bg-card hover:bg-accent/20 transition-colors">
			{/* Icon */}
			<div className="flex-shrink-0 w-9 h-9 rounded-md bg-muted flex items-center justify-center">
				<Icon className="h-4.5 w-4.5 text-muted-foreground" />
			</div>

			{/* Name + description */}
			<div className="flex-1 min-w-0">
				<div className="font-medium text-sm text-foreground">{meta.label}</div>
				<div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{meta.description}</div>
				{meta.note && cardState === "not-installed" && (
					<div className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">{meta.note}</div>
				)}
			</div>

			{/* Status + action */}
			<div className="flex items-center gap-2 shrink-0">
				{cardState === "checking" && (
					<span className="text-xs text-muted-foreground flex items-center gap-1">
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
						Checking…
					</span>
				)}

				{cardState === "installed" && (
					<span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 rounded-full px-2.5 py-0.5">
						<CheckCircle2 className="h-3 w-3" />
						{card.version ?? "Installed"}
					</span>
				)}

				{cardState === "not-installed" && (
					<>
						<span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
							<AlertCircle className="h-3.5 w-3.5" />
							Not installed
						</span>
						<Button
							size="sm"
							variant="outline"
							className="h-7 text-xs"
							onClick={() => onInstall(card.id)}
						>
							<Download className="h-3.5 w-3.5 mr-1" />
							Install
						</Button>
					</>
				)}

				{cardState === "installing" && (
					<span className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800 rounded-full px-2.5 py-0.5">
						<Loader2 className="h-3 w-3 animate-spin" />
						Installing…
					</span>
				)}
			</div>
		</div>
	);
}
