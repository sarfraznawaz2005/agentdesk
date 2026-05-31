import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ProvidersSettings } from "./settings/providers";
import { GeneralSettings } from "./settings/general";
import { ConstitutionSettings } from "./settings/constitution";
import { GithubSettings } from "./settings/github";
import { TavilySettings } from "./settings/tavily-settings";
import { AppearanceSettings } from "./settings/appearance";
import { DiscordSettings } from "./settings/discord-settings";
import { WhatsAppSettings } from "./settings/whatsapp-settings";
import { EmailSettings } from "./settings/email-settings";
import { NotificationSettings } from "./settings/notification-settings";
import { McpSettings } from "./settings/mcp";
import { AiDebugSettings } from "./settings/ai-debug";
import { AuditLogSettings } from "./settings/audit-log";
import { DataSettings } from "./settings/data";
import { HealthSettings } from "./settings/health";
import { PluginsPage } from "./plugins";

function SubTabs({ tabs }: { tabs: { value: string; label: string; content: React.ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0].value);
  return (
    <div className="mt-4">
      <div className="flex gap-1 border-b border-border mb-4">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setActive(t.value)}
            className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              active === t.value
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.find((t) => t.value === active)?.content}
    </div>
  );
}

export function SettingsPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Tabs defaultValue="general" className="w-full">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="plugins">Plugins</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <SubTabs tabs={[
            { value: "general", label: "General", content: <GeneralSettings /> },
            { value: "appearance", label: "Appearance", content: <AppearanceSettings /> },
          ]} />
        </TabsContent>

        <TabsContent value="ai">
          <SubTabs tabs={[
            { value: "providers", label: "AI Providers", content: <ProvidersSettings /> },
            { value: "mcp", label: "MCP Servers", content: <McpSettings /> },
            { value: "constitution", label: "Constitution", content: <ConstitutionSettings /> },
            { value: "debug", label: "Debug", content: <AiDebugSettings /> },
          ]} />
        </TabsContent>

        <TabsContent value="channels">
          <SubTabs tabs={[
            { value: "discord", label: "Discord", content: <DiscordSettings /> },
            { value: "whatsapp", label: "WhatsApp", content: <WhatsAppSettings /> },
            { value: "email", label: "Email", content: <EmailSettings /> },
          ]} />
        </TabsContent>

        <TabsContent value="integrations">
          <SubTabs tabs={[
            { value: "github", label: "GitHub", content: <GithubSettings /> },
            { value: "tavily", label: "Tavily Search", content: <TavilySettings /> },
          ]} />
        </TabsContent>

        <TabsContent value="notifications">
          <NotificationSettings />
        </TabsContent>

        <TabsContent value="system">
          <SubTabs tabs={[
            { value: "data", label: "Data", content: <DataSettings /> },
            { value: "audit", label: "Audit Log", content: <AuditLogSettings /> },
            { value: "health", label: "Health", content: <HealthSettings /> },
          ]} />
        </TabsContent>

        <TabsContent value="plugins">
          <PluginsPage />
        </TabsContent>
      </Tabs>
    </div>
  );
}
