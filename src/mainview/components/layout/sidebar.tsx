import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import pkg from "../../../../package.json";
import {
  LayoutDashboard,
  Bot,
  Settings,
  Puzzle,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Clock,
  BookOpen,
  Library,
  Sparkles,
  BarChart2,
  Users,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Cpu,
  Briefcase,
  FlaskConical,
  MessageSquarePlus,
  WifiOff,
  type LucideIcon,
  icons,
} from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { IS_REMOTE } from "@/lib/remote-transport";
import { useIsMobile } from "@/lib/use-is-mobile";
import { Tip } from "@/components/ui/tooltip";
import { UnreadDot } from "@/components/ui/unread-dot";
import { useUnreadStore, hasUnread } from "@/stores/unread-store";
import { useNetworkStore } from "@/stores/network-store";
import { FREELANCE_ATTENTION_PROJECT, FREELANCE_ATTENTION_LOCATION } from "../../../shared/freelance/attention";

interface NavItem {
  label: string;
  icon: LucideIcon;
  href: string;
  badge?: number;
  /** Red "needs attention" dot, independent of the numeric badge. */
  attention?: boolean;
}

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Mobile off-canvas drawer open state (TASK-487). Ignored at desktop widths. */
  mobileOpen?: boolean;
  /** Called to close the mobile drawer (backdrop tap / nav click). */
  onMobileClose?: () => void;
}

const BASE_NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/" },
  { label: "Playground", icon: FlaskConical, href: "/playground" },
  { label: "Inbox", icon: Inbox, href: "/inbox" },
  { label: "Agents", icon: Bot, href: "/agents" },
  { label: "Skills", icon: Sparkles, href: "/skills" },
  { label: "Prompts", icon: BookOpen, href: "/prompts" },
  { label: "Collections", icon: Library, href: "/collections" },
  { label: "Scheduler", icon: Clock, href: "/scheduler" },
  { label: "Council", icon: Users, href: "/council" },
  { label: "Analytics", icon: BarChart2, href: "/analytics" },
  { label: "Settings", icon: Settings, href: "/settings" },
];

function NavItemButton({
  item,
  collapsed,
  active,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
}) {
  const Icon = item.icon;

  const hasBadge = item.badge !== undefined && item.badge > 0;
  const showAttention = !!item.attention;

  const link = (
    <Link
      to={item.href}
      className={cn(
        "relative flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
        active
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300"
          : "text-muted-foreground hover:bg-foreground/[8%] hover:text-foreground"
      )}
    >
      <Icon
        className={cn("h-4 w-4 shrink-0", active ? "text-indigo-600" : "")}
        aria-hidden="true"
      />
      {/* Collapsed badge dot */}
      {collapsed && hasBadge && (
        <span
          className="absolute top-1 right-1 h-2 w-2 rounded-full bg-indigo-500"
          aria-label={`${item.badge} notifications`}
        />
      )}
      {/* Collapsed "needs attention" dot (red) — takes precedence in the corner */}
      {collapsed && showAttention && (
        <UnreadDot className="absolute -top-0.5 -right-0.5" tooltip="Freelance needs your attention" side="right" />
      )}
      {!collapsed && (
        <span className="flex-1 truncate">{item.label}</span>
      )}
      {!collapsed && showAttention && (
        <UnreadDot tooltip="Freelance needs your attention" />
      )}
      {!collapsed && hasBadge && (
        <span
          className={cn(
            "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold",
            active
              ? "bg-indigo-600 text-white"
              : "bg-muted text-muted-foreground"
          )}
          aria-label={`${item.badge} notifications`}
        >
          {(item.badge ?? 0) > 99 ? "99+" : item.badge}
        </span>
      )}
    </Link>
  );

  return collapsed ? (
    <Tip content={item.label} side="right">
      {link}
    </Tip>
  ) : link;
}

/** Resolve a Lucide icon name (e.g. "Puzzle") to a component, with a fallback. */
function resolveIcon(name: string): LucideIcon {
  return (icons as Record<string, LucideIcon>)[name] ?? Puzzle;
}

