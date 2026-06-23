import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, FolderOpen, ArrowUpDown, ChevronsUpDown } from "lucide-react";
import { useHeaderActions } from "@/lib/header-context";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ProjectCard } from "@/components/dashboard/project-card";
import { NewProjectModal } from "@/components/modals/new-project-modal";
import { IS_REMOTE } from "@/lib/remote-transport";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { Tip } from "@/components/ui/tooltip";
import { rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";

interface Project {
	id: string;
	name: string;
	description: string | null;
	status: string;
	workspacePath: string;
	githubUrl: string | null;
	workingBranch: string | null;
	createdAt: string;
	updatedAt: string;
	workspaceOffline?: boolean;
}

type SortKey = "name" | "updatedAt" | "createdAt" | "status";
type StatusFilter = "all" | "active" | "paused" | "completed" | "archived" | "deleted";

export function DashboardPage() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [modalOpen, setModalOpen] = useState(false);

	// Active agent counts per project (updated in real-time via agentInlineStart/Complete events)
	const [activeProjectAgents, setActiveProjectAgents] = useState<Record<string, number>>({});

	// Task stats per project
	const [taskStats, setTaskStats] = useState<Record<string, { done: number; total: number }>>({});

	// Filter, sort state
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [sortKey, setSortKey] = useState<SortKey>("updatedAt");

	// Collapse all cards — persisted in localStorage
	const [cardsCollapsed, setCardsCollapsed] = useState<boolean>(() => {
		try { return localStorage.getItem("dashboard_cards_collapsed") === "true"; } catch { return false; }
	});

	function toggleCardsCollapsed() {
		setCardsCollapsed((prev) => {
			const next = !prev;
			try { localStorage.setItem("dashboard_cards_collapsed", String(next)); } catch { /* ignore */ }
			return next;
		});
	}

	const loadProjects = useCallback(async () => {
		setLoading(true);
		setLoadError(false);
		try {
			const result = await Promise.race([
				rpc.getProjects(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Request timed out — please try again")), 20_000),
				),
			]);
			const data = result as unknown;
			setProjects(Array.isArray(data) ? (data as Project[]) : []);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Failed to load projects.";
			toast("error", message);
			setLoadError(true);
		} finally {
			setLoading(false);
		}
	}, []);

	const loadTaskStats = useCallback(async () => {
		try {
			const stats = await rpc.getProjectTaskStats();
			const map: Record<string, { done: number; total: number }> = {};
			for (const s of stats) map[s.projectId] = { done: s.done, total: s.total };
			setTaskStats(map);
		} catch { /* ignore */ }
	}, []);

	useEffect(() => {
		loadProjects();
		loadTaskStats();
	}, [loadProjects, loadTaskStats]);

	// Refresh the project list live when a project is created elsewhere — including
	// background creators with no UI round-trip (channel global-mode auto-create,
	// workspace sync) — so the new project appears without navigating away and back.
	useEffect(() => {
		const onProjectsUpdated = () => {
			loadProjects();
			loadTaskStats();
		};
		window.addEventListener("agentdesk:projects-updated", onProjectsUpdated);
		return () => window.removeEventListener("agentdesk:projects-updated", onProjectsUpdated);
	}, [loadProjects, loadTaskStats]);


	// Load initial active-agent counts and keep them up to date via events.
	// Re-fetch on agent start/complete and stream-complete (catches PM finishing
	// its summary after sub-agents are done). A 10s polling interval acts as a
	// safety net for channel-dispatched agents whose events fire before the
	// dashboard mounts, or for the PM planning/summary phases where no
	// agentInlineStart event fires.
	useEffect(() => {
		const fetchCounts = () => {
			rpc.getActiveProjectAgents().then((list) => {
				const counts: Record<string, number> = {};
				for (const { projectId, agentCount } of list) {
					counts[projectId] = agentCount;
				}
				setActiveProjectAgents(counts);
			}).catch(() => {});
		};

		fetchCounts();

		const interval = setInterval(fetchCounts, 10_000);

		window.addEventListener("agentdesk:agent-inline-start", fetchCounts);
		window.addEventListener("agentdesk:agent-inline-complete", fetchCounts);
		window.addEventListener("agentdesk:stream-complete", fetchCounts);
		return () => {
			clearInterval(interval);
			window.removeEventListener("agentdesk:agent-inline-start", fetchCounts);
			window.removeEventListener("agentdesk:agent-inline-complete", fetchCounts);
			window.removeEventListener("agentdesk:stream-complete", fetchCounts);
		};
	}, []);

	// Persist sort preference
	useEffect(() => {
		rpc.saveSetting("project_sort", sortKey, "appearance").catch(() => {});
	}, [sortKey]);

	// Load persisted sort preference
	useEffect(() => {
		rpc.getSettings("appearance").then((settings) => {
			const saved = settings as Record<string, unknown>;
			if (
				saved.project_sort &&
				typeof saved.project_sort === "string" &&
				["name", "updatedAt", "createdAt", "status"].includes(
					saved.project_sort,
				)
			) {
				setSortKey(saved.project_sort as SortKey);
			}
		}).catch(() => {});
	}, []);

	// Client-side filtering and sorting
	const filteredProjects = useMemo(() => {
		let result = [...projects];

		// "all" shows everything except deleted and archived; others filter by exact status
		result = result.filter((p) =>
			statusFilter === "all" ? p.status !== "deleted" && p.status !== "archived" :
			p.status === statusFilter,
		);

		// Sort
		result.sort((a, b) => {
			switch (sortKey) {
				case "name":
					return a.name.localeCompare(b.name);
				case "status":
					return a.status.localeCompare(b.status);
				case "createdAt":
					return (
						new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
					);
				case "updatedAt":
				default:
					return (
						new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
					);
			}
		});

		return result;
	}, [projects, statusFilter, sortKey]);

	async function handleDeleteProject(id: string) {
		try {
			await rpc.deleteProjectCascade(id);
			setProjects((prev) =>
				prev.map((p) => (p.id === id ? { ...p, status: "deleted", updatedAt: new Date().toISOString() } : p)),
			);
			toast("success", "Project deleted.");
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Failed to delete project.";
			toast("error", message);
		}
	}

	async function handlePermanentDeleteProject(id: string) {
		try {
			const result = await rpc.permanentDeleteProject(id);
			if (!result.success) {
				toast("error", result.error ?? "Failed to permanently delete project.");
				return;
			}
			setProjects((prev) => prev.filter((p) => p.id !== id));
			toast("success", "Project permanently deleted.");
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to permanently delete project.";
			toast("error", message);
		}
	}

	async function handleRestoreProject(id: string) {
		try {
			await rpc.updateProject({ id, status: "active" });
			setProjects((prev) =>
				prev.map((p) => (p.id === id ? { ...p, status: "active", updatedAt: new Date().toISOString() } : p)),
			);
			toast("success", "Project restored.");
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Failed to restore project.";
			toast("error", message);
		}
	}

	async function handleStatusChange(id: string, status: string) {
		try {
			await rpc.updateProject({ id, status });
			setProjects((prev) =>
				prev.map((p) => (p.id === id ? { ...p, status, updatedAt: new Date().toISOString() } : p)),
			);
			toast("success", `Status changed to ${status}.`);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Failed to update status.";
			toast("error", message);
		}
	}

	const hasProjects = projects.length > 0;
	const hasResults = filteredProjects.length > 0;
	const isFiltered = statusFilter !== "all";

	const projectStats = useMemo(() => {
		const counts = { active: 0, paused: 0, completed: 0, archived: 0, deleted: 0 };
		for (const p of projects) {
			if (p.status in counts) counts[p.status as keyof typeof counts]++;
		}
		return counts;
	}, [projects]);

	// Clickable status filter badges — each acts like a filter chip. `base` is the
	// resting color, `hover` darkens it on hover, `ring` highlights the selected one.
	const statusBadges: {
		value: StatusFilter;
		label: string;
		count: number;
		ariaLabel: string;
		base: string;
		hover: string;
		ring: string;
	}[] = [
		{ value: "all", label: "Total", count: projects.length, ariaLabel: "Show all projects", base: "border border-border text-muted-foreground", hover: "hover:bg-muted", ring: "ring-foreground/30" },
		{ value: "active", label: "Active", count: projectStats.active, ariaLabel: "Filter by active projects", base: "bg-green-500/10 text-green-600 dark:text-green-400", hover: "hover:bg-green-500/20", ring: "ring-green-500/50" },
		{ value: "paused", label: "Paused", count: projectStats.paused, ariaLabel: "Filter by paused projects", base: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400", hover: "hover:bg-yellow-500/20", ring: "ring-yellow-500/50" },
		{ value: "completed", label: "Completed", count: projectStats.completed, ariaLabel: "Filter by completed projects", base: "bg-blue-500/10 text-blue-600 dark:text-blue-400", hover: "hover:bg-blue-500/20", ring: "ring-blue-500/50" },
		{ value: "archived", label: "Archived", count: projectStats.archived, ariaLabel: "Filter by archived projects", base: "bg-muted text-muted-foreground", hover: "hover:bg-muted-foreground/15", ring: "ring-foreground/30" },
		{ value: "deleted", label: "Deleted", count: projectStats.deleted, ariaLabel: "Filter by deleted projects", base: "bg-red-500/10 text-red-600 dark:text-red-400", hover: "hover:bg-red-500/20", ring: "ring-red-500/50" },
	];

	useHeaderActions(
		() =>
			// Projects are created on the desktop (the workspace lives on the machine),
			// so the web app doesn't offer project creation.
			IS_REMOTE ? null : (
				<Button onClick={() => setModalOpen(true)}>
					<Plus aria-hidden="true" />
					New Project
				</Button>
			),
		[],
	);

	return (
		<div className="flex flex-1 flex-col gap-6 p-6">
			{/* Search, filter, sort bar — only shown when there are projects */}
			{!loading && hasProjects && (
				<div className="flex flex-col gap-3">
				<div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
					<div className="flex flex-wrap items-center gap-2 sm:flex-1">
						{statusBadges.map((badge) => {
							const selected = statusFilter === badge.value;
							return (
								<button
									key={badge.value}
									type="button"
									onClick={() => setStatusFilter(badge.value)}
									aria-pressed={selected}
									aria-label={badge.ariaLabel}
									className={cn(
										"cursor-pointer text-[13px] font-medium px-3 h-8 flex items-center rounded-md select-none",
										"transition-all duration-100 active:scale-95",
										"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
										badge.base,
										badge.hover,
										// "Total" (all) is the default view — don't show a selected
										// border for it; only the colored status chips get a ring.
										selected && badge.value !== "all" && `ring-2 ring-inset ${badge.ring}`,
									)}
								>
									{badge.count} {badge.label}
								</button>
							);
						})}
					</div>
					{/* Sort + collapse stay together on one row (their own line on mobile). */}
					<div className="flex items-center gap-3">
						<Select
							value={sortKey}
							onValueChange={(v) => setSortKey(v as SortKey)}
						>
							<SelectTrigger className="w-44">
								<ArrowUpDown className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
								<SelectValue placeholder="Sort by" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="updatedAt">Last updated</SelectItem>
								<SelectItem value="createdAt">Date created</SelectItem>
								<SelectItem value="name">Name</SelectItem>
								<SelectItem value="status">Status</SelectItem>
							</SelectContent>
						</Select>
						<Tip content={cardsCollapsed ? "Expand all cards" : "Collapse all cards"} side="bottom">
							<Button variant="outline" size="icon" onClick={toggleCardsCollapsed} aria-label={cardsCollapsed ? "Expand all cards" : "Collapse all cards"}>
								<ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
							</Button>
						</Tip>
					</div>
				</div>
				<div className="border-b border-border" />
				</div>
			)}

			{/* Content area */}
			{loading ? (
				<ProjectGridSkeleton />
			) : loadError ? (
				<div className="flex flex-1 items-center justify-center">
					<EmptyState
						title="Failed to load projects"
						description="The backend took too long to respond. This can happen after a slow network operation."
						action={
							<Button onClick={loadProjects}>
								Retry
							</Button>
						}
					/>
				</div>
			) : !hasProjects ? (
				<div className="flex flex-1 items-center justify-center">
					<EmptyState
						icon={<FolderOpen className="h-6 w-6" aria-hidden="true" />}
						title="No projects yet"
						description={
							IS_REMOTE
								? "Create projects in the desktop app — they'll appear here."
								: "Create your first project to get started."
						}
						action={
							IS_REMOTE ? null : (
								<Button onClick={() => setModalOpen(true)} className="btn-gradient-slide border-0 text-white">
									<Plus aria-hidden="true" />
									New Project
								</Button>
							)
						}
					/>
				</div>
			) : !hasResults && isFiltered ? (
				<div className="flex flex-1 items-center justify-center">
					<EmptyState
						title="No matching projects"
						description="Try adjusting your search or filter criteria."
						action={
							<Button
								variant="outline"
								onClick={() => setStatusFilter("all")}
							>
								Clear filters
							</Button>
						}
					/>
				</div>
			) : (
				<ul
					className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
					aria-label="Projects"
				>
					{filteredProjects.map((project) => (
						<li key={project.id} className="flex min-w-0">
							<ProjectCard project={project} onDelete={handleDeleteProject} onRestore={handleRestoreProject} onPermanentDelete={handlePermanentDeleteProject} onStatusChange={handleStatusChange} activeAgentCount={activeProjectAgents[project.id] ?? 0} taskStats={taskStats[project.id]} collapsed={cardsCollapsed} workspaceOffline={project.workspaceOffline} />
						</li>
					))}
				</ul>
			)}

			{/* New project modal */}
			<NewProjectModal
				open={modalOpen}
				onOpenChange={setModalOpen}
				onCreated={loadProjects}
			/>

		</div>
	);
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------

function ProjectGridSkeleton() {
	return (
		<ul
			className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
			aria-label="Loading projects"
			aria-busy="true"
		>
			{Array.from({ length: 6 }).map((_, i) => (
				<li
					key={i}
					className="h-40 animate-pulse rounded-xl border bg-muted"
					aria-hidden="true"
				/>
			))}
		</ul>
	);
}
