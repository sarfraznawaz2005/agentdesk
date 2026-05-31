import { useState, useEffect, useCallback } from "react";
import { Trash2, Plus, Smartphone, QrCode } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WhatsAppConfig {
  id: string;
  projectId: string | null;
  platform: string;
  config: string;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

interface Project {
  id: string;
  name: string;
}

type WhatsAppStatus =
  | "connected"
  | "disconnected"
  | "connecting"
  | "enabled"
  | "disabled"
  | "not_configured"
  | "error";

// ---------------------------------------------------------------------------
// Connection status indicator
// ---------------------------------------------------------------------------

function ConnectionStatusIndicator({ status }: { status: string }) {
  const statusMap: Record<string, { color: string; label: string }> = {
    connected: { color: "bg-green-500", label: "Connected" },
    disconnected: { color: "bg-gray-300 dark:bg-gray-600", label: "Disconnected" },
    connecting: { color: "bg-yellow-400", label: "Connecting..." },
    enabled: { color: "bg-green-500", label: "Enabled" },
    disabled: { color: "bg-gray-300 dark:bg-gray-600", label: "Disabled" },
    not_configured: { color: "bg-gray-300 dark:bg-gray-600", label: "Not Configured" },
    error: { color: "bg-red-500", label: "Error" },
  };

  const { color, label } = statusMap[status] ?? statusMap.disconnected;

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn("inline-block h-2 w-2 rounded-full", color)}
        aria-hidden="true"
      />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-config inline form
// ---------------------------------------------------------------------------

interface AddConfigFormProps {
  projects: Project[];
  onSaved: () => void;
  onCancel: () => void;
}

function AddConfigForm({ projects, onSaved, onCancel }: AddConfigFormProps) {
  const [projectId, setProjectId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await rpc.saveWhatsAppConfig({
        projectId: projectId || undefined,
        enabled,
      });
      toast("success", "WhatsApp config saved.");
      onSaved();
    } catch {
      toast("error", "Failed to save WhatsApp config. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [projectId, enabled, onSaved]);

  return (
    <div className="space-y-4">
      {/* Project assignment */}
      <div className="space-y-2">
        <Label htmlFor="whatsapp-project">Project (optional)</Label>
        <select
          id="whatsapp-project"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className={cn(
            "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1",
            "text-sm shadow-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <option value="">No project (global)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center gap-3">
        <label
          htmlFor="whatsapp-enabled"
          className="text-sm font-medium leading-none cursor-pointer"
        >
          Enable this configuration
        </label>
        <button
          id="whatsapp-enabled"
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled((prev) => !prev)}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
            "transition-colors duration-200 ease-in-out",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            enabled ? "bg-primary" : "bg-input",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg",
              "transform transition duration-200 ease-in-out",
              enabled ? "translate-x-4" : "translate-x-0",
            )}
          />
        </button>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={isSaving}
        >
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main settings component
// ---------------------------------------------------------------------------

export function WhatsAppSettings() {
  const [configs, setConfigs] = useState<WhatsAppConfig[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [whatsAppStatus, setWhatsAppStatus] =
    useState<WhatsAppStatus>("not_configured");
  const [phoneNumber, setPhoneNumber] = useState<string | undefined>(undefined);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cfgs, projs] = await Promise.all([
        rpc.getWhatsAppConfigs(),
        rpc.getProjects(),
      ]);
      setConfigs(cfgs);
      setProjects(projs);

      // Fetch status for the first config if any exist
      if (cfgs.length > 0) {
        const statusResult = await rpc.getWhatsAppStatus(cfgs[0].id);
        setWhatsAppStatus(statusResult.status as WhatsAppStatus);
        setPhoneNumber(statusResult.phoneNumber);
      } else {
        setWhatsAppStatus("not_configured");
        setPhoneNumber(undefined);
      }
    } catch {
      toast("error", "Failed to load WhatsApp settings.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Listen for QR code pushed from backend
  useEffect(() => {
    const onQR = (e: Event) => {
      const { qr } = (e as CustomEvent<{ channelId: string; qr: string }>).detail;
      setQrCodeDataUrl(qr);
      setWhatsAppStatus("connecting");
    };
    const onStatus = (e: Event) => {
      const { status, phoneNumber: phone } = (e as CustomEvent<{ channelId: string; status: WhatsAppStatus; phoneNumber?: string }>).detail;
      setWhatsAppStatus(status);
      if (phone) setPhoneNumber(phone);
      if (status === "connected") setQrCodeDataUrl(null);
    };
    window.addEventListener("agentdesk:whatsapp-qr", onQR);
    window.addEventListener("agentdesk:whatsapp-status", onStatus);
    return () => {
      window.removeEventListener("agentdesk:whatsapp-qr", onQR);
      window.removeEventListener("agentdesk:whatsapp-status", onStatus);
    };
  }, []);

  // Poll real adapter status every 3s when we have a config
  useEffect(() => {
    if (configs.length === 0) return;
    const id = configs[0].id;
    const interval = setInterval(async () => {
      try {
        const result = await rpc.getWhatsAppStatus(id);
        setWhatsAppStatus(result.status as WhatsAppStatus);
        if (result.phoneNumber) setPhoneNumber(result.phoneNumber);
        if (result.status === "connected") setQrCodeDataUrl(null);
      } catch { /* non-fatal */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [configs]);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    try {
      await rpc.deleteWhatsAppConfig(id);
      toast("success", "WhatsApp config deleted.");
      setConfigs((prev) => prev.filter((c) => c.id !== id));
    } catch {
      toast("error", "Failed to delete WhatsApp config.");
    } finally {
      setDeletingId(null);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    if (configs.length === 0) return;
    setIsDisconnecting(true);
    try {
      await rpc.deleteWhatsAppConfig(configs[0].id);
      toast("success", "WhatsApp disconnected.");
      setConfigs([]);
      setWhatsAppStatus("not_configured");
      setPhoneNumber(undefined);
    } catch {
      toast("error", "Failed to disconnect WhatsApp.");
    } finally {
      setIsDisconnecting(false);
    }
  }, [configs]);

  const handleSaved = useCallback(async () => {
    setShowForm(false);
    await load();
    // Auto-connect after saving — triggers QR generation.
    // Read configs fresh from RPC to avoid stale closure and React StrictMode double-invoke.
    const freshConfigs = await rpc.getWhatsAppConfigs();
    if (freshConfigs.length > 0 && freshConfigs[0].enabled) {
      setIsConnecting(true);
      rpc.connectWhatsApp(freshConfigs[0].id).finally(() => setIsConnecting(false));
    }
  }, [load]);

  const handleCancel = useCallback(() => {
    setShowForm(false);
  }, []);

  function projectName(id: string | null): string {
    if (!id) return "Global";
    return projects.find((p) => p.id === id)?.name ?? id;
  }

  const isConnected = whatsAppStatus === "connected";

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-32 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold">WhatsApp Integration</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Link a WhatsApp account via QR code to receive notifications and
          interact with AgentDesk from WhatsApp.
        </p>
      </div>

      <Separator />

      {/* Connection status card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Smartphone
                className="h-5 w-5 text-foreground"
                aria-hidden="true"
              />
              <CardTitle className="text-base">Connection Status</CardTitle>
            </div>
            <ConnectionStatusIndicator status={whatsAppStatus} />
          </div>
          <CardDescription>
            {isConnected && phoneNumber
              ? `Linked to ${phoneNumber}`
              : "Scan the QR code below to link your WhatsApp account."}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* QR code display area */}
      {!isConnected && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <QrCode className="h-5 w-5 text-foreground" aria-hidden="true" />
              <CardTitle className="text-base">Scan QR Code</CardTitle>
            </div>
            <CardDescription>
              Open WhatsApp on your phone, go to Settings &rarr; Linked Devices
              &rarr; Link a Device, then scan the code below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center gap-4 py-2">
              {qrCodeDataUrl ? (
                <img
                  src={qrCodeDataUrl}
                  alt="WhatsApp QR code — scan with your phone"
                  className="h-48 w-48 rounded-lg"
                />
              ) : (
                <div
                  aria-label="QR code area — waiting for code from backend"
                  className={cn(
                    "flex h-48 w-48 items-center justify-center rounded-lg",
                    "border-2 border-dashed border-muted-foreground/30 bg-muted/30",
                  )}
                >
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <QrCode className="h-12 w-12 opacity-30" aria-hidden="true" />
                    <span className="text-xs text-center leading-snug max-w-[120px]">
                      Scan QR code to link WhatsApp
                    </span>
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {isConnecting
                  ? "Connecting — QR code will appear shortly..."
                  : whatsAppStatus === "connecting"
                  ? "Waiting for QR code..."
                  : configs.length === 0
                  ? "Add a configuration below to generate a QR code."
                  : "Click \"Connect\" to generate a new QR code."}
              </p>
              {configs.length > 0 && !isConnecting && !qrCodeDataUrl && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setIsConnecting(true);
                    rpc.connectWhatsApp(configs[0].id).finally(() => setIsConnecting(false));
                  }}
                >
                  Connect
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Existing configurations list */}
      {configs.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium">Configured Channels</h4>
          {configs.map((cfg) => (
            <Card key={cfg.id}>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-block h-2 w-2 rounded-full shrink-0",
                          cfg.enabled ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600",
                        )}
                        aria-hidden="true"
                      />
                      <span className="text-sm font-medium truncate">
                        {projectName(cfg.projectId)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {cfg.enabled ? "Enabled" : "Disabled"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleDelete(cfg.id)}
                      disabled={deletingId === cfg.id}
                      aria-label="Delete this WhatsApp configuration"
                    >
                      {deletingId === cfg.id ? (
                        "..."
                      ) : (
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add new configuration */}
      {showForm ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">New WhatsApp Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <AddConfigForm
              projects={projects}
              onSaved={handleSaved}
              onCancel={handleCancel}
            />
          </CardContent>
        </Card>
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add WhatsApp Configuration
        </Button>
      )}

      {/* Disconnect button — only shown when at least one config exists */}
      {configs.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Danger Zone</h4>
            <p className="text-xs text-muted-foreground">
              Unlinking WhatsApp will remove the session and all associated
              configurations. You will need to scan a new QR code to reconnect.
            </p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDisconnect}
              disabled={isDisconnecting}
              className="mt-2"
            >
              {isDisconnecting ? "Disconnecting..." : "Disconnect WhatsApp"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