/** Opens (or focuses) the Quick Chat window — desktop-only, mirrors NavItemButton's styling. */
function QuickChatButton({ collapsed }: { collapsed: boolean }) {
  const [opening, setOpening] = useState(false);

  const handleClick = async () => {
    setOpening(true);
    try {
      const result = await rpc.openQuickChatDefault();
      if (!result.success) {
        toast("error", result.error ?? "Could not open Quick Chat.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not open Quick Chat.";
      toast("error", message);
    } finally {
      setOpening(false);
    }
  };

  const button = (
    <button
      type="button"
      onClick={handleClick}
      disabled={opening}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
        "text-muted-foreground hover:bg-foreground/[8%] hover:text-foreground disabled:opacity-50",
      )}
    >
      <MessageSquarePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!collapsed && <span className="flex-1 truncate text-left">Open Quick Chat</span>}
    </button>
  );

  return collapsed ? (
    <Tip content="Open Quick Chat" side="right">
      {button}
    </Tip>
  ) : button;
}

type UpdateState = "idle" | "checking" | "no-update" | "available" | "downloading" | "ready" | "error";

export function Sidebar({ collapsed: collapsedProp, onToggleCollapse, mobileOpen = false, onMobileClose }: SidebarProps) {
  // Derive active item from the router's current pathname (hash routing aware)
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOnline = useNetworkStore((s) => s.isOnline);
  const isMobile = useIsMobile();
  // On mobile the sidebar is an off-canvas drawer with full labels; the desktop
  // collapse preference doesn't apply there. Shadowing `collapsed` makes every
  // existing reference below use the mobile-effective value (TASK-487).
  const collapsed = isMobile ? false : collapsedProp;

  // Poll for unread inbox count every 30 seconds
  const [inboxUnread, setInboxUnread] = useState(0);
  // Plugin-contributed sidebar items
  const [pluginItems, setPluginItems] = useState<NavItem[]>([]);
  // Freelance feature flag + new listings badge
  const [freelanceEnabled, setFreelanceEnabled] = useState(false);
  const [newListingsCount, setNewListingsCount] = useState(0);
  // Freelance "needs attention" red dot — set when an escalation is raised, cleared
  // when the user opens the Auto-Earn tab (reuses the per-project unread store).
  const freelanceAttention = useUnreadStore(hasUnread(FREELANCE_ATTENTION_PROJECT, FREELANCE_ATTENTION_LOCATION));

  // ── Icon spin on navigation ──
  const [iconSpinKey, setIconSpinKey] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIconSpinKey((k) => k + 1);
  }, [pathname]);

  // ── Update state ──
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateMsg, setUpdateMsg] = useState("");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [showUpdatePanel, setShowUpdatePanel] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function fetchUnread() {
      try {
        const result = await rpc.getUnreadCount();
        const count = (result as { count: number }).count ?? 0;
        setInboxUnread(count > 0 ? count : 0);
      } catch {
        // silently ignore — badge just won't show
      }
    }

    fetchUnread();
    const intervalId = setInterval(fetchUnread, 30_000);

    // Also refresh on real-time inbox events — new messages arriving, and
    // messages being marked read (opened, mark-all-read, bulk mark-read) —
    // so the badge doesn't wait for the next 30s poll to catch up.
    const handler = () => fetchUnread();
    window.addEventListener("agentdesk:inbox-message-received", handler);
    window.addEventListener("agentdesk:inbox-unread-changed", handler);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener("agentdesk:inbox-message-received", handler);
      window.removeEventListener("agentdesk:inbox-unread-changed", handler);
    };
  }, []);

  // Fetch plugin sidebar extensions and refresh on plugin toggle
  useEffect(() => {
    function fetchExtensions() {
      rpc.getPluginExtensions().then((ext) => {
        setPluginItems(
          ext.sidebarItems.map((si) => ({
            label: si.label,
            icon: resolveIcon(si.icon),
            href: si.href,
          })),
        );
      }).catch(() => {});
    }

    fetchExtensions();
    window.addEventListener("agentdesk:plugins-changed", fetchExtensions);
    return () => window.removeEventListener("agentdesk:plugins-changed", fetchExtensions);
  }, []);

  // Check freelance feature flag on mount and load initial new-listings count
  useEffect(() => {
    rpc.freelanceGetFeatureEnabled()
      .then(({ enabled }) => {
        setFreelanceEnabled(enabled);
        if (enabled) {
          return rpc.freelanceGetListings({ status: "new", page: 1 });
        }
      })
      .then((result) => {
        if (result) setNewListingsCount(result.total);
      })
      .catch(() => {});
  }, []);

  // Refresh new-listings badge whenever the backend fires a listings-updated event
  useEffect(() => {
    if (!freelanceEnabled) return;
    const handler = () => {
      rpc.freelanceGetListings({ status: "new", page: 1 })
        .then((r) => setNewListingsCount(r.total))
        .catch(() => {});
    };
    window.addEventListener("agentdesk:freelance-listings-updated", handler);
    return () => window.removeEventListener("agentdesk:freelance-listings-updated", handler);
  }, [freelanceEnabled]);

  // ── Relay Bun update-status events into local state ──
  useEffect(() => {
    const handler = (e: Event) => {
      const { status, message, progress } = (e as CustomEvent<{ status: string; message: string; progress?: number }>).detail;
      if (progress !== undefined) setUpdateProgress(progress);
      if (status === "download-complete" || status === "patch-chain-complete") {
        setUpdateState("ready");
        setUpdateMsg("Update ready — restart to install");
      } else if (status === "error") {
        setUpdateState("error");
        setUpdateMsg(message);
      } else if (status === "no-update") {
        setUpdateState("no-update");
        setUpdateMsg("You're on the latest version");
      } else if (status === "update-available") {
        setUpdateState("available");
        // Don't use electrobun's raw hash-based message (e.g. "abc123 → def456").
        // The version string is set properly by handleVersionClick after checkForUpdate resolves.
        // Only set a fallback if we don't already have a version-based message.
        setUpdateMsg((prev) => (prev && prev.startsWith("v")) ? prev : "Update available");
      } else if (["downloading-full-bundle", "downloading-patch", "decompressing", "download-progress", "fetching-patch"].includes(status)) {
        setUpdateState("downloading");
        setUpdateMsg(message);
      }
    };
    window.addEventListener("agentdesk:update-status", handler);
    return () => window.removeEventListener("agentdesk:update-status", handler);
  }, []);

  // ── Close update panel on outside click ──
  useEffect(() => {
    if (!showUpdatePanel) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowUpdatePanel(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showUpdatePanel]);

  const handleVersionClick = async () => {
    setShowUpdatePanel(true);
    if (updateState !== "idle" && updateState !== "no-update" && updateState !== "error") return;
    setUpdateState("checking");
    setUpdateMsg("Checking for updates…");
    try {
      const res = await rpc.checkForUpdate();
      if (res.devMode) {
        setUpdateState("no-update");
        setUpdateMsg("Updates unavailable in dev mode");
        return;
      }
      if (res.error && !res.updateAvailable) {
        setUpdateState("error");
        setUpdateMsg(res.error || "Failed to check for updates");
        return;
      }
      if (res.updateAvailable) {
        setUpdateState("available");
        setUpdateMsg(`v${res.version} available`);
      } else {
        setUpdateState("no-update");
        setUpdateMsg("You're on the latest version");
      }
    } catch (e) {
      setUpdateState("error");
      setUpdateMsg((e as Error).message || "Failed to check for updates");
    }
  };

  const handleDownload = async () => {
    setUpdateState("downloading");
    setUpdateProgress(0);
    setUpdateMsg("Starting download…");
    const res = await rpc.downloadUpdate();
    if (!res.success) {
      setUpdateState("error");
      setUpdateMsg(res.error ?? "Download failed");
    }
    // On success, the updateStatus event handler sets state to "ready"
  };

  const handleApply = () => {
    setUpdateState("idle");
    setShowUpdatePanel(false);
    setApplyingUpdate(true);
    rpc.applyUpdate().catch(() => {});
  };

  const ALL_NAV_ITEMS: NavItem[] = [
    ...BASE_NAV_ITEMS.slice(0, -1), // everything except Settings
    ...pluginItems,
    ...(freelanceEnabled ? [{ label: "Freelance", icon: Briefcase, href: "/freelance" }] : []),
    BASE_NAV_ITEMS[BASE_NAV_ITEMS.length - 1], // Settings always last
  ];

  const activeHref =
    ALL_NAV_ITEMS.find((item) => item.href !== "/" && pathname.startsWith(item.href))
      ?.href ?? (pathname === "/" ? "/" : null) ?? "/";

  const NAV_ITEMS: NavItem[] = ALL_NAV_ITEMS
    .map((item) => {
      if (item.href === "/inbox") return { ...item, badge: inboxUnread };
      if (item.href === "/freelance") return { ...item, badge: newListingsCount, attention: freelanceAttention };
      return item;
    });

  return (
    <>
    {/* Mobile backdrop — tap to dismiss the off-canvas drawer (TASK-487). */}
    {isMobile && mobileOpen && (
      <div
        className="fixed inset-0 z-30 bg-black/40 md:hidden"
        onClick={onMobileClose}
        aria-hidden="true"
      />
    )}
    <aside
      className={cn(
        // Opaque bg on mobile (it's an overlay drawer — bg-muted/50 would let the
        // page bleed through); desktop keeps the original translucent bg-muted/50.
        "flex flex-col bg-card md:bg-muted/50 border-r border-border transition-all duration-200 ease-in-out z-40",
        // Desktop (≥ md): a static flex child that participates in layout —
        // identical to the original behavior.
        "md:relative md:shrink-0",
        collapsed ? "md:w-[60px]" : "md:w-[200px]",
        // Mobile (< md): an off-canvas drawer overlaying content (no layout width).
        "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[240px] max-md:max-w-[80vw]",
        isMobile && !mobileOpen ? "max-md:-translate-x-full" : "max-md:translate-x-0",
      )}
      aria-label="Main navigation"
    >
      {/* Brand area */}
      <div className="flex items-center justify-center h-14 border-b border-border shrink-0 overflow-hidden px-3">
        <style>{`@keyframes spinOnce { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        <Link to="/" className="flex items-center gap-2 cursor-pointer min-w-0">
          <Cpu
            key={iconSpinKey}
            className="h-5 w-5 shrink-0 text-foreground"
            style={{ animation: "spinOnce 0.35s ease-in-out 1" }}
            aria-hidden="true"
          />
          {!collapsed && (
            <span className="font-semibold text-lg text-foreground truncate">
              AgentDesk
            </span>
          )}
        </Link>
      </div>

      {/* Collapse toggle — floats on the right edge, vertically centred in the
          brand bar. Desktop-only: on mobile the drawer is opened from the topnav
          hamburger and dismissed via backdrop, so the collapse rail is hidden. */}
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className={cn(
          "max-md:hidden absolute right-0 top-7 -translate-y-1/2 translate-x-1/2 z-20",
          "flex items-center justify-center w-5 h-5 rounded-full",
          "bg-background border border-border text-muted-foreground/60 shadow-sm",
          "hover:bg-muted hover:text-muted-foreground transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
        )}
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronLeft className="h-3 w-3" aria-hidden="true" />
        )}
      </button>

      {/* Navigation */}
      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto overflow-x-hidden">
        {NAV_ITEMS.map((item) => (
          <NavItemButton
            key={item.href}
            item={item}
            collapsed={collapsed}
            active={activeHref === item.href}
          />
        ))}

        {/* Quick Chat is a desktop-only feature (the workspace lives on the
            machine) — no separate route, so it lives below a divider instead
            of in NAV_ITEMS. */}
        {!IS_REMOTE && (
          <>
            <div className="!my-2 border-t border-border" />
            <QuickChatButton collapsed={collapsed} />
          </>
        )}
      </nav>

      {/* Footer: version / No-Internet indicator + update panel */}
      <div className="shrink-0 border-t border-border py-2 relative" ref={panelRef}>
        {isOnline === false ? (
          <Tip content="No internet connection" side="top">
            <div className="mx-2 flex items-center justify-center rounded-md bg-red-600 px-2 py-1 cursor-default select-none animate-pulse">
              {collapsed ? (
                <WifiOff className="size-3.5 text-white" />
              ) : (
                <span className="text-xs font-bold text-white">No Internet</span>
              )}
            </div>
          </Tip>
        ) : IS_REMOTE ? (
          // Web mode: the native updater can't apply binary diffs to a remote
          // browser, so show the version as a plain, non-interactive label.
          <div className="w-full text-sm font-bold text-muted-foreground select-none text-center py-0.5">
            v{pkg.version}
          </div>
        ) : (
          <Tip content="Check for updates" side="top">
            <button
              type="button"
              onClick={handleVersionClick}
              className="w-full text-sm font-bold text-muted-foreground hover:text-foreground select-none text-center transition-colors py-0.5"
            >
              v{pkg.version}
            </button>
          </Tip>
        )}
        {!IS_REMOTE && (updateState === "available" || updateState === "ready") && (
          <Tip content="Click version number to update" side="top">
            <button
              type="button"
              onClick={handleVersionClick}
              className="w-full text-[11px] font-bold text-center leading-tight pb-0.5 text-shimmer-fire"
            >
              New Version Available
            </button>
          </Tip>
        )}

        {/* Update panel — appears above the footer */}
        {showUpdatePanel && (
          <div className="absolute bottom-full left-2 right-2 min-w-[210px] mb-1 bg-background border border-border rounded-lg shadow-lg p-3 z-50">
            {/* Checking */}
            {updateState === "checking" && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                <span>Checking for updates…</span>
              </div>
            )}

            {/* No update */}
            {updateState === "no-update" && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                <span>{updateMsg}</span>
              </div>
            )}

            {/* Update available */}
            {updateState === "available" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-indigo-700 font-medium">
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>{updateMsg}</span>
                </div>
                <button
                  type="button"
                  onClick={handleDownload}
                  className="w-full text-xs px-2 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                >
                  Download &amp; Install
                </button>
              </div>
            )}

            {/* Downloading */}
            {updateState === "downloading" && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Download className="w-3.5 h-3.5 animate-pulse shrink-0" />
                  <span className="truncate">{updateMsg}</span>
                </div>
                {updateProgress > 0 && (
                  <div className="w-full bg-muted rounded-full h-1.5">
                    <div
                      className="bg-indigo-500 h-1.5 rounded-full transition-all"
                      style={{ width: `${updateProgress}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Ready to install */}
            {updateState === "ready" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-green-700 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Update ready</span>
                </div>
                <button
                  type="button"
                  onClick={handleApply}
                  className="w-full text-xs px-2 py-1.5 rounded bg-green-600 text-white hover:bg-green-700 transition-colors"
                >
                  Restart &amp; Apply
                </button>
              </div>
            )}

            {/* Error */}
            {updateState === "error" && (
              <div className="space-y-1.5">
                <div className="flex items-start gap-2 text-xs text-red-600">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>Could not check for updates.</span>
                </div>
                <button
                  type="button"
                  onClick={() => { setUpdateState("idle"); handleVersionClick(); }}
                  className="w-full text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:bg-muted/50 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>

    {/* Full-screen restart overlay — non-closable, covers the whole app */}
    {applyingUpdate && createPortal(
      <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm">
        <div className="flex flex-col items-center gap-4 text-center">
          <RefreshCw className="h-10 w-10 text-indigo-500 animate-spin" />
          <p className="text-lg font-semibold text-foreground">Applying update…</p>
          <p className="text-sm text-muted-foreground">The app will restart automatically. Please wait.</p>
        </div>
      </div>,
      document.body
    )}
    </>
  );
}
