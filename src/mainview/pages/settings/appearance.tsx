import { useState, useEffect, useCallback } from "react";
import { Sun, Moon, Check } from "lucide-react";
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
import {
  APP_BACKGROUNDS,
  getStoredBackground,
  setBackground,
} from "@/lib/app-background";
import { cn } from "@/lib/utils";

type SidebarDefault = "expanded" | "collapsed";

export function AppearanceSettings() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [background, setBackgroundState] = useState<string>(getStoredBackground);
  const [sidebarDefault, setSidebarDefault] = useState<SidebarDefault>("expanded");
  const [dashboardQuotes, setDashboardQuotes] = useState(true);
  const [chatWidgetsDashboardOnly, setChatWidgetsDashboardOnly] = useState(true);
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
      if (settings["chat_widgets_dashboard_only"] !== undefined) {
        setChatWidgetsDashboardOnly(settings["chat_widgets_dashboard_only"] !== false && settings["chat_widgets_dashboard_only"] !== "false");
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

  // Background applies immediately (like theme) so users can try presets live.
  async function handleBackgroundSelect(id: string) {
    setBackgroundState(id);
    await setBackground(id);
  }

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await Promise.all([
        rpc.saveSetting("sidebar_default", sidebarDefault, "appearance"),
        rpc.saveSetting("dashboard_quotes", dashboardQuotes, "appearance"),
        rpc.saveSetting("chat_widgets_dashboard_only", chatWidgetsDashboardOnly, "appearance"),
      ]);
      setIsDirty(false);
      toast("success", "Appearance settings saved.");
      window.dispatchEvent(new CustomEvent("agentdesk:sidebar-default-changed", { detail: { sidebarDefault } }));
      window.dispatchEvent(new CustomEvent("agentdesk:chat-widgets-scope-changed", { detail: { dashboardOnly: chatWidgetsDashboardOnly } }));
    } catch {
      toast("error", "Failed to save appearance settings.");
    } finally {
      setIsSaving(false);
    }
  }, [sidebarDefault, dashboardQuotes, chatWidgetsDashboardOnly]);

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

      {/* Background card */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Background</CardTitle>
          <p className="text-xs text-muted-foreground">
            Pick a color or pattern for the app canvas. Applies instantly and
            adapts to your current {theme} theme.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {(["color", "pattern"] as const).map((category) => (
            <div key={category} className="space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                {category === "color" ? "Colors" : "Patterns"}
              </Label>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {APP_BACKGROUNDS.filter((p) => p.category === category).map((preset) => {
                  const selected = background === preset.id;
                  return (
                    <button
                      key={preset.id || "default"}
                      type="button"
                      onClick={() => handleBackgroundSelect(preset.id)}
                      aria-pressed={selected}
                      className={cn(
                        "group flex flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors",
                        selected
                          ? "border-primary ring-2 ring-primary/30"
                          : "border-border hover:border-primary/40",
                      )}
                    >
                      <div
                        className={cn(
                          "app-bg-swatch relative h-14 w-full overflow-hidden rounded-md border border-border/60",
                          preset.id && `appbg-${preset.id}`,
                        )}
                      >
                        {/* Mock cards to show how content floats over the canvas */}
                        <div className="absolute left-2 top-2 h-3.5 w-9 rounded-sm border border-border/60 bg-card shadow-sm" />
                        <div className="absolute left-2 top-7 h-3 w-12 rounded-sm border border-border/40 bg-card/80" />
                        {selected && (
                          <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check className="h-3 w-3" aria-hidden="true" />
                          </span>
                        )}
                      </div>
                      <span className="px-0.5 text-xs font-medium">{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
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

          <Separator className="my-4" />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="chat-widgets-dashboard-only-toggle">Show Chat Widgets Only on Dashboard</Label>
              <p className="text-xs text-muted-foreground">
                Chat launchers (PM, custom agents) and their footer bar appear only on the Dashboard page. Turn off to show them on every page.
              </p>
            </div>
            <Switch
              id="chat-widgets-dashboard-only-toggle"
              checked={chatWidgetsDashboardOnly}
              onCheckedChange={(val) => {
                setChatWidgetsDashboardOnly(val);
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
