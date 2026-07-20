import { useState, useEffect } from "react";
import { rpc } from "@/lib/rpc";

export interface AmbientSettings {
  enabled: boolean;
  idleMinutes: number;
  voiceEnabled: boolean;
  ttsEnabled: boolean;
  /** null = use the default browser speechSynthesis voice. */
  ttsProviderId: string | null;
  ttsModelId: string | null;
  /** 1.0 = normal speed. Honored by the browser voice (rate), the offline Ryan voice, and real speech-model voices. */
  ttsSpeed: number;
  /** null = use the default Web Speech API path. "local" = offline VAD+Whisper pipeline (see local-stt-manager.ts). */
  sttProviderId: string | null;
}

const DEFAULTS: AmbientSettings = {
  enabled: true,
  idleMinutes: 15,
  voiceEnabled: true,
  ttsEnabled: true,
  ttsProviderId: null,
  ttsModelId: null,
  ttsSpeed: 1.0,
  sttProviderId: null,
};

function toBool(v: unknown, fallback: boolean): boolean {
  return v !== undefined ? v !== false && v !== "false" : fallback;
}

/**
 * Loads Ambient Mode's settings once, then stays live via the same-window
 * "agentdesk:ambient-settings-changed" event general.tsx's Settings page
 * dispatches right after a successful save (mirrors appearance.tsx's
 * sidebar-default-changed pattern) — the backend's generic settingsChanged
 * broadcast is never actually fired by any RPC handler, so this event is the
 * real source of truth for same-session live updates.
 */
export function useAmbientSettings(): AmbientSettings {
  const [settings, setSettings] = useState<AmbientSettings>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    rpc.getSettings("general").then((s) => {
      if (cancelled) return;
      const data = s as Record<string, unknown>;
      setSettings({
        enabled: toBool(data.ambient_mode_enabled, DEFAULTS.enabled),
        idleMinutes:
          data.ambient_mode_idle_minutes !== undefined && !Number.isNaN(Number(data.ambient_mode_idle_minutes))
            ? Number(data.ambient_mode_idle_minutes)
            : DEFAULTS.idleMinutes,
        voiceEnabled: toBool(data.ambient_mode_voice_enabled, DEFAULTS.voiceEnabled),
        ttsEnabled: toBool(data.ambient_mode_tts_enabled, DEFAULTS.ttsEnabled),
        ttsProviderId: typeof data.ambient_tts_provider_id === "string" && data.ambient_tts_provider_id ? data.ambient_tts_provider_id : DEFAULTS.ttsProviderId,
        ttsModelId: typeof data.ambient_tts_model_id === "string" && data.ambient_tts_model_id ? data.ambient_tts_model_id : DEFAULTS.ttsModelId,
        ttsSpeed: data.ambient_tts_speed !== undefined && !Number.isNaN(Number(data.ambient_tts_speed)) ? Number(data.ambient_tts_speed) : DEFAULTS.ttsSpeed,
        sttProviderId: typeof data.ambient_stt_provider_id === "string" && data.ambient_stt_provider_id ? data.ambient_stt_provider_id : DEFAULTS.sttProviderId,
      });
    }).catch(() => {});

    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<Partial<AmbientSettings>>).detail;
      if (!detail) return;
      setSettings((prev) => ({ ...prev, ...detail }));
    };
    window.addEventListener("agentdesk:ambient-settings-changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("agentdesk:ambient-settings-changed", onChanged);
    };
  }, []);

  return settings;
}
