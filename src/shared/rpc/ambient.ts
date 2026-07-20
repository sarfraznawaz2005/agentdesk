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

export type AmbientLocalVoiceStatus = "not_downloaded" | "downloading" | "ready" | "error";

export interface AmbientLocalVoiceStatusDto {
  status: AmbientLocalVoiceStatus;
  progress: number | null;
  sizeMb: number;
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
    params: { providerId: string; modelId: string; text: string };
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
  logAmbientDebug: {
    params: { message: string };
    response: { success: boolean };
  };
};
