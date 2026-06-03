import { useState, useEffect } from "react";
import { Outlet, useNavigate, useLocation, useParams } from "@tanstack/react-router";
import { Sidebar } from "./sidebar";
import { TopNav } from "./topnav";
import { ProjectBranchBadge } from "./project-branch-badge";
import { Toaster, toast } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandPalette } from "../command-palette";
import { rpc } from "@/lib/rpc";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ConnectionStatus } from "@/components/ui/connection-status";
import { StartupHealthDialog } from "../modals/startup-health-dialog";
import { UserQuestionDialog } from "../modals/user-question-dialog";
import { PmChatWidget } from "@/components/dashboard/pm-chat-widget";
import { CustomAgentChatLauncher } from "@/components/dashboard/custom-agent-chat-launcher";
import { HeaderProvider, useHeaderContext } from "@/lib/header-context";
import { ProjectSwitcher } from "./project-switcher";
// Side-effect import: attaches the Issue Fixer live-run listeners at app startup so runs
// stream into the store regardless of which tab/page is open (matches the chat store).
import "@/stores/issue-fixer-store";
// Side-effect import: loads + listens for per-project unread agent-activity so the
// dashboard cards and project tabs show unread dots regardless of the current page.
import "@/stores/unread-store";

const DASHBOARD_PHRASES = [
  "What are we building today?",
  "Every great product starts with a single commit.",
  "Ship something amazing.",
  "Your next big idea is one project away.",
  "Code it. Ship it. Own it.",
  "Great software is built one task at a time.",
  "Turn your ideas into reality.",
  "The best time to start is now.",
  "Something remarkable is waiting to be built.",
  "Make it real today.",
  "Your team of agents is ready. Are you?",
  "Build things worth using.",
  "Dream it. Plan it. Ship it.",
  "Progress is just one task away.",
  "What will you create today?",
  "Build something the world hasn't seen yet.",
  "Good ideas deserve great execution.",
  "Let's build something extraordinary.",
  "The next version of great is yours to write.",
  "Start small, ship often, grow fast.",
  "Your codebase is waiting for its next chapter.",
  "Momentum starts with a single task.",
  "Create boldly.",
  "Every feature you ship moves you forward.",
  "Make today's commit count.",
  "Your agents work while you think big.",
  "The gap between idea and shipped is smaller than ever.",
  "You're one conversation away from a breakthrough.",
  "Every problem you solve today unblocks tomorrow.",
  "Greatness ships in small increments.",
  "The best products are built by people who care. That's you.",
  "Your ideas have never had a better team behind them.",
  "Done beats perfect. Ship it.",
  "You brought the vision. The agents bring the hours.",
  "Today's task is tomorrow's foundation.",
  "Build with confidence — your agents have your back.",
  "The world needs what you're building.",
  "Focus on the mission. Let the agents handle the execution.",
  "Every commit is proof you're moving forward.",
  "You don't need more time. You need the right tools. You have them.",
  "One great feature can change everything.",
  "You're not just writing code — you're creating leverage.",
  "The best version of your product is one sprint away.",
  "Clarity + execution = momentum. You have both.",
  "Your future users are waiting. Don't keep them.",
  "Small wins compound into massive products.",
  "Shipping is a skill. You're getting better every day.",
  "The hardest part is starting. You already did.",
  "Agents are your employees, your team, make them work for you.",
];

/** Maps top-level route segments to human-readable page titles. */
const PAGE_TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/inbox": "Inbox",
  "/agents": "Agents",
  "/skills": "Skills",
  "/prompts": "Prompts",
  "/scheduler": "Scheduler",
  "/analytics": "Analytics",
  "/council": "Council",
  "/freelance": "Freelance",
  "/playground": "Playground",
  "/settings": "Settings",
  "/plugins": "Plugins",
  "/plugin/db-viewer": "Database Viewer",
};

export function AppShell() {
  return (
    <HeaderProvider>
      <AppShellContent />
    </HeaderProvider>
  );
}

