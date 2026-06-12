// ---------------------------------------------------------------------------
// Auto-Earn — always-mounted Inbox host (background engine)
//
// Mounted ONCE at the app shell. When Auto-Earn is available + enabled it keeps a
// single <InboxTab/> instance mounted for the app's lifetime, so its webview sync,
// interceptor, and full-auto send loop run no matter which page the user is on —
// exactly like the auto-shortlist engine.
//
// HOW IT STAYS MOUNTED: <InboxTab/> is portaled into a STABLE, non-React DOM node
// (`hostEl`). We never change the portal target (changing a portal's container
// remounts the subtree), so InboxTab and its webview never re-initialise. Instead
// we re-parent `hostEl` itself between the visible Inbox-tab slot and a hidden
// holder — moving a DOM node does not touch React, so the component keeps running.
// This is the same technique `session-webview-host` uses for the native webview.
//
// A small temporary badge (bottom-left) reports the engine heartbeat so background
// operation can be visually verified from any page.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { rpc } from "@/lib/rpc";
import { InboxTab } from "./inbox-tab";
import { useFreelanceEngineStore } from "@/stores/freelance-engine-store";

export function AlwaysMountedInbox() {
  const [active, setActive] = useState(false); // autoEarn available + master switch on
  const slot = useFreelanceEngineStore((s) => s.slot);
  // Stable container InboxTab is portaled into — its identity NEVER changes, so the
  // portal (and InboxTab) never remounts. We only move this element in the DOM.
  const [hostEl] = useState(() => {
    const el = document.createElement("div");
    el.style.width = "100%";
    return el;
  });
  const hiddenRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const load = () =>
      Promise.all([rpc.freelanceAutoEarnAvailable(), rpc.freelanceGetAutoEarnSettings()])
        .then(([avail, s]) => setActive(avail.available && s.enabled))
        .catch(() => {});
    // Defer the initial engine startup so creating + loading the Freelancer webview
    // never competes with app startup (same idea as the delayed update check / MCP
    // connect). A live settings toggle still activates immediately.
    const timer = setTimeout(load, 4000);
    const onSettings = () => load();
    window.addEventListener("agentdesk:settings-changed", onSettings);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("agentdesk:settings-changed", onSettings);
    };
  }, []);

  // Re-parent the (stable) host element: into the visible Inbox-tab slot when the
  // user is viewing it, otherwise into the hidden holder (engine keeps running).
  useEffect(() => {
    if (!active) return;
    const dest = slot ?? hiddenRef.current;
    if (dest && hostEl.parentElement !== dest) dest.appendChild(hostEl);
  }, [active, slot, hostEl]);

  if (!active) return null;

  return (
    <>
      {/* Hidden holder — home for the host element when off the Inbox tab. */}
      <div ref={hiddenRef} style={{ display: "none" }} aria-hidden />
      {createPortal(<InboxTab />, hostEl)}
    </>
  );
}
