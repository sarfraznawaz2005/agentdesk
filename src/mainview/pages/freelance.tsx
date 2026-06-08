import { useCallback, useEffect, useState } from "react";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { rpc } from "@/lib/rpc";
import { ListingsTab } from "../components/freelance/listings-tab";
import { SettingsTab } from "../components/freelance/settings-tab";
import { ExpertDashboard } from "../components/freelance/expert-dashboard";
import { useFreelanceEngineStore } from "@/stores/freelance-engine-store";

export function FreelancePage() {
  const [activeTab, setActiveTab] = useState("listings");
  // The Inbox tab is a *slot*: the always-mounted background engine (<InboxTab/>,
  // rendered once at the app shell) portals its UI into this node when present.
  // A stable ref callback so it only fires on mount/unmount, not every render.
  const setSlot = useFreelanceEngineStore((s) => s.setSlot);
  const slotRef = useCallback((el: HTMLDivElement | null) => setSlot(el), [setSlot]);
  // Auto-Earn (inbox + reply/bid sending) is gated behind the master switch and
  // OFF by default — existing installs see no change until they opt in via the
  // Settings tab. The Inbox tab only appears once enabled.
  const [autoEarnEnabled, setAutoEarnEnabled] = useState(false);

  useEffect(() => {
    // Tabs require BOTH the `autoearn` flag file (feature available) AND the
    // master switch being on.
    const load = () =>
      Promise.all([rpc.freelanceAutoEarnAvailable(), rpc.freelanceGetAutoEarnSettings()])
        .then(([avail, s]) => setAutoEarnEnabled(avail.available && s.enabled))
        .catch(() => {});
    load();
    const onSettings = () => load();
    window.addEventListener("agentdesk:settings-changed", onSettings);
    // A bid drafted from a listing card lands in the Inbox → Drafts queue, so jump
    // there automatically once it succeeds.
    const onOpenInbox = () => setActiveTab("inbox");
    window.addEventListener("agentdesk:freelance-open-inbox", onOpenInbox);
    return () => {
      window.removeEventListener("agentdesk:settings-changed", onSettings);
      window.removeEventListener("agentdesk:freelance-open-inbox", onOpenInbox);
    };
  }, []);

  // If Auto-Earn is turned off while the Inbox tab is active, fall back —
  // derived, not stateful, to avoid a setState-in-effect cascade.
  const effectiveTab = !autoEarnEnabled && activeTab === "inbox" ? "listings" : activeTab;

  const triggerCls =
    "rounded-none border-b-2 border-transparent px-4 pb-2 pt-0 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:text-foreground text-muted-foreground";

  return (
    // The Inbox tab embeds the live Freelancer preview, so give it the full width;
    // the other tabs keep the comfortable reading width.
    <div className={`p-6 mx-auto ${effectiveTab === "inbox" ? "max-w-none" : "max-w-6xl"}`}>
      <Tabs value={effectiveTab} onValueChange={setActiveTab}>
        <TabsList className="mb-5 h-auto bg-transparent p-0 border-b border-border rounded-none w-full justify-start gap-0">
          <TabsTrigger value="listings" className={triggerCls}>Listings</TabsTrigger>
          {autoEarnEnabled && (
            <TabsTrigger value="inbox" className={triggerCls}>Inbox</TabsTrigger>
          )}
          {autoEarnEnabled && (
            <TabsTrigger value="auto-earn" className={triggerCls}>Auto-Earn</TabsTrigger>
          )}
          <TabsTrigger value="settings" className={triggerCls}>Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="listings">
          <ListingsTab />
        </TabsContent>

        {autoEarnEnabled && (
          <TabsContent value="inbox">
            {/* Portal slot — the background-engine InboxTab renders itself here. */}
            <div ref={slotRef} />
          </TabsContent>
        )}

        {autoEarnEnabled && (
          <TabsContent value="auto-earn">
            <ExpertDashboard />
          </TabsContent>
        )}

        <TabsContent value="settings">
          <SettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