function AppShellContent() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [checkingFirstLaunch, setCheckingFirstLaunch] = useState(true);
  const [pageTitle, setPageTitle] = useState("AgentDesk");
  const [projectWorkspacePath, setProjectWorkspacePath] = useState<string | null>(null);
  const [dataPath, setDataPath] = useState<string | null>(null);
  const [headerPhrase, setHeaderPhrase] = useState<string | null>(null);
  const { headerActions } = useHeaderContext();
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId } = useParams({ strict: false }) as { projectId?: string };

  // Resolve the app's data directory once — it never changes during a session.
  // Used by the Settings page header to open the data folder in the explorer.
  useEffect(() => {
    rpc.getDataPath().then((r) => setDataPath(r.path)).catch(() => {});
  }, []);

  // Load sidebar default state from appearance settings
  useEffect(() => {
    rpc.getSettings("appearance").then((s) => {
      const raw = (s as Record<string, unknown>)["sidebar_default"];
      if (raw === "collapsed") setSidebarCollapsed(true);
      else if (raw === "expanded") setSidebarCollapsed(false);
    }).catch(() => {});

    const handler = (e: Event) => {
      const { sidebarDefault } = (e as CustomEvent<{ sidebarDefault: string }>).detail;
      if (sidebarDefault === "collapsed") setSidebarCollapsed(true);
      else if (sidebarDefault === "expanded") setSidebarCollapsed(false);
    };
    window.addEventListener("agentdesk:sidebar-default-changed", handler);
    return () => window.removeEventListener("agentdesk:sidebar-default-changed", handler);
  }, []);

  // Update the top-nav title + workspace path when navigating between pages/projects
  useEffect(() => {
    let ignore = false;

    if (!projectId) {
      // Check full path first (e.g. "/plugin/db-viewer"), then fall back to
      // the top-level segment (e.g. "/settings/providers" → "Settings")
      const segment = `/${location.pathname.split("/").filter(Boolean)[0] ?? ""}`;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPageTitle(PAGE_TITLES[location.pathname] ?? PAGE_TITLES[segment] ?? "AgentDesk");

      if (location.pathname === "/") {
        // Pick a random encouraging phrase for the dashboard header (if enabled in settings)
        rpc.getSetting("dashboard_quotes", "appearance").then((val) => {
          if (ignore) return;
          // null = never saved → use default (true). Boolean false or string "false" = disabled.
          // NOTE: getSetting's typed return is string|null but at runtime it JSON-parses
          // and can return a boolean. Cast to unknown so both forms are checkable.
          const v = val as unknown;
          const enabled = v === null || (v !== false && v !== "false");
          setHeaderPhrase(enabled ? DASHBOARD_PHRASES[Math.floor(Math.random() * DASHBOARD_PHRASES.length)] : null);
        }).catch(() => {
          setHeaderPhrase(DASHBOARD_PHRASES[Math.floor(Math.random() * DASHBOARD_PHRASES.length)]);
        });
        // Show global workspace path folder icon on the Dashboard
        rpc.getSetting("global_workspace_path", "general").then((result) => {
          if (ignore) return;
          let path: string | null = null;
          if (result) {
            try {
              const parsed = JSON.parse(result as string);
              path = typeof parsed === "string" && parsed ? parsed : null;
            } catch {
              path = typeof result === "string" && result ? (result as string) : null;
            }
          }
          setProjectWorkspacePath(path);
        }).catch(() => {});
      } else if (location.pathname === "/playground") {
        // Show a folder icon that opens the playground temp folder (like the Dashboard workspace icon).
        setHeaderPhrase(null);
        rpc.getPlaygroundState().then((st) => {
          if (!ignore) setProjectWorkspacePath(st.path);
        }).catch(() => {});
      } else {
        setHeaderPhrase(null);
        setProjectWorkspacePath(null);
      }

      return () => { ignore = true; };
    }

    rpc.getProject(projectId).then((p) => {
      if (ignore) return; // navigated away before this resolved — discard stale result
      const project = p as { name?: string; workspacePath?: string } | null;
      setPageTitle(project?.name ?? "AgentDesk");
      setProjectWorkspacePath(project?.workspacePath ?? null);
    }).catch(() => {});

    return () => { ignore = true; };
  }, [projectId, location.pathname]);

  // Redirect to onboarding if no providers exist (first launch or after reset)
  useEffect(() => {
    if (location.pathname === "/onboarding") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCheckingFirstLaunch(false);
      return;
    }
    rpc.isFirstLaunch().then((isFirst) => {
      if (isFirst) {
        navigate({ to: "/onboarding" });
      }
      setCheckingFirstLaunch(false);
    }).catch(() => {
      setCheckingFirstLaunch(false);
    });
  }, [location.pathname, navigate]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { type, message } = (e as CustomEvent<{ type: "success" | "error" | "warning" | "info"; message: string }>).detail;
      toast(type, message);
    };
    window.addEventListener("agentdesk:show-toast", handler);
    return () => window.removeEventListener("agentdesk:show-toast", handler);
  }, []);

  // Check for updates silently after the app has fully loaded.
  // Delayed 5 s so it never competes with startup work.
  // Only fires once per session (empty dep array).
  useEffect(() => {
    const timer = setTimeout(() => {
      rpc.checkForUpdate().catch(() => {}); // ignore network errors — update check is best-effort
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  // Track window focus so the backend can skip desktop notifications when the app is in focus
  useEffect(() => {
    const onFocus = () => rpc.setAppFocused(true).catch(() => {});
    const onBlur = () => rpc.setAppFocused(false).catch(() => {});
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // On the onboarding route, render just the page without shell chrome
  if (location.pathname === "/onboarding") {
    return (
      <>
        <Outlet />
        <Toaster />
      </>
    );
  }

  if (checkingFirstLaunch) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <TooltipProvider>
    <div className="relative flex h-screen bg-background text-foreground overflow-hidden">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => {
          setSidebarCollapsed((prev) => {
            const next = !prev;
            rpc.saveSetting("sidebar_default", next ? "collapsed" : "expanded", "appearance").catch(() => {});
            return next;
          });
        }}
      />
      <main className="flex-1 flex flex-col min-w-0">
        <ConnectionStatus />
        <TopNav
          title={pageTitle}
          workspacePath={projectWorkspacePath ?? undefined}
          dataPath={location.pathname.split("/").filter(Boolean)[0] === "settings" ? dataPath ?? undefined : undefined}
          phrase={headerPhrase ?? undefined}
          afterTitle={projectId ? <ProjectBranchBadge projectId={projectId} /> : undefined}
        >
          {headerActions}
          {projectId && <ProjectSwitcher currentProjectId={projectId} />}
        </TopNav>
        <div id="main-scroll-container" className="flex-1 overflow-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
      <Toaster />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />

      <StartupHealthDialog />
      <UserQuestionDialog />
      {/* Chat widget bar — buttons wrap into new rows (growing upward) when
          there are too many to fit. maxWidth is capped to the main content
          area width so buttons never slide over the sidebar. */}
      <div
        className="fixed bottom-6 right-6 z-50 flex flex-wrap-reverse justify-end items-end gap-3"
        style={{ maxWidth: `calc(100vw - ${sidebarCollapsed ? 60 : 200}px - 24px)` }}
      >
        <CustomAgentChatLauncher visible={location.pathname === "/"} />
        <PmChatWidget visible={location.pathname === "/"} />
      </div>
    </div>
    </TooltipProvider>
  );
}
