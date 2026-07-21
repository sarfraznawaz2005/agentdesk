import { useState, useEffect, useCallback } from "react";
import { Bell, BellOff, Hash, MessageSquare, Mail, Smartphone } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLATFORMS = [
  { key: "discord", label: "Discord", icon: Hash },
  { key: "whatsapp", label: "WhatsApp", icon: Smartphone },
  { key: "email", label: "Email", icon: Mail },
  { key: "chat", label: "Chat", icon: MessageSquare },
] as const;

type PlatformKey = (typeof PLATFORMS)[number]["key"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlatformPref {
  id?: string;
  soundEnabled: boolean;
  badgeEnabled: boolean;
  bannerEnabled: boolean;
  muteUntil: string | null;
}

type PrefsMap = Record<PlatformKey, PlatformPref>;
type DirtyMap = Record<PlatformKey, boolean>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PREF: PlatformPref = {
  soundEnabled: true,
  badgeEnabled: true,
  bannerEnabled: true,
  muteUntil: null,
};

function buildDefaultPrefs(): PrefsMap {
  return Object.fromEntries(
    PLATFORMS.map(({ key }) => [key, { ...DEFAULT_PREF }]),
  ) as PrefsMap;
}

function buildDefaultDirty(): DirtyMap {
  return Object.fromEntries(
    PLATFORMS.map(({ key }) => [key, false]),
  ) as DirtyMap;
}

/**
 * Convert a stored muteUntil ISO string to the select's value token.
 * Returns "" when not muted, "forever" for the far-future sentinel,
 * "1h" / "8h" / "24h" when the remaining time fits in those buckets,
 * or "forever" as a fallback for any other future date.
 */
function getMuteValue(muteUntil: string | null): string {
  if (!muteUntil) return "";

  const until = new Date(muteUntil).getTime();
  const now = Date.now();

  if (until <= now) return ""; // already expired — treat as not muted

  // Sentinel for "until turned off": year 2099
  if (until > new Date("2090-01-01").getTime()) return "forever";

  const remainingMs = until - now;
  const remainingHours = remainingMs / (1000 * 60 * 60);

  if (remainingHours <= 1.5) return "1h";
  if (remainingHours <= 9) return "8h";
  if (remainingHours <= 25) return "24h";
  return "forever";
}

/**
 * Convert the select token to an ISO timestamp to store.
 * Returns null for "" (not muted).
 */
function muteValueToTimestamp(value: string): string | null {
  if (!value) return null;

  const now = new Date();

  if (value === "1h") {
    return new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString();
  }
  if (value === "8h") {
    return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
  }
  if (value === "24h") {
    return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }
  if (value === "forever") {
    return new Date("2099-01-01T00:00:00.000Z").toISOString();
  }
  return null;
}

/**
 * Format the muted-until timestamp into a short human-readable string,
 * e.g. "Muted for 3h 22m" or "Muted indefinitely".
 */
function formatMuteRemaining(muteUntil: string | null): string | null {
  if (!muteUntil) return null;

  const until = new Date(muteUntil).getTime();
  const now = Date.now();

  if (until <= now) return null; // expired

  if (until > new Date("2090-01-01").getTime()) return "Muted indefinitely";

  const remainingMs = until - now;
  const totalMinutes = Math.ceil(remainingMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `Muted for ${minutes}m`;
  if (minutes === 0) return `Muted for ${hours}h`;
  return `Muted for ${hours}h ${minutes}m`;
}

// ---------------------------------------------------------------------------
// ToggleRow
// ---------------------------------------------------------------------------

interface ToggleRowProps {
  id: string;
  label: string;
  description: string;
  value: boolean;
  onToggle: () => void;
}

function ToggleRow({ id, label, description, value, onToggle }: ToggleRowProps) {
  const descId = `${id}-desc`;

  return (
    <div className="flex items-center justify-between py-2">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p id={descId} className="text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={value}
        aria-describedby={descId}
        onClick={onToggle}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
          "transition-colors duration-200 ease-in-out",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          value ? "bg-primary" : "bg-input",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg",
            "transform transition duration-200 ease-in-out",
            value ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlatformCard
// ---------------------------------------------------------------------------

interface PlatformCardProps {
  platformKey: PlatformKey;
  label: string;
  Icon: React.ElementType;
  pref: PlatformPref;
  onToggle: (field: "soundEnabled" | "badgeEnabled" | "bannerEnabled") => void;
  onMuteChange: (value: string) => void;
}

function PlatformCard({
  platformKey,
  label,
  Icon,
  pref,
  onToggle,
  onMuteChange,
}: PlatformCardProps) {
  const muteRemaining = formatMuteRemaining(pref.muteUntil);
  const isMuted = muteRemaining !== null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-foreground" aria-hidden="true" />
          <CardTitle className="text-sm font-medium">{label}</CardTitle>
          {isMuted && (
            <span className="ml-auto flex items-center gap-1 text-xs text-amber-600">
              <BellOff className="h-3.5 w-3.5" aria-hidden="true" />
              {muteRemaining}
            </span>
          )}
          {!isMuted && (
            <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
              <Bell className="h-3.5 w-3.5" aria-hidden="true" />
              Active
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-1 pt-0">
        <ToggleRow
          id={`${platformKey}-banner`}
          label="Banner"
          description="Show native OS notification banner"
          value={pref.bannerEnabled}
          onToggle={() => onToggle("bannerEnabled")}
        />

        <Separator />

        {/* Mute dropdown */}
        <div className="flex items-center justify-between py-2">
          <div className="space-y-0.5">
            <Label htmlFor={`${platformKey}-mute`}>Mute notifications</Label>
            <p className="text-xs text-muted-foreground">
              Silence this platform for a set duration
            </p>
          </div>
          <select
            id={`${platformKey}-mute`}
            value={getMuteValue(pref.muteUntil)}
            onChange={(e) => onMuteChange(e.target.value)}
            aria-label={`Mute ${label} notifications`}
            className={cn(
              "flex h-9 w-40 rounded-md border border-input bg-transparent px-3 py-1",
              "text-sm shadow-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            <option value="">Not muted</option>
            <option value="1h">For 1 hour</option>
            <option value="8h">For 8 hours</option>
            <option value="24h">For 24 hours</option>
            <option value="forever">Until turned off</option>
          </select>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// NotificationSettings
// ---------------------------------------------------------------------------

export function NotificationSettings() {
  const [prefs, setPrefs] = useState<PrefsMap>(buildDefaultPrefs());
  const [dirty, setDirty] = useState<DirtyMap>(buildDefaultDirty());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sessionCompleteNotif, setSessionCompleteNotif] = useState(true);
  const [sessionCompleteNotifDirty, setSessionCompleteNotifDirty] = useState(false);
  const [errorNotif, setErrorNotif] = useState(true);
  const [errorNotifDirty, setErrorNotifDirty] = useState(false);
  const [taskDoneChannelNotify, setTaskDoneChannelNotify] = useState(true);
  const [taskDoneChannelNotifyDirty, setTaskDoneChannelNotifyDirty] = useState(false);
  const [errorChannelNotify, setErrorChannelNotify] = useState(true);
  const [errorChannelNotifyDirty, setErrorChannelNotifyDirty] = useState(false);
  const [questionChannelNotify, setQuestionChannelNotify] = useState(true);
  const [questionChannelNotifyDirty, setQuestionChannelNotifyDirty] = useState(false);
  const [planApprovalChannelNotify, setPlanApprovalChannelNotify] = useState(true);
  const [planApprovalChannelNotifyDirty, setPlanApprovalChannelNotifyDirty] = useState(false);
  const [freelanceEnabled, setFreelanceEnabled] = useState(false);
  const [freelanceNewListingsNotif, setFreelanceNewListingsNotif] = useState(true);
  const [freelanceNewListingsNotifDirty, setFreelanceNewListingsNotifDirty] = useState(false);

  const anyDirty =
    Object.values(dirty).some(Boolean) ||
    sessionCompleteNotifDirty ||
    errorNotifDirty ||
    taskDoneChannelNotifyDirty ||
    errorChannelNotifyDirty ||
    questionChannelNotifyDirty ||
    planApprovalChannelNotifyDirty ||
    freelanceNewListingsNotifDirty;

  // ---- Load on mount -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const results = await rpc.getNotificationPreferences();

        if (cancelled) return;

        const map: PrefsMap = buildDefaultPrefs();

        for (const row of results) {
          const key = row.platform as PlatformKey;
          if (!PLATFORMS.some((p) => p.key === key)) continue;

          map[key] = {
            id: row.id,
            soundEnabled: row.soundEnabled === 1,
            badgeEnabled: row.badgeEnabled === 1,
            bannerEnabled: row.bannerEnabled === 1,
            muteUntil: row.muteUntil ?? null,
          };
        }

        setPrefs(map);
        setDirty(buildDefaultDirty());

        const stored = await rpc.getSetting("session_complete_notification", "notifications");
        setSessionCompleteNotif(stored === null ? true : String(stored) !== "false");

        const errorStored = await rpc.getSetting("error_notification", "notifications");
        setErrorNotif(errorStored === null ? true : String(errorStored) !== "false");

        const taskDoneStored = await rpc.getSetting("task_done_channel_notify", "notifications");
        setTaskDoneChannelNotify(taskDoneStored === null ? true : String(taskDoneStored) !== "false");

        const errorChannelStored = await rpc.getSetting("error_channel_notify", "notifications");
        setErrorChannelNotify(errorChannelStored === null ? true : String(errorChannelStored) !== "false");

        const questionChannelStored = await rpc.getSetting("question_channel_notify", "notifications");
        setQuestionChannelNotify(questionChannelStored === null ? true : String(questionChannelStored) !== "false");

        const planApprovalChannelStored = await rpc.getSetting("plan_approval_channel_notify", "notifications");
        setPlanApprovalChannelNotify(planApprovalChannelStored === null ? true : String(planApprovalChannelStored) !== "false");

        const [freelanceFeature, freelanceNotifStored] = await Promise.all([
          rpc.freelanceGetFeatureEnabled(),
          rpc.getSetting("freelance_new_listings_notification", "notifications"),
        ]);
        setFreelanceEnabled(freelanceFeature.enabled);
        setFreelanceNewListingsNotif(freelanceNotifStored === null ? true : String(freelanceNotifStored) !== "false");
      } catch {
        if (!cancelled) {
          toast("error", "Failed to load notification preferences.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Toggle handler -------------------------------------------------------

  const handleToggle = useCallback(
    (platform: PlatformKey, field: "soundEnabled" | "badgeEnabled" | "bannerEnabled") => {
      setPrefs((prev) => ({
        ...prev,
        [platform]: {
          ...prev[platform],
          [field]: !prev[platform][field],
        },
      }));
      setDirty((prev) => ({ ...prev, [platform]: true }));
    },
    [],
  );

  // ---- Mute change handler --------------------------------------------------

  const handleMuteChange = useCallback((platform: PlatformKey, value: string) => {
    const muteUntil = muteValueToTimestamp(value);
    setPrefs((prev) => ({
      ...prev,
      [platform]: {
        ...prev[platform],
        muteUntil,
      },
    }));
    setDirty((prev) => ({ ...prev, [platform]: true }));
  }, []);

  // ---- Save ----------------------------------------------------------------

  const handleSave = useCallback(async () => {
    setSaving(true);
    const platformsToSave = PLATFORMS.filter(({ key }) => dirty[key]);

    try {
      await Promise.all([
        ...platformsToSave.map(({ key }) => {
          const pref = prefs[key];
          return rpc.saveNotificationPreference({
            id: pref.id,
            platform: key,
            soundEnabled: pref.soundEnabled,
            badgeEnabled: pref.badgeEnabled,
            bannerEnabled: pref.bannerEnabled,
            muteUntil: pref.muteUntil,
          });
        }),
        ...(sessionCompleteNotifDirty
          ? [rpc.saveSetting("session_complete_notification", String(sessionCompleteNotif), "notifications")]
          : []),
        ...(errorNotifDirty
          ? [rpc.saveSetting("error_notification", String(errorNotif), "notifications")]
          : []),
        ...(taskDoneChannelNotifyDirty
          ? [rpc.saveSetting("task_done_channel_notify", String(taskDoneChannelNotify), "notifications")]
          : []),
        ...(errorChannelNotifyDirty
          ? [rpc.saveSetting("error_channel_notify", String(errorChannelNotify), "notifications")]
          : []),
        ...(questionChannelNotifyDirty
          ? [rpc.saveSetting("question_channel_notify", String(questionChannelNotify), "notifications")]
          : []),
        ...(planApprovalChannelNotifyDirty
          ? [rpc.saveSetting("plan_approval_channel_notify", String(planApprovalChannelNotify), "notifications")]
          : []),
        ...(freelanceNewListingsNotifDirty
          ? [rpc.saveSetting("freelance_new_listings_notification", String(freelanceNewListingsNotif), "notifications")]
          : []),
      ]);

      // Update ids returned from the server
      const updated = await rpc.getNotificationPreferences();
      if (updated) {
        setPrefs((prev) => {
          const next = { ...prev };
          for (const row of updated) {
            const k = row.platform as PlatformKey;
            if (next[k]) {
              next[k] = { ...next[k], id: row.id };
            }
          }
          return next;
        });
      }

      setDirty(buildDefaultDirty());
      setSessionCompleteNotifDirty(false);
      setErrorNotifDirty(false);
      setTaskDoneChannelNotifyDirty(false);
      setErrorChannelNotifyDirty(false);
      setQuestionChannelNotifyDirty(false);
      setPlanApprovalChannelNotifyDirty(false);
      setFreelanceNewListingsNotifDirty(false);
      toast("success", "Notification preferences saved.");
    } catch {
      toast("error", "Failed to save notification preferences. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [
    prefs,
    dirty,
    sessionCompleteNotif,
    sessionCompleteNotifDirty,
    errorNotif,
    errorNotifDirty,
    taskDoneChannelNotify,
    taskDoneChannelNotifyDirty,
    errorChannelNotify,
    errorChannelNotifyDirty,
    questionChannelNotify,
    questionChannelNotifyDirty,
    planApprovalChannelNotify,
    planApprovalChannelNotifyDirty,
    freelanceNewListingsNotif,
    freelanceNewListingsNotifDirty,
  ]);

  // ---- Loading skeleton -----------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-56 bg-muted animate-pulse rounded" />
        {PLATFORMS.map(({ key }) => (
          <div key={key} className="h-48 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  // ---- Render ---------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h3 className="text-lg font-semibold text-foreground">
          Notification Preferences
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Control how and when AgentDesk notifies you across each connected
          platform. Changes apply per platform and take effect immediately after
          saving.
        </p>
      </div>

      <Separator />

      {/* Desktop / agent notifications */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-3">Desktop Notifications</h4>
        <Card>
          <CardContent className="pt-4 space-y-0">
            <ToggleRow
              id="session-complete-notif"
              label="Session complete"
              description="Show a desktop notification when all agents and the PM have finished, or when Assistant (General Chat) replies — only fires when the app is not in focus"
              value={sessionCompleteNotif}
              onToggle={() => {
                setSessionCompleteNotif((v) => !v);
                setSessionCompleteNotifDirty(true);
              }}
            />
            <Separator />
            <ToggleRow
              id="error-notif"
              label="Error notification"
              description="Show a desktop notification when an agent hits an error in the project chat — only fires when the app is not in focus"
              value={errorNotif}
              onToggle={() => {
                setErrorNotif((v) => !v);
                setErrorNotifDirty(true);
              }}
            />
            {freelanceEnabled && (
              <>
                <Separator />
                <ToggleRow
                  id="freelance-new-listings-notif"
                  label="New freelance listings"
                  description="Show a desktop notification when the hourly poll finds new listings"
                  value={freelanceNewListingsNotif}
                  onToggle={() => {
                    setFreelanceNewListingsNotif((v) => !v);
                    setFreelanceNewListingsNotifDirty(true);
                  }}
                />
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Separator />

      {/* Channel messages */}
      <div>
        <h4 className="text-sm font-semibold text-foreground mb-3">Channel Messages</h4>
        <Card>
          <CardContent className="pt-4">
            <ToggleRow
              id="task-done-channel-notify"
              label="Task completion message"
              description="Send a message to all connected channels (Discord, WhatsApp, Email) when a kanban task is marked as done"
              value={taskDoneChannelNotify}
              onToggle={() => {
                setTaskDoneChannelNotify((v) => !v);
                setTaskDoneChannelNotifyDirty(true);
              }}
            />
            <Separator />
            <ToggleRow
              id="error-channel-notify"
              label="Error message"
              description="Send a message to all connected channels when an agent hits an error or a chat session stops on an error"
              value={errorChannelNotify}
              onToggle={() => {
                setErrorChannelNotify((v) => !v);
                setErrorChannelNotifyDirty(true);
              }}
            />
            <Separator />
            <ToggleRow
              id="question-channel-notify"
              label="Agent questions & shell approvals"
              description="Forward an agent's question or shell-command approval request to all connected channels, and let a reply from there resolve it"
              value={questionChannelNotify}
              onToggle={() => {
                setQuestionChannelNotify((v) => !v);
                setQuestionChannelNotifyDirty(true);
              }}
            />
            <Separator />
            <ToggleRow
              id="plan-approval-channel-notify"
              label="Plan ready for approval"
              description="Send a heads-up message to all connected channels when a plan is waiting for approval in an in-app conversation (approve/reject still happens in the app)"
              value={planApprovalChannelNotify}
              onToggle={() => {
                setPlanApprovalChannelNotify((v) => !v);
                setPlanApprovalChannelNotifyDirty(true);
              }}
            />
          </CardContent>
        </Card>
      </div>

      <Separator />

      {/* Per-platform cards */}
      <div className="space-y-4">
        {PLATFORMS.map(({ key, label, icon: Icon }) => (
          <PlatformCard
            key={key}
            platformKey={key}
            label={label}
            Icon={Icon}
            pref={prefs[key]}
            onToggle={(field) => handleToggle(key, field)}
            onMuteChange={(value) => handleMuteChange(key, value)}
          />
        ))}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-3">
        <p
          className={cn(
            "text-xs text-muted-foreground transition-opacity duration-150",
            anyDirty ? "opacity-100" : "opacity-0",
          )}
          aria-live="polite"
        >
          You have unsaved changes.
        </p>
        <Button
          type="button"
          onClick={handleSave}
          disabled={saving || !anyDirty}
        >
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
