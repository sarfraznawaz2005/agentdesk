import { useState, useEffect, useCallback } from "react";
import { Sun, Moon } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { getStoredTheme, setTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type SidebarDefault = "expanded" | "collapsed";

export function AppearanceSettings() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [sidebarDefault, setSidebarDefault] = useState<SidebarDefault>("expanded");
  const [dashboardQuotes, setDashboardQuotes] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  // Load persisted sidebar setting and theme from DB on mount
  useEffect(() => {
    let cancelled = false;
    rpc.getSettings("appearance").then((settings) => {
      if (cancelled) return;
      const raw = settings["sidebar_default"];
      if (raw === "expanded" || raw === "collapsed") {
        setSidebarDefault(raw);
      }
      if (settings["dashboard_quotes"] !== undefined) {
        setDashboardQuotes(settings["dashboard_quotes"] !== false && settings["dashboard_quotes"] !== "false");
      }
      setIsDirty(false);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Keep local state in sync if theme changes from another source (e.g. programmatic)
  useEffect(() => {
    const handler = (e: Event) => {
      const { theme: incoming } = (e as CustomEvent<{ theme: Theme }>).detail;
      if (incoming === "light" || incoming === "dark") {
        setThemeState(incoming);
      }
    };
    window.addEventListener("agentdesk:theme-changed", handler);
    return () => window.removeEventListener("agentdesk:theme-changed", handler);
  }, []);

  async function handleThemeSelect(selected: Theme) {
    setThemeState(selected);
    await setTheme(selected);
  }

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await Promise.all([
        rpc.saveSetting("sidebar_default", sidebarDefault, "appearance"),
        rpc.saveSetting("dashboard_quotes", dashboardQuotes, "appearance"),
      ]);
      setIsDirty(false);
      toast("success", "Appearance settings saved.");
      window.dispatchEvent(new CustomEvent("agentdesk:sidebar-default-changed", { detail: { sidebarDefault } }));
    } catch {
      toast("error", "Failed to save appearance settings.");
    } finally {
      setIsSaving(false);
    }
  }, [sidebarDefault, dashboardQuotes]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Appearance</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Customise how AgentDesk looks and feels.
        </p>
      </div>

      <Separator />

      {/* Theme card */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Theme</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>Color Scheme</Label>
              <p className="text-xs text-muted-foreground">
                Choose between light and dark interface.
              </p>
            </div>
            {/* Segmented button group — applies immediately, no Save needed */}
            <div
              className="flex items-center rounded-md border border-border overflow-hidden"
              role="group"
              aria-label="Color scheme"
            >
              <button
                type="button"
                onClick={() => handleThemeSelect("light")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors",
                  theme === "light"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                aria-pressed={theme === "light"}
              >
                <Sun className="h-3.5 w-3.5" aria-hidden="true" />
                Light
              </button>
              <div className="w-px h-6 bg-border" aria-hidden="true" />
              <button
                type="button"
                onClick={() => handleThemeSelect("dark")}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors",
                  theme === "dark"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                aria-pressed={theme === "dark"}
              >
                <Moon className="h-3.5 w-3.5" aria-hidden="true" />
                Dark
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Display card */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Display</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="sidebar-default-select">Sidebar Default State</Label>
              <p className="text-xs text-muted-foreground">
                Whether the sidebar opens expanded or collapsed on launch.
              </p>
            </div>
            <Select
              value={sidebarDefault}
              onValueChange={(val) => {
                setSidebarDefault(val as SidebarDefault);
                setIsDirty(true);
              }}
            >
              <SelectTrigger id="sidebar-default-select" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="expanded">Expanded</SelectItem>
                <SelectItem value="collapsed">Collapsed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator className="my-4" />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="dashboard-quotes-toggle">Dashboard Motivational Quotes</Label>
              <p className="text-xs text-muted-foreground">
                Show an animated quote in the dashboard header.
              </p>
            </div>
            <Switch
              id="dashboard-quotes-toggle"
              checked={dashboardQuotes}
              onCheckedChange={(val) => {
                setDashboardQuotes(val);
                setIsDirty(true);
              }}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!isDirty || isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
