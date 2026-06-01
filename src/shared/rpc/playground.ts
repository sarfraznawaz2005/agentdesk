// RPC contract for the Playground feature.

export interface PlaygroundServerDto {
  id: string;          // live job id when running; "" when stopped
  label: string;
  command: string;     // used to restart a stopped server
  status: "running" | "stopped";
  pid?: number;
  startedAt?: string;
  elapsedHuman?: string;
}

export interface PlaygroundPreviewDto {
  kind: "static" | "devserver" | "file";
  url: string;
  title: string;
  description?: string;
  createdAt: string;
}

export interface PlaygroundPartDto {
  id: string;
  type: string;
  content: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  toolState?: string;
  sortOrder: number;
  agentName?: string;
  timeStart?: string;
  timeEnd?: string;
}

export interface PlaygroundTokensDto {
  prompt: number;
  completion: number;
  contextLimit?: number;
}

export type PlaygroundRequests = {
  /** Send a message to the Playground Agent and start a run (streams via broadcasts). */
  playgroundSend: {
    params: { message: string; consoleErrors?: string[] };
    response: { ok: boolean; error?: string };
  };
  /** Abort the in-flight playground run. */
  playgroundStop: {
    params: Record<string, never>;
    response: { ok: boolean };
  };
  /** Wipe the playground temp folder + stop its dev servers. */
  newPlayground: {
    params: Record<string, never>;
    response: { ok: boolean };
  };
  /** Snapshot of the current playground (for restoring the page on mount). */
  getPlaygroundState: {
    params: Record<string, never>;
    response: {
      running: boolean;
      hasFiles: boolean;
      preview: PlaygroundPreviewDto | null;
      parts: PlaygroundPartDto[];
      lastStatus: string | null;
      lastSummary: string | null;
      tokens: PlaygroundTokensDto | null;
      error: string | null;
      lastUserMessage: string | null;
      path: string;
      history: { role: "user" | "assistant"; content: string }[];
      deployedUrl: string | null;
    };
  };
  /** Promote the current playground into a real project (AI-named, files copied). */
  createProjectFromPlayground: {
    params: Record<string, never>;
    response: { success: boolean; id?: string; name?: string; error?: string };
  };
  /** Zip the playground files into the OS Downloads folder. */
  exportPlaygroundZip: {
    params: Record<string, never>;
    response: { success: boolean; path?: string; error?: string };
  };
  /** Read the playground's raw text source files (for the "View source" dialog). */
  getPlaygroundSource: {
    params: Record<string, never>;
    response: { files: { path: string; content: string }[] };
  };
  /** Write an edited source file back to the playground directory (triggers hot-reload). */
  savePlaygroundFile: {
    params: { path: string; content: string };
    response: { success: boolean; error?: string };
  };
  /** Update the current preview's URL (persists to preview.json so it survives a restart). */
  setPlaygroundPreviewUrl: {
    params: { url: string };
    response: { success: boolean; preview?: PlaygroundPreviewDto; error?: string };
  };
  /** List background dev servers currently running inside the playground temp folder. */
  getPlaygroundDevServers: {
    params: Record<string, never>;
    response: { servers: PlaygroundServerDto[] };
  };
  /** Stop a specific playground dev server by job id. */
  stopPlaygroundDevServer: {
    params: { jobId: string };
    response: { ok: boolean };
  };
  /** Restart a stopped playground dev server by its command (re-runs it). */
  startPlaygroundDevServer: {
    params: { command: string };
    response: { ok: boolean; error?: string };
  };
  /** Deploy the current static playground to surge.sh and return the live URL. */
  deployPlayground: {
    params: Record<string, never>;
    response: { success: boolean; url?: string; error?: string };
  };
};
