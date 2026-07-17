import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { initTheme, syncThemeFromDB } from "./lib/theme";
import { initBackground, syncBackgroundFromDB } from "./lib/app-background";
import { rpc } from "./lib/rpc";
import { setPendingQuickChatConversationId } from "./lib/quick-chat-fallback";
import { ProductionContextMenu } from "./components/production-context-menu";

initTheme(); // synchronous — runs before render, no flash
initBackground(); // synchronous — runs before render, no flash

// Quick Chat pull-based route-recovery fallback (see docs/quick-chat-plan.md
// and src/bun/quick-chat/window.ts's pendingRoutes map). The window's own
// `preload` option delivers the initial #/quick-chat/<id> hash before this
// even runs — but if a cold-started process's webview got silently torn
// down and recreated afterward, the recreated page landed on the default
// route instead. This is a webview-initiated RPC *request*, unlike the
// Bun-initiated pushes that don't reliably reach a webview whose native
// pointer readiness can't be trusted: if this call can even run, the RPC
// channel is provably alive. Runs once on every window (not just Quick Chat
// ones) — for anything else window.__electrobunWindowId resolves to no
// pendingRoutes entry, so getQuickChatRoute just returns null and this is a
// harmless no-op round-trip. Fire-and-forget: never blocks initial render.
function checkQuickChatRouteFallback(): void {
  if (!("__electrobunWindowId" in window)) return; // web/remote mode — no native window id to ask about
  rpc.getQuickChatRoute(window.__electrobunWindowId).then((route) => {
    if (!route) return;
    if (router.state.location.pathname === `/quick-chat/${route.projectId}`) return; // already there — preload worked
    setPendingQuickChatConversationId(route.conversationId);
    router.navigate({ to: "/quick-chat/$projectId", params: { projectId: route.projectId } });
  }).catch(() => { /* best-effort — the preload path is still the primary delivery mechanism */ });
}

function App() {
  useEffect(() => {
    syncThemeFromDB();
    syncBackgroundFromDB();
    checkQuickChatRouteFallback();
  }, []);

  return (
    <>
      <RouterProvider router={router} />
      <ProductionContextMenu />
    </>
  );
}

export default App;
