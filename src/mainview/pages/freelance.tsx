import { useState } from "react";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { ListingsTab } from "../components/freelance/listings-tab";
import { SettingsTab } from "../components/freelance/settings-tab";

export function FreelancePage() {
  const [activeTab, setActiveTab] = useState("listings");

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-5 h-auto bg-transparent p-0 border-b border-border rounded-none w-full justify-start gap-0">
          <TabsTrigger value="listings" className="rounded-none border-b-2 border-transparent px-4 pb-2 pt-0 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:text-foreground text-muted-foreground">Listings</TabsTrigger>
          <TabsTrigger value="settings" className="rounded-none border-b-2 border-transparent px-4 pb-2 pt-0 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:text-foreground text-muted-foreground">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="listings">
          <ListingsTab />
        </TabsContent>

        <TabsContent value="settings">
          <SettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
