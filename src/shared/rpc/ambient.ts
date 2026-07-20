export interface AmbientDisplayDto {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  isPrimary: boolean;
}

export interface AmbientActivityLogEntry {
  id: string;
  timestamp: number;
  projectId: string;
  /** Raw agent type key (e.g. "code-explorer"), for color-coding. Absent for non-agent entries. */
  agentKey?: string;
  /** Human-readable name to render in the agent's colored badge. */
  agentLabel?: string;
  text: string;
}

export interface AmbientActivitySnapshot {
  activeProjectAgents: Record<string, number>;
  taskStats: Record<string, { done: number; total: number }>;
  projectNames: Record<string, string>;
  awaitingYou: number;
  activityLog: AmbientActivityLogEntry[];
}

export interface AmbientAssistantPartDto {
  id: string;
  messageId: string;
  type: "text" | "tool_call";
  content: string;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  toolState: "running" | "complete" | "error" | null;
  sortOrder: number;
  timeStart: string | null;
  timeEnd: string | null;
}

/**
 * One complete sentence of the ambient assistant's answer, pushed as it
 * streams in — lets the frontend start speaking the answer sentence-by-
 * sentence instead of waiting for the whole response to finish generating
 * (see assistant.ts's handleTextDelta/extractCompleteSentences). Works for
 * any provider/model that streams token-level deltas (both the Claude
 * Subscription CLI path and the regular streamText path do); a provider
 * that doesn't stream simply never fires this, and the caller falls back to
 * speaking the final answer text directly once the turn completes.
 */
export interface AmbientAssistantTextChunkDto {
  messageId: string;
  chunk: string;
}

export type AmbientLocalVoiceStatus = "not_downloaded" | "downloading" | "ready" | "error";

export interface AmbientLocalVoiceStatusDto {
  status: AmbientLocalVoiceStatus;
  progress: number | null;
  sizeMb: number;
}

export type AmbientLocalSttStatus = "not_downloaded" | "downloading" | "ready" | "error";

export interface AmbientLocalSttStatusDto {
  status: AmbientLocalSttStatus;
  progress: number | null;
  sizeMb: number;
}

export interface AmbientSttSegmentDto {
  text: string;
  /**
   * True audio-domain silence gap (ms) between this segment's VAD-detected
   * start and the previous segment's end, computed from sample counts on the
   * backend — immune to Whisper decode latency (1-10s in practice), unlike
   * timing the gap between when decoded text arrives at the frontend. Null
   * for the first segment of a listening session (no previous segment to
   * compare against). See use-local-stt-turn.ts's merge logic.
   */
  silenceBeforeMs: number | null;
}

export type AmbientRequests = {
  getAmbientDisplays: {
    params: Record<string, never>;
    response: AmbientDisplayDto[];
  };
  openAmbientDisplayWindow: {
    params: { displayId: number };
    response: { success: boolean; error?: string };
  };
  closeAmbientDisplayWindow: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  getAmbientActivitySnapshot: {
    params: Record<string, never>;
    response: AmbientActivitySnapshot;
  };
  getAmbientProjectionState: {
    params: Record<string, never>;
    response: { projecting: boolean };
  };
  runAmbientAssistantQuery: {
    params: { question: string; turnId: string };
    response: { answer: string };
  };
  cancelAmbientAssistantTurn: {
    params: { turnId: string };
    response: { success: boolean };
  };
  generateAmbientSpeech: {
    params: { providerId: string; modelId: string; text: string; speed?: number };
    response: { base64: string; mimeType: string };
  };
  getAmbientLocalVoiceStatus: {
    params: Record<string, never>;
    response: AmbientLocalVoiceStatusDto;
  };
  downloadAmbientLocalVoice: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  preloadAmbientLocalVoice: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  getAmbientLocalSttStatus: {
    params: Record<string, never>;
    response: AmbientLocalSttStatusDto;
  };
  downloadAmbientLocalStt: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  startAmbientLocalListening: {
    params: Record<string, never>;
    response: { success: boolean; error?: string };
  };
  stopAmbientLocalListening: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  logAmbientDebug: {
    params: { message: string };
    response: { success: boolean };
  };
};
