import { useState, useEffect, useCallback } from "react";
import { Download, Trash2, CheckCircle2, AlertCircle } from "lucide-react";
import { rpc } from "@/lib/rpc";
import type { AmbientLocalVoiceStatusDto, AmbientLocalSttStatusDto } from "../../../shared/rpc/ambient";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LocalVoiceLiveProgress = { status: "downloading" | "ready" | "error"; progress?: number; message?: string };
const LOCAL_VOICE_VALUE = "local|piper-ryan-high";

interface AmbientSettingsState {
  ambientModeEnabled: boolean;
  ambientModeIdleMinutes: number;
  ambientModeVoiceEnabled: boolean;
  ambientModeTtsEnabled: boolean;
  /** null = use the default browser speechSynthesis voice (zero-config). Combined key so a model id, which isn't globally unique, resolves to one specific provider. */
  ambientTtsProviderId: string | null;
  ambientTtsModelId: string | null;
  /** 1.0 = normal speed. Honored by the browser voice, the offline Ryan voice, and real speech-model voices — all three currently support a speed multiplier. */
  ambientTtsSpeed: number;
  /** null = use the default Web Speech API path. "local" = offline VAD+Whisper pipeline (see local-stt-manager.ts). No per-model catalog needed — unlike TTS, there's only ever the one bundled local model. */
  ambientSttProviderId: string | null;
}

const DEFAULTS: AmbientSettingsState = {
  ambientModeEnabled: true,
  ambientModeIdleMinutes: 15,
  ambientModeVoiceEnabled: true,
  ambientModeTtsEnabled: true,
  ambientTtsProviderId: null,
  ambientTtsModelId: null,
  ambientTtsSpeed: 1.0,
  ambientSttProviderId: null,
};

// ---------------------------------------------------------------------------
// FieldRow — label + control in a two-column layout (mirrors general.tsx's
// own copy; kept page-local rather than a shared module for two settings
// pages using a ~12-line presentational helper).
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
      <div className="ml-auto w-full max-w-xs">{children}</div>
    </div>
  );
}

