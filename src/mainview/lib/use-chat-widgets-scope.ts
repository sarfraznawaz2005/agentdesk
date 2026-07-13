import { useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { rpc } from "@/lib/rpc";

/**
 * Whether the dashboard chat launchers (PM + custom agents), the persistent
 * ChatLauncherFooter bar, and the Collections page's own chat widget should be
 * active on the CURRENT page. Reflects the "Show chat widgets only on
 * Dashboard" appearance setting (Settings → Appearance; default true —
 * dashboard-only) combined with the current route. When the setting is off,
 * this is true everywhere.
 */
export function useChatWidgetsVisibleHere(): boolean {
  const [dashboardOnly, setDashboardOnly] = useState(true);
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    rpc.getSetting("chat_widgets_dashboard_only", "appearance").then((val) => {
      if (cancelled) return;
      // null = never saved → default true (dashboard-only). Boolean false or
      // string "false" = the user turned it off.
      const v = val as unknown;
      setDashboardOnly(v === null || (v !== false && v !== "false"));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const { dashboardOnly: incoming } = (e as CustomEvent<{ dashboardOnly: boolean }>).detail;
      setDashboardOnly(incoming);
    };
    window.addEventListener("agentdesk:chat-widgets-scope-changed", handler);
    return () => window.removeEventListener("agentdesk:chat-widgets-scope-changed", handler);
  }, []);

  return !dashboardOnly || location.pathname === "/";
}
