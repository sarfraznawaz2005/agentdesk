import { useState, useEffect, useCallback } from "react";
import { FolderOpen } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserProfile {
  userName: string;
  userEmail: string;
}

interface ApplicationSettings {
  timezone: string;
  globalWorkspacePath: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const USER_DEFAULTS: UserProfile = {
  userName: "",
  userEmail: "",
};

const APPLICATION_DEFAULTS: ApplicationSettings = {
  timezone: "UTC",
  globalWorkspacePath: "",
};

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Helsinki",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
] as const;

// ---------------------------------------------------------------------------
// ResetApplicationCard — danger zone
// ---------------------------------------------------------------------------

function ResetApplicationCard() {
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      await rpc.resetApplication();
      // The app will quit automatically after ~500ms.
      // Show a message in case it takes a moment.
    } catch {
      toast("error", "Failed to reset application.");
      setResetting(false);
      setConfirming(false);
    }
  }, []);

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">Danger Zone</CardTitle>
        <CardDescription>
          Irreversible actions that affect your entire application.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!confirming ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Reset Application</p>
              <p className="text-xs text-muted-foreground">
                Delete all data, projects, API keys, and settings. Backups are preserved. The app will restart.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirming(true)}
            >
              Reset Application
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 space-y-3">
            <p className="text-sm font-semibold text-destructive">
              Are you absolutely sure?
            </p>
            <p className="text-xs text-muted-foreground">
              This will permanently delete all your data including projects,
              conversations, agents, API keys, settings, and all other saved
              data. Your backups will be preserved and can be restored after
              setup. The app will quit and you will need to set it up again
              from scratch.
            </p>
            <p className="text-xs font-medium text-destructive">
              This action cannot be undone.
            </p>
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={resetting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleReset}
                disabled={resetting}
              >
                {resetting ? "Resetting…" : "Yes, delete everything and restart"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// FieldRow — label + control in a two-column layout
// ---------------------------------------------------------------------------

interface FieldRowProps {
  id: string;
  label: string;
  description?: string;
  children: React.ReactNode;
}

function FieldRow({ id, label, description, children }: FieldRowProps) {
  return (
    <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[240px_1fr]">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="w-full max-w-xs">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GeneralSettings
// ---------------------------------------------------------------------------

export function GeneralSettings() {
  const [userProfile, setUserProfile] = useState<UserProfile>(USER_DEFAULTS);
  const [application, setApplication] = useState<ApplicationSettings>(APPLICATION_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // ---- Load settings on mount -----------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        const [appResult, userResult] = await Promise.all([
          rpc.getSettings("general"),
          rpc.getSettings("user"),
        ]);

        if (cancelled) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const appData: Record<string, any> = appResult as any ?? {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const userData: Record<string, any> = userResult as any ?? {};

        setUserProfile({
          userName: typeof userData.user_name === "string" ? userData.user_name : USER_DEFAULTS.userName,
          userEmail: typeof userData.user_email === "string" ? userData.user_email : USER_DEFAULTS.userEmail,
        });

        setApplication({
          timezone:
            typeof appData.timezone === "string" && appData.timezone.length > 0
              ? appData.timezone
              : APPLICATION_DEFAULTS.timezone,
          globalWorkspacePath:
            typeof appData.global_workspace_path === "string"
              ? appData.global_workspace_path
              : APPLICATION_DEFAULTS.globalWorkspacePath,
        });
      } catch {
        if (!cancelled) {
          toast("error", "Failed to load settings.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Change helpers -------------------------------------------------------

  const handleUserProfileChange = useCallback(
    <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => {
      setUserProfile((prev) => ({ ...prev, [key]: value }));
      setDirty(true);
    },
    [],
  );

  const handleApplicationChange = useCallback(
    <K extends keyof ApplicationSettings>(key: K, value: ApplicationSettings[K]) => {
      setApplication((prev) => ({ ...prev, [key]: value }));
      setDirty(true);
    },
    [],
  );

  // ---- Save -----------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (userProfile.userEmail.trim() && !isValidEmail(userProfile.userEmail.trim())) {
      toast("error", "Please enter a valid email address.");
      return;
    }
    setSaving(true);
    try {
      await Promise.all([
        rpc.saveSetting("user_name", userProfile.userName, "user"),
        rpc.saveSetting("user_email", userProfile.userEmail, "user"),
        rpc.saveSetting("timezone", application.timezone, "general"),
        rpc.saveSetting("global_workspace_path", application.globalWorkspacePath, "general"),
      ]);
      setDirty(false);
      toast("success", "Settings saved.");
    } catch {
      toast("error", "Failed to save settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [userProfile, application]);

  // ---- Render ---------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading settings…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 py-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">General</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Configure your profile and application preferences.
        </p>
      </div>

      {/* ---- User Profile ------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Your Profile</CardTitle>
          <CardDescription>
            Agents use your name and email in communications.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FieldRow
            id="user-name"
            label="Name"
            description="How agents should address you."
          >
            <Input
              id="user-name"
              value={userProfile.userName}
              onChange={(e) => handleUserProfileChange("userName", e.target.value)}
              placeholder="e.g. Jane Smith"
            />
          </FieldRow>

          <Separator />

          <FieldRow
            id="user-email"
            label="Email"
            description="Used for email communications from agents."
          >
            <Input
              id="user-email"
              type="email"
              value={userProfile.userEmail}
              onChange={(e) => handleUserProfileChange("userEmail", e.target.value)}
              placeholder="e.g. jane@example.com"
              aria-invalid={userProfile.userEmail.trim().length > 0 && !isValidEmail(userProfile.userEmail.trim())}
              className={cn(
                userProfile.userEmail.trim().length > 0 && !isValidEmail(userProfile.userEmail.trim()) &&
                "border-destructive focus-visible:ring-destructive"
              )}
            />
            {userProfile.userEmail.trim().length > 0 && !isValidEmail(userProfile.userEmail.trim()) && (
              <p className="text-xs text-destructive mt-1">Please enter a valid email address.</p>
            )}
          </FieldRow>
        </CardContent>
      </Card>

      {/* ---- Application Settings ----------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Application</CardTitle>
          <CardDescription>Configure application behavior.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FieldRow
            id="global-workspace"
            label="Global Workspace Path"
            description="Root folder where all project workspaces are created. Each project gets a subfolder."
          >
            <div className="flex gap-2">
              <Input
                id="global-workspace"
                value={application.globalWorkspacePath}
                onChange={(e) => handleApplicationChange("globalWorkspacePath", e.target.value)}
                placeholder="/home/user/projects"
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => {
                  function onResult(e: Event) {
                    const { path } = (e as CustomEvent<{ path: string | null }>).detail;
                    window.removeEventListener("agentdesk:directory-selected", onResult);
                    if (path) {
                      handleApplicationChange("globalWorkspacePath", path);
                    }
                  }
                  window.addEventListener("agentdesk:directory-selected", onResult);
                  rpc.selectDirectory().catch(() => {
                    window.removeEventListener("agentdesk:directory-selected", onResult);
                    toast("error", "Failed to open directory picker.");
                  });
                }}
                aria-label="Browse for workspace directory"
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </FieldRow>

          <Separator />

          <FieldRow
            id="timezone"
            label="Timezone"
            description="Default timezone for cron jobs and scheduling."
          >
            <Select
              value={application.timezone}
              onValueChange={(v) => handleApplicationChange("timezone", v)}
            >
              <SelectTrigger id="timezone" className="w-full">
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectContent>
                {COMMON_TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

        </CardContent>
      </Card>

      {/* ---- Danger Zone -------------------------------------------------- */}
      <ResetApplicationCard />

      {/* ---- Footer actions ----------------------------------------------- */}
      <div className="flex items-center justify-end gap-3">
        <p
          className={cn(
            "text-xs text-muted-foreground transition-opacity duration-150",
            dirty ? "opacity-100" : "opacity-0",
          )}
          aria-live="polite"
        >
          You have unsaved changes.
        </p>
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