// The offline "Ryan" voice's / local STT pipeline's engine + model are
// downloaded on demand (never bundled — see local-voice-manager.ts /
// local-stt-manager.ts) so this card mirrors Collections' embedding-model
// download UI (settings-tab.tsx): a status pill, a progress bar while
// downloading, and a Download/Re-download button. Shared by both the Voice
// and Speech input pickers below.
function LocalDownloadPanel({
  status,
  live,
  onDownload,
  onDelete,
}: {
  status: AmbientLocalVoiceStatusDto | AmbientLocalSttStatusDto | null;
  live: LocalVoiceLiveProgress | null;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const effectiveStatus = live?.status === "downloading" ? "downloading" : status?.status ?? "not_downloaded";
  const progress = live?.status === "downloading" ? live.progress ?? 0 : status?.progress ?? 0;
  const isBusy = effectiveStatus === "downloading";

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{status ? `~${status.sizeMb} MB` : "…"}</span>
        {effectiveStatus === "ready" && (
          <span className="inline-flex items-center gap-1.5 font-medium text-green-700 dark:text-green-400">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Ready
          </span>
        )}
        {effectiveStatus === "downloading" && (
          <span className="inline-flex items-center gap-1.5 font-medium text-muted-foreground">
            <Download className="w-3.5 h-3.5 animate-pulse" />
            Downloading
          </span>
        )}
        {effectiveStatus === "error" && (
          <span className="inline-flex items-center gap-1.5 font-medium text-destructive">
            <AlertCircle className="w-3.5 h-3.5" />
            Error
          </span>
        )}
        {effectiveStatus === "not_downloaded" && (
          <span className="font-medium text-muted-foreground">Not downloaded</span>
        )}
      </div>

      {isBusy && (
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground truncate">{live?.message ?? "Downloading…"}</div>
          <div className="w-full bg-muted rounded-full h-1.5">
            <div className="bg-indigo-500 h-1.5 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {effectiveStatus === "error" && live?.message && (
        <div className="text-xs text-destructive">{live.message}</div>
      )}

      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onDownload} disabled={isBusy}>
          <Download className="w-3.5 h-3.5" />
          {effectiveStatus === "ready" ? "Re-download" : effectiveStatus === "downloading" ? "Downloading…" : "Download"}
        </Button>
        {effectiveStatus === "ready" && (
          <Button size="sm" variant="outline" onClick={onDelete}>
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

// Shared by both the Voice and Speech input panels — deleting either just
// frees disk space (both are trivially re-downloadable), so this is
// deliberately lighter-weight than ResetConfirmDialog's project-data-loss
// confirmation (no typing-the-name friction).
function DeleteLocalModelDialog({
  open,
  onOpenChange,
  label,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  label: string;
  onConfirm: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleConfirm() {
    setDeleting(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {label}?</DialogTitle>
          <DialogDescription>
            This removes the downloaded engine and model from disk. You can re-download it again later from this same screen.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={deleting}>
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// AmbientSettings
// ---------------------------------------------------------------------------

export function AmbientSettings() {
  const [settings, setSettings] = useState<AmbientSettingsState>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [speechModels, setSpeechModels] = useState<Array<{ providerId: string; providerName: string; modelId: string }>>([]);
  const [localVoiceStatus, setLocalVoiceStatus] = useState<AmbientLocalVoiceStatusDto | null>(null);
  const [localVoiceLive, setLocalVoiceLive] = useState<LocalVoiceLiveProgress | null>(null);
  const [localSttStatus, setLocalSttStatus] = useState<AmbientLocalSttStatusDto | null>(null);
  const [localSttLive, setLocalSttLive] = useState<LocalVoiceLiveProgress | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<"voice" | "stt" | null>(null);

  // ---- Load settings on mount -----------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        const result = await rpc.getSettings("general");
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: Record<string, any> = result as any ?? {};

        setSettings({
          ambientModeEnabled:
            data.ambient_mode_enabled !== undefined
              ? data.ambient_mode_enabled !== false && data.ambient_mode_enabled !== "false"
              : DEFAULTS.ambientModeEnabled,
          ambientModeIdleMinutes:
            data.ambient_mode_idle_minutes !== undefined && !Number.isNaN(Number(data.ambient_mode_idle_minutes))
              ? Number(data.ambient_mode_idle_minutes)
              : DEFAULTS.ambientModeIdleMinutes,
          ambientModeVoiceEnabled:
            data.ambient_mode_voice_enabled !== undefined
              ? data.ambient_mode_voice_enabled !== false && data.ambient_mode_voice_enabled !== "false"
              : DEFAULTS.ambientModeVoiceEnabled,
          ambientModeTtsEnabled:
            data.ambient_mode_tts_enabled !== undefined
              ? data.ambient_mode_tts_enabled !== false && data.ambient_mode_tts_enabled !== "false"
              : DEFAULTS.ambientModeTtsEnabled,
          ambientTtsProviderId:
            typeof data.ambient_tts_provider_id === "string" && data.ambient_tts_provider_id
              ? data.ambient_tts_provider_id
              : DEFAULTS.ambientTtsProviderId,
          ambientTtsModelId:
            typeof data.ambient_tts_model_id === "string" && data.ambient_tts_model_id
              ? data.ambient_tts_model_id
              : DEFAULTS.ambientTtsModelId,
          ambientTtsSpeed:
            data.ambient_tts_speed !== undefined && !Number.isNaN(Number(data.ambient_tts_speed))
              ? Number(data.ambient_tts_speed)
              : DEFAULTS.ambientTtsSpeed,
          ambientSttProviderId:
            typeof data.ambient_stt_provider_id === "string" && data.ambient_stt_provider_id
              ? data.ambient_stt_provider_id
              : DEFAULTS.ambientSttProviderId,
        });
      } catch {
        if (!cancelled) toast("error", "Failed to load settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Load the TTS voice picker's options -----------------------------------
  // Reuses the same getConnectedProviderModels + getModelTypes RPCs the
  // Settings > AI > Models page already uses for its type badges. Filtered to
  // type === "speech" AND providerType === "openai" — the classification tag
  // alone isn't enough: custom/OpenAI-compatible endpoints can have models
  // whose NAME matches the "speech" heuristic (e.g. a Mistral-compatible
  // "voxtral-mini-tts" model, confirmed live) but @ai-sdk/openai-compatible
  // has no .speech() accessor at all, so generateAmbientSpeech (bun/ambient/
  // tts.ts) could never actually call them — only real, non-custom OpenAI
  // implements ProviderAdapter.generateSpeech today (src/bun/providers/openai.ts).
  useEffect(() => {
    let cancelled = false;
    Promise.all([rpc.getConnectedProviderModels(), rpc.getModelTypes()]).then(([providers, types]) => {
      if (cancelled) return;
      const options: Array<{ providerId: string; providerName: string; modelId: string }> = [];
      for (const p of providers) {
        if (p.providerType !== "openai") continue;
        const providerTypes = types[p.providerId] ?? {};
        for (const modelId of p.models) {
          if (providerTypes[modelId] === "speech") options.push({ providerId: p.providerId, providerName: p.providerName, modelId });
        }
      }
      setSpeechModels(options);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // ---- Offline/local TTS voice (downloaded on demand — see
  // src/bun/ambient/local-voice-manager.ts) -----------------------------------
  // Same dual status/live-progress shape as Collections' embedding model card
  // (settings-tab.tsx): `status` is the polled snapshot, `live` is the
  // broadcast-pushed progress while a download is in flight.
  const refreshLocalVoiceStatus = useCallback(async () => {
    try {
      const result = await rpc.getAmbientLocalVoiceStatus();
      setLocalVoiceStatus(result);
    } catch (err) {
      console.error("Failed to load local voice status:", err);
    }
  }, []);

  useEffect(() => {
    refreshLocalVoiceStatus();
  }, [refreshLocalVoiceStatus]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<LocalVoiceLiveProgress>).detail;
      setLocalVoiceLive(detail);
      if (detail.status === "ready" || detail.status === "error") refreshLocalVoiceStatus();
    };
    window.addEventListener("agentdesk:ambient-local-voice-status", handler);
    return () => window.removeEventListener("agentdesk:ambient-local-voice-status", handler);
  }, [refreshLocalVoiceStatus]);

  const handleDownloadLocalVoice = useCallback(async () => {
    setLocalVoiceLive({ status: "downloading", progress: 0, message: "Starting download…" });
    try {
      const result = await rpc.downloadAmbientLocalVoice();
      if (!result.success) toast("error", "Voice download failed — see Settings for details.");
    } catch (err) {
      console.error("Failed to download local voice:", err);
      toast("error", "Voice download failed.");
    } finally {
      refreshLocalVoiceStatus();
    }
  }, [refreshLocalVoiceStatus]);

  // ---- Offline/local STT pipeline (downloaded on demand — see
  // src/bun/ambient/local-stt-manager.ts) --------------------------------------
  const refreshLocalSttStatus = useCallback(async () => {
    try {
      const result = await rpc.getAmbientLocalSttStatus();
      setLocalSttStatus(result);
    } catch (err) {
      console.error("Failed to load local STT status:", err);
    }
  }, []);

  useEffect(() => {
    refreshLocalSttStatus();
  }, [refreshLocalSttStatus]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<LocalVoiceLiveProgress>).detail;
      setLocalSttLive(detail);
      if (detail.status === "ready" || detail.status === "error") refreshLocalSttStatus();
    };
    window.addEventListener("agentdesk:ambient-local-stt-status", handler);
    return () => window.removeEventListener("agentdesk:ambient-local-stt-status", handler);
  }, [refreshLocalSttStatus]);

  const handleDownloadLocalStt = useCallback(async () => {
    setLocalSttLive({ status: "downloading", progress: 0, message: "Starting download…" });
    try {
      const result = await rpc.downloadAmbientLocalStt();
      if (!result.success) toast("error", "Speech input download failed — see Settings for details.");
    } catch (err) {
      console.error("Failed to download local STT:", err);
      toast("error", "Speech input download failed.");
    } finally {
      refreshLocalSttStatus();
    }
  }, [refreshLocalSttStatus]);

  // ---- Delete (frees disk space for either downloaded pipeline) -------------

  const handleConfirmDelete = useCallback(async () => {
    const target = deleteTarget;
    if (!target) return;
    try {
      const result = target === "voice" ? await rpc.deleteAmbientLocalVoice() : await rpc.deleteAmbientLocalStt();
      if (!result.success) {
        toast("error", result.error || "Delete failed.");
        return;
      }
      toast("success", target === "voice" ? "Voice model deleted." : "Speech input model deleted.");
    } catch (err) {
      console.error(`Failed to delete local ${target}:`, err);
      toast("error", "Delete failed.");
    } finally {
      if (target === "voice") refreshLocalVoiceStatus();
      else refreshLocalSttStatus();
    }
  }, [deleteTarget, refreshLocalVoiceStatus, refreshLocalSttStatus]);

  // ---- Change helper ---------------------------------------------------------

  const handleChange = useCallback(
    <K extends keyof AmbientSettingsState>(key: K, value: AmbientSettingsState[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
      setDirty(true);
    },
    [],
  );

  // ---- Save -------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!Number.isFinite(settings.ambientModeIdleMinutes) || settings.ambientModeIdleMinutes < 1) {
      toast("error", "Idle timeout must be at least 1 minute.");
      return;
    }
    setSaving(true);
    try {
      await Promise.all([
        rpc.saveSetting("ambient_mode_enabled", settings.ambientModeEnabled, "general"),
        rpc.saveSetting("ambient_mode_idle_minutes", settings.ambientModeIdleMinutes, "general"),
        rpc.saveSetting("ambient_mode_voice_enabled", settings.ambientModeVoiceEnabled, "general"),
        rpc.saveSetting("ambient_mode_tts_enabled", settings.ambientModeTtsEnabled, "general"),
        rpc.saveSetting("ambient_tts_provider_id", settings.ambientTtsProviderId ?? "", "general"),
        rpc.saveSetting("ambient_tts_model_id", settings.ambientTtsModelId ?? "", "general"),
        rpc.saveSetting("ambient_tts_speed", settings.ambientTtsSpeed, "general"),
        rpc.saveSetting("ambient_stt_provider_id", settings.ambientSttProviderId ?? "", "general"),
      ]);
      setDirty(false);
      toast("success", "Settings saved.");
      window.dispatchEvent(new CustomEvent("agentdesk:ambient-settings-changed", {
        detail: {
          enabled: settings.ambientModeEnabled,
          idleMinutes: settings.ambientModeIdleMinutes,
          voiceEnabled: settings.ambientModeVoiceEnabled,
          ttsEnabled: settings.ambientModeTtsEnabled,
          ttsProviderId: settings.ambientTtsProviderId,
          ttsModelId: settings.ambientTtsModelId,
          ttsSpeed: settings.ambientTtsSpeed,
          sttProviderId: settings.ambientSttProviderId,
        },
      }));
    } catch {
      toast("error", "Failed to save settings. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [settings]);

  // ---- Render -----------------------------------------------------------------

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
        <h3 className="text-lg font-semibold text-foreground">Ambient Mode</h3>
        <p className="text-sm text-muted-foreground mt-1">
          A full-screen, voice-interactive view of what your agents are working on.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ambient Mode</CardTitle>
          <CardDescription>
            A full-screen, voice-interactive view of what your agents are working on.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="ambient-mode-enabled-toggle">Auto-activate when idle</Label>
              <p className="text-xs text-muted-foreground">
                Automatically opens Ambient Mode after a period of inactivity, like a screensaver. The Dashboard button always opens it on demand regardless of this setting.
              </p>
            </div>
            <Switch
              id="ambient-mode-enabled-toggle"
              checked={settings.ambientModeEnabled}
              onCheckedChange={(val) => handleChange("ambientModeEnabled", val)}
            />
          </div>

          <Separator />

          <FieldRow
            id="ambient-idle-minutes"
            label="Idle timeout"
            description="Minutes of inactivity (while AgentDesk is focused) before Ambient Mode auto-activates."
          >
            <div className="flex items-center justify-end gap-2">
              <Input
                id="ambient-idle-minutes"
                type="number"
                min={1}
                max={120}
                value={settings.ambientModeIdleMinutes}
                onChange={(e) => handleChange("ambientModeIdleMinutes", Number(e.target.value))}
                disabled={!settings.ambientModeEnabled}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
          </FieldRow>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="ambient-voice-toggle">Voice input</Label>
              <p className="text-xs text-muted-foreground">
                Lets you talk to the PM inside Ambient Mode. The mic stays off until you tap "Talk to PM".
              </p>
            </div>
            <Switch
              id="ambient-voice-toggle"
              checked={settings.ambientModeVoiceEnabled}
              onCheckedChange={(val) => handleChange("ambientModeVoiceEnabled", val)}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="ambient-tts-toggle">Spoken replies</Label>
              <p className="text-xs text-muted-foreground">
                Reads the PM's replies aloud inside Ambient Mode.
              </p>
            </div>
            <Switch
              id="ambient-tts-toggle"
              checked={settings.ambientModeTtsEnabled}
              onCheckedChange={(val) => handleChange("ambientModeTtsEnabled", val)}
            />
          </div>

          <Separator />

          <FieldRow
            id="ambient-tts-voice"
            label="Voice"
            description="Uses your browser's built-in voice by default. Pick a configured speech model, or the offline Ryan voice, for higher-quality audio instead."
          >
            <div className="space-y-2">
              <Select
                value={
                  settings.ambientTtsProviderId && settings.ambientTtsModelId
                    ? `${settings.ambientTtsProviderId}|${settings.ambientTtsModelId}`
                    : "default"
                }
                onValueChange={(val) => {
                  if (val === "default") {
                    handleChange("ambientTtsProviderId", null);
                    handleChange("ambientTtsModelId", null);
                    return;
                  }
                  const [providerId, modelId] = val.split("|");
                  handleChange("ambientTtsProviderId", providerId);
                  handleChange("ambientTtsModelId", modelId);
                }}
                disabled={!settings.ambientModeTtsEnabled}
              >
                <SelectTrigger id="ambient-tts-voice" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default (browser voice)</SelectItem>
                  <SelectItem value={LOCAL_VOICE_VALUE}>Ryan (offline, local)</SelectItem>
                  {speechModels.map((m) => (
                    <SelectItem key={`${m.providerId}|${m.modelId}`} value={`${m.providerId}|${m.modelId}`}>
                      {m.providerName} — {m.modelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {settings.ambientTtsProviderId === "local" && (
                <LocalDownloadPanel
                  status={localVoiceStatus}
                  live={localVoiceLive}
                  onDownload={handleDownloadLocalVoice}
                  onDelete={() => setDeleteTarget("voice")}
                />
              )}
            </div>
          </FieldRow>

          <Separator />

          <FieldRow
            id="ambient-tts-speed"
            label="Speaking speed"
            description="Applies to whichever voice is selected above — the browser voice, offline Ryan, and real speech models all support a speed multiplier."
          >
            <div className="flex items-center gap-3">
              <input
                id="ambient-tts-speed"
                type="range"
                min={0.5}
                max={2}
                step={0.1}
                value={settings.ambientTtsSpeed}
                onChange={(e) => handleChange("ambientTtsSpeed", Number(e.target.value))}
                disabled={!settings.ambientModeTtsEnabled}
                className="flex-1"
              />
              <span className="w-12 text-right text-sm text-muted-foreground tabular-nums">{settings.ambientTtsSpeed.toFixed(1)}x</span>
            </div>
          </FieldRow>

          <Separator />

          <FieldRow
            id="ambient-stt-input"
            label="Speech input"
            description="Uses your browser's built-in recognizer by default. The offline pipeline (continuous listening, no cloud round-trip) gives more reliable turn detection but needs a one-time download."
          >
            <div className="space-y-2">
              <Select
                value={settings.ambientSttProviderId ?? "default"}
                onValueChange={(val) => handleChange("ambientSttProviderId", val === "default" ? null : val)}
                disabled={!settings.ambientModeVoiceEnabled}
              >
                <SelectTrigger id="ambient-stt-input" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default (browser speech recognition)</SelectItem>
                  <SelectItem value="local">Local (offline, continuous listening)</SelectItem>
                </SelectContent>
              </Select>

              {settings.ambientSttProviderId === "local" && (
                <LocalDownloadPanel
                  status={localSttStatus}
                  live={localSttLive}
                  onDownload={handleDownloadLocalStt}
                  onDelete={() => setDeleteTarget("stt")}
                />
              )}
            </div>
          </FieldRow>
        </CardContent>
      </Card>

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

      <DeleteLocalModelDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        label={deleteTarget === "voice" ? "offline voice" : "offline speech input"}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
