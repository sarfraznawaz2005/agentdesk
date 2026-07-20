/**
 * Typed RPC client wrapper for the browser (Electroview) side.
 *
 * This module initialises the Electroview RPC instance, registers the
 * webview-side request and message handlers, and re-exports typed
 * convenience wrappers so the rest of the renderer never has to touch raw
 * RPC primitives directly.
 *
 * Custom DOM events dispatched here:
 *   - "agentdesk:navigate"        { detail: { route: string } }
 *   - "agentdesk:show-toast"      { detail: { type, message } }
 *   - "agentdesk:settings-changed"{ detail: { key, value } }
 */

import { Electroview } from "electrobun/view";
import type { AgentDeskRPC } from "../../shared/rpc";
import type { IssueFixerConfigDto } from "../../shared/rpc/issue-fixer";
import type { RemoteSyncConfigInput } from "../../shared/rpc/remote-sync";
import { IS_REMOTE, IS_DEV_DIRECT, createRemoteRpcTransport, createDevRpcTransport } from "./remote-transport";

// ---------------------------------------------------------------------------
// Webview-side RPC definition
// ---------------------------------------------------------------------------
// defineRPC on the webview side means:
//   - handlers.requests  → handles *incoming* requests from bun (webview schema)
//   - handlers.messages  → handles *incoming* messages from bun (webview schema)
//   - rpc.request.*      → calls bun-side request handlers (bun schema)
//   - rpc.send.*         → fires fire-and-forget messages to bun (bun schema)

const electrobunRpc = Electroview.defineRPC<AgentDeskRPC>({
  // Agent operations can take several minutes — disable the 1 s default timeout.
  maxRequestTime: Infinity,
  handlers: {
    requests: {
      /**
       * Return the current client-side route so bun can query it.
       * We use window.location.hash as the SPA router identifier.
       * If the hash is empty the root route "/" is returned.
       */
      getViewState: (_params) => {
        const route = window.location.hash
          ? window.location.hash.replace(/^#/, "") || "/"
          : "/";
        return { route };
      },
    },
    messages: {
      /**
       * Bun wants the renderer to navigate to a different route.
       * Dispatch a DOM event that the router / any listener can act on.
       */
      navigateTo: ({ route }) => {
        window.dispatchEvent(
          new CustomEvent("agentdesk:navigate", { detail: { route } }),
        );
      },

      /**
       * Bun wants to surface a transient notification.
       * Dispatch a DOM event that the toast component listens for.
       */
      showToast: ({ type, message }) => {
        window.dispatchEvent(
          new CustomEvent("agentdesk:show-toast", {
            detail: { type, message },
          }),
        );
      },

      /**
       * A setting was changed from the bun side (e.g. from another window or
       * a background task). Dispatch a DOM event so any reactive UI that cares
       * about that key can refresh itself.
       */
      settingsChanged: ({ key, value }) => {
        window.dispatchEvent(
          new CustomEvent("agentdesk:settings-changed", {
            detail: { key, value },
          }),
        );
      },
      streamToken: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:stream-token", { detail: payload }));
      },
      streamReset: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:stream-reset", { detail: payload }));
      },
      streamComplete: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:stream-complete", { detail: payload }));
      },
      streamError: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:stream-error", { detail: payload }));
      },
      agentStatus: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:agent-status", { detail: payload }));
      },
      partCreated: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:part-created", { detail: payload }));
      },
      partUpdated: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:part-updated", { detail: payload }));
      },
      agentInlineStart: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:agent-inline-start", { detail: payload }));
      },
      agentInlineComplete: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:agent-inline-complete", { detail: payload }));
      },
      contextUsage: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:context-usage", { detail: payload }));
      },
      streamPerformance: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:stream-performance", { detail: payload }));
      },
      presentPlan: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:plan-presented", { detail: payload }));
      },
      kanbanTaskUpdated: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:kanban-task-updated", { detail: payload }));
      },
      ambientAssistantPart: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:ambient-assistant-part", { detail: payload }));
      },
      ambientAssistantTextChunk: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:ambient-assistant-text-chunk", { detail: payload }));
      },
      agentSessionComplete: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:agent-session-complete", { detail: payload }));
      },
      messageQueueUpdated: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:message-queue-updated", { detail: payload }));
      },
      providerTestResult: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:provider-test-result", { detail: payload }));
      },
      providersChanged: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:providers-changed", { detail: payload }));
      },
      modelPreferencesChanged: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:model-preferences-changed", { detail: payload }));
      },
      directorySelected: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:directory-selected", { detail: payload }));
      },
      collectionAttachmentFilePicked: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:collection-attachment-file-picked", { detail: payload }));
      },
      collectionEmbeddingModelStatus: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:collection-embedding-model-status", { detail: payload }));
      },
      ambientLocalVoiceStatus: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:ambient-local-voice-status", { detail: payload }));
      },
      ambientLocalSttStatus: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:ambient-local-stt-status", { detail: payload }));
      },
      ambientSttSegmentStart: () => {
        window.dispatchEvent(new CustomEvent("agentdesk:ambient-stt-segment-start"));
      },
      ambientSttSegment: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:ambient-stt-segment", { detail: payload }));
      },
      shellApprovalRequest: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:shell-approval-request", { detail: payload }));
      },
      shellApprovalExpired: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:shell-approval-expired", { detail: payload }));
      },
      userQuestionRequest: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:user-question-request", { detail: payload }));
      },
      userQuestionCancel: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:user-question-cancel", { detail: payload }));
      },
      whatsappQR: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:whatsapp-qr", { detail: payload }));
      },
      whatsappStatus: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:whatsapp-status", { detail: payload }));
      },
      inboxMessageReceived: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:inbox-message-received", { detail: payload }));
      },
      inboxResponseUpdated: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:inbox-response-updated", { detail: payload }));
      },
      cronJobRunStateChanged: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:cron-run-state-changed", { detail: payload }));
      },
      schedulerInboxRunState: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:scheduler-inbox-run-state", { detail: payload }));
      },
      conversationTitleChanged: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:conversation-title-changed", { detail: payload }));
      },
      conversationUpdated: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:conversation-updated", { detail: payload }));
      },
      switchToConversation: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:switch-to-conversation", { detail: payload }));
      },
      compactionStarted: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:compaction-started", { detail: payload }));
      },
      conversationCompacted: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:conversation-compacted", { detail: payload }));
      },
      newMessage: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:new-message", { detail: payload }));
      },
      pmThinking: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:pm-thinking", { detail: payload }));
      },
      pmActivity: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:pm-activity", { detail: payload }));
      },
      dashboardPMChunk: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:dashboard-pm-chunk", { detail: payload }));
      },
      dashboardPMComplete: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:dashboard-pm-complete", { detail: payload }));
      },
      dashboardPMToolCall: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:dashboard-pm-tool-call", { detail: payload }));
      },
      dashboardPMToolResult: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:dashboard-pm-tool-result", { detail: payload }));
      },
      dashboardPMError: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:dashboard-pm-error", { detail: payload }));
      },
      collectionsChatChunk: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:collections-chat-chunk", { detail: payload }));
      },
      collectionsChatComplete: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:collections-chat-complete", { detail: payload }));
      },
      collectionsChatToolCall: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:collections-chat-tool-call", { detail: payload }));
      },
      collectionsChatError: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:collections-chat-error", { detail: payload }));
      },
      dashboardAgentChunk: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:dashboard-agent-chunk", { detail: payload }));
      },
      dashboardAgentComplete: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:dashboard-agent-complete", { detail: payload }));
      },
      dashboardAgentToolCall: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:dashboard-agent-tool-call", { detail: payload }));
      },
      dashboardAgentToolResult: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:dashboard-agent-tool-result", { detail: payload }));
      },
      dashboardAgentError: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:dashboard-agent-error", { detail: payload }));
      },
      councilEvent: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:council-event", { detail: payload }));
      },
      playgroundRunStarted: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-run-started", { detail: payload }));
      },
      playgroundPart: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-part", { detail: payload }));
      },
      playgroundPartUpdated: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-part-updated", { detail: payload }));
      },
      playgroundPartsRemoved: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-parts-removed", { detail: payload }));
      },
      playgroundAgentStart: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-agent-start", { detail: payload }));
      },
      playgroundAgentComplete: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-agent-complete", { detail: payload }));
      },
      playgroundRunComplete: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-run-complete", { detail: payload }));
      },
      playgroundRunError: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-run-error", { detail: payload }));
      },
      playgroundPreviewReady: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-preview-ready", { detail: payload }));
      },
      playgroundRejected: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-rejected", { detail: payload }));
      },
      playgroundReset: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-reset", { detail: payload }));
      },
      playgroundFilesChanged: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:playground-files-changed", { detail: payload }));
      },
      issueFixerRunStarted: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:issuefixer-run-started", { detail: payload }));
      },
      issueFixerPart: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:issuefixer-part", { detail: payload }));
      },
      issueFixerPartUpdated: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:issuefixer-part-updated", { detail: payload }));
      },
      issueFixerRunComplete: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:issuefixer-run-complete", { detail: payload }));
      },
      issueFixerRunError: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:issuefixer-run-error", { detail: payload }));
      },
      remoteSyncRunStarted: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:remotesync-run-started", { detail: payload }));
      },
      remoteSyncProgress: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:remotesync-progress", { detail: payload }));
      },
      remoteSyncRunComplete: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:remotesync-run-complete", { detail: payload }));
      },
      remoteSyncRunError: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:remotesync-run-error", { detail: payload }));
      },
      remoteSyncLog: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:remotesync-log", { detail: payload }));
      },
      activityUpdated: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:activity-updated", { detail: payload }));
      },
      projectsUpdated: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:projects-updated", { detail: payload }));
      },
      recommendationStatusChanged: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:recommendation-status-changed", { detail: payload }));
      },
      updateStatus: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:update-status", { detail: payload }));
      },
      maintenance: (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:maintenance", { detail: payload }));
      },
      "freelance.fetchStarted": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-fetch-started", { detail: payload }));
      },
      "freelance.listingsUpdated": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-listings-updated", { detail: payload }));
      },
      "freelance.inbox.updated": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-inbox-updated", { detail: payload }));
      },
      "freelance.inbox.newMessage": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-inbox-new-message", { detail: payload }));
      },
      "freelance.outbox.updated": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-outbox-updated", { detail: payload }));
      },
      "freelance.governor.blocked": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-governor-blocked", { detail: payload }));
      },
      "freelance.account.statusChanged": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-account-status-changed", { detail: payload }));
      },
      "freelance.escalation.created": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-escalation-created", { detail: payload }));
      },
      "freelance.escalation.resolved": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-escalation-resolved", { detail: payload }));
      },
      "freelance.job.updated": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-job-updated", { detail: payload }));
      },
      "freelance.chat.fetching": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-chat-fetching", { detail: payload }));
      },
      "freelance.chat.fetch_done": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-chat-fetch-done", { detail: payload }));
      },
      "freelance.chat.tool_start": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-chat-tool-start", { detail: payload }));
      },
      "freelance.chat.tool_done": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-chat-tool-done", { detail: payload }));
      },
      "freelance.chat.token": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-chat-token", { detail: payload }));
      },
      "freelance.chat.complete": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-chat-complete", { detail: payload }));
      },
      "freelance.chat.error": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-chat-error", { detail: payload }));
      },
      "freelance.chat.stopped": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-chat-stopped", { detail: payload }));
      },
      "skillsChat.toolStart": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:skills-chat-tool-start", { detail: payload }));
      },
      "skillsChat.toolDone": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:skills-chat-tool-done", { detail: payload }));
      },
      "skillsChat.token": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:skills-chat-token", { detail: payload }));
      },
      "skillsChat.complete": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:skills-chat-complete", { detail: payload }));
      },
      "skillsChat.error": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:skills-chat-error", { detail: payload }));
      },
      "skillsChat.stopped": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:skills-chat-stopped", { detail: payload }));
      },
      "skillsChat.registryRefreshed": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:skills-chat-registry-refreshed", { detail: payload }));
      },
      "freelance.wizard.progress": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-wizard-progress", { detail: payload }));
      },
      "freelance.wizard.complete": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-wizard-complete", { detail: payload }));
      },
      "freelance.wizard.error": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-wizard-error", { detail: payload }));
      },
      "freelance.wizard.stopped": (payload) => {
        window.dispatchEvent(new CustomEvent("agentdesk:freelance-wizard-stopped", { detail: payload }));
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Electroview instance
// ---------------------------------------------------------------------------
// This wires up the WebSocket connection to bun and attaches the RPC
// transport. Everything else in the renderer communicates via `rpc` below.

// Transport selection (TASK-479). In a plain browser there is no Electroview
// bridge, so we back the SAME `.request`/`.send` surface with the WS-RPC client
// (src/shared/remote/ws-rpc-client.ts) and re-emit broadcasts as agentdesk:*
// DOM events. In Electrobun (IS_REMOTE === false) this is byte-for-byte the
// previous behavior: electroviewRpc === the defineRPC result, and Electroview is
// instantiated exactly as before.
export const electroview = IS_REMOTE ? null : new Electroview({ rpc: electrobunRpc });

const electroviewRpc: typeof electrobunRpc = IS_REMOTE
  ? ((IS_DEV_DIRECT ? createDevRpcTransport() : createRemoteRpcTransport()) as unknown as typeof electrobunRpc)
  : electrobunRpc;

// ---------------------------------------------------------------------------
// Typed convenience wrappers
// ---------------------------------------------------------------------------
// One thin layer so callers don't need to remember param shapes and never
// import electroviewRpc directly. All methods return the same Promise that
// the underlying rpc.request / rpc.send returns.

export const rpc = {
  // ---- Settings ------------------------------------------------------------

  /** Fetch all settings, optionally filtered by category. */
  getSettings: (category?: string) =>
    electroviewRpc.request.getSettings({ category }),

  // ---- Remote Access (web app) --------------------------------------------

  /** Remote-access status (enabled, connected, relay configured, device count). */
  getRemoteAccessStatus: () => electroviewRpc.request.getRemoteAccessStatus({}),
  /** Turn remote access on/off (starts/stops the relay session). */
  setRemoteAccessEnabled: (enabled: boolean) =>
    electroviewRpc.request.setRemoteAccessEnabled({ enabled }),
  /** Create a new device pairing and return the QR contents. */
  createDevicePairing: (name?: string) =>
    electroviewRpc.request.createDevicePairing({ name }),
  /** List paired devices. */
  listPairedDevices: () => electroviewRpc.request.listPairedDevices({}),
  /** Rename a paired device. */
  renameRemoteDevice: (id: string, name: string) =>
    electroviewRpc.request.renameDevice({ id, name }),
  /** Revoke a paired device. */
  revokeRemoteDevice: (id: string) =>
    electroviewRpc.request.revokeDevice({ id }),
  /** Permanently remove a paired device from the list. */
  deleteRemoteDevice: (id: string) =>
    electroviewRpc.request.deleteDevice({ id }),

  // ---- Ambient Mode — "Project to display" --------------------------------

  /** List connected displays (for the "Project to display" picker). */
  getAmbientDisplays: () => electroviewRpc.request.getAmbientDisplays({}),
  /** Open Ambient Mode full-screen on the given display. */
  openAmbientDisplayWindow: (displayId: number) =>
    electroviewRpc.request.openAmbientDisplayWindow({ displayId }),
  /** Close the projected display window, if one is open. */
  closeAmbientDisplayWindow: () => electroviewRpc.request.closeAmbientDisplayWindow({}),
  /** Polled snapshot of cross-project activity — used by the projected display window. */
  getAmbientActivitySnapshot: () => electroviewRpc.request.getAmbientActivitySnapshot({}),
  /** Ground truth for whether a projected display window is open — the main overlay polls this since the projected window can be closed via its own Exit button too. */
  getAmbientProjectionState: () => electroviewRpc.request.getAmbientProjectionState({}),
  /** Ambient Mode's cross-project voice-assistant turn — one question in, one final answer out. Tool-call progress streams separately via the "ambientAssistantPart" push event. `turnId` lets a later barge-in cancel this specific turn via cancelAmbientAssistantTurn. */
  runAmbientAssistantQuery: (question: string, turnId: string) => electroviewRpc.request.runAmbientAssistantQuery({ question, turnId }),
  /** Cancels a still-in-flight ambient turn by its turnId — a no-op if it already finished. */
  cancelAmbientAssistantTurn: (turnId: string) => electroviewRpc.request.cancelAmbientAssistantTurn({ turnId }),
  /** Generate speech audio from an alternate TTS model — Ambient Mode's configurable-voice setting. `speed` is a 1.0=normal multiplier. */
  generateAmbientSpeech: (providerId: string, modelId: string, text: string, speed?: number) =>
    electroviewRpc.request.generateAmbientSpeech({ providerId, modelId, text, speed }),
  /** Status of Ambient Mode's offline/local TTS voice (downloaded on demand). */
  getAmbientLocalVoiceStatus: () => electroviewRpc.request.getAmbientLocalVoiceStatus({}),
  /** Downloads the offline/local TTS voice's engine + model. Resolves once fully downloaded and verified; incremental progress arrives via ambientLocalVoiceStatus events. */
  downloadAmbientLocalVoice: () => electroviewRpc.request.downloadAmbientLocalVoice({}),
  /** Best-effort warmup of the offline voice's onnxruntime session — call once when Ambient Mode opens. */
  preloadAmbientLocalVoice: () => electroviewRpc.request.preloadAmbientLocalVoice({}),
  /** Relays an [ambient] debug log line to the backend's ambient.log — the webview has no direct filesystem access. Use lib/log-ambient.ts's logAmbient() instead of calling this directly. */
  logAmbientDebug: (message: string) => electroviewRpc.request.logAmbientDebug({ message }),
  /** Status of Ambient Mode's offline/local STT pipeline (downloaded on demand). */
  getAmbientLocalSttStatus: () => electroviewRpc.request.getAmbientLocalSttStatus({}),
  /** Downloads the offline/local STT pipeline's mic-capture library + engine + VAD + ASR model. Resolves once fully downloaded and verified; incremental progress arrives via ambientLocalSttStatus events. */
  downloadAmbientLocalStt: () => electroviewRpc.request.downloadAmbientLocalStt({}),
  /** Starts continuous native mic capture for the local STT pipeline — each detected utterance streams out via the ambientSttSegment push event. Idempotent. */
  startAmbientLocalListening: () => electroviewRpc.request.startAmbientLocalListening({}),
  /** Stops the continuous local mic capture started by startAmbientLocalListening. */
  stopAmbientLocalListening: () => electroviewRpc.request.stopAmbientLocalListening({}),

  /** Fetch a single setting by key. */
  getSetting: (key: string, category?: string) =>
    electroviewRpc.request.getSetting({ key, category }),

  /** Persist a single setting value. */
  saveSetting: (key: string, value: unknown, category: string) =>
    electroviewRpc.request.saveSetting({ key, value, category }),

  // ---- AI Providers --------------------------------------------------------

  /** Fetch all configured AI providers. */
  getProviders: () => electroviewRpc.request.getProviders({}),

  /** Create or update an AI provider. Omit `id` to create a new one. */
  saveProvider: (params: {
    id?: string;
    name: string;
    providerType: string;
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
    isDefault?: boolean;
  }) => electroviewRpc.request.saveProvider(params),

  /** Validate that a provider's credentials / endpoint are reachable. */
  testProvider: (id: string) =>
    electroviewRpc.request.testProvider({ id }),

  /** Fetch the stored API key for a provider (used in the edit dialog). */
  getProviderApiKey: (id: string) =>
    electroviewRpc.request.getProviderApiKey({ id }),

  /** Run a real testConnection() with raw credentials (used by Add/Edit dialog). */
  testProviderWithCredentials: (params: { providerType: string; apiKey: string; baseUrl?: string; defaultModel?: string }) =>
    electroviewRpc.request.testProviderWithCredentials(params),

  /** Test one specific model of a saved provider (Models tab's per-row Test Connection icon). */
  testProviderModel: (params: { providerId: string; modelId: string }) =>
    electroviewRpc.request.testProviderModel(params),

  /** List available models from a provider (without saving). */
  listProviderModels: (params: {
    providerType: string;
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
  }) => electroviewRpc.request.listProviderModels(params),

  /** List available models for an existing saved provider (uses stored API key). */
  listProviderModelsById: (providerId: string) =>
    electroviewRpc.request.listProviderModelsById({ providerId }),

  /** Remove an AI provider by id. */
  deleteProvider: (id: string) =>
    electroviewRpc.request.deleteProvider({ id }),

  /** Fetch models for all connected providers (grouped by provider). */
  getConnectedProviderModels: () =>
    electroviewRpc.request.getConnectedProviderModels({}),

  /** Fetch model-type badges for every connected provider's models (cached; see model-classification.ts). */
  getModelTypes: () => electroviewRpc.request.getModelTypes({}),

  /** Check if the Claude Subscription provider type is enabled (requires 'claude' flag file). */
  getClaudeSubscriptionEnabled: () =>
    electroviewRpc.request.getClaudeSubscriptionEnabled({}),

  /** Check whether a model supports the tool_choice parameter (OpenRouter only). */
  checkModelToolSupport: (params: { providerType: string; apiKey?: string; providerId?: string; modelId: string }) =>
    electroviewRpc.request.checkModelToolSupport(params),

  /** Fetch all per-model preferences (enabled/favourite/last-used), global app-wide. */
  getModelPreferences: () => electroviewRpc.request.getModelPreferences({}),

  /** Enable or disable a model in the chat picker. */
  setModelEnabled: (providerId: string, modelId: string, enabled: boolean) =>
    electroviewRpc.request.setModelEnabled({ providerId, modelId, enabled }),

  /** Enable or disable every given model of a provider at once. */
  setModelsEnabled: (providerId: string, modelIds: string[], enabled: boolean) =>
    electroviewRpc.request.setModelsEnabled({ providerId, modelIds, enabled }),

  /** Mark or unmark a model as a favourite. */
  setModelFavorite: (providerId: string, modelId: string, favorite: boolean) =>
    electroviewRpc.request.setModelFavorite({ providerId, modelId, favorite }),

  /** Stamp a model as just-used (floats it to the top of Latest). */
  recordModelUsage: (providerId: string, modelId: string) =>
    electroviewRpc.request.recordModelUsage({ providerId, modelId }),

  // ---- Projects ------------------------------------------------------------

  /** Fetch all projects. */
  getProjects: () => electroviewRpc.request.getProjects({}),

  /** Create a new project. */
  createProject: (params: {
    name: string;
    description?: string;
    workspacePath: string;
    githubUrl?: string;
    workingBranch?: string;
  }) => electroviewRpc.request.createProject(params),

  /** Delete a project by id. */
  deleteProject: (id: string) =>
    electroviewRpc.request.deleteProject({ id }),

  /** Fetch a single project by id. */
  getProject: (id: string) =>
    electroviewRpc.request.getProject({ id }),

  /** Update mutable fields on a project. */
  updateProject: (params: {
    id: string;
    name?: string;
    description?: string;
    status?: string;
    workspacePath?: string;
    githubUrl?: string;
    workingBranch?: string;
  }) => electroviewRpc.request.updateProject(params),

  /** Whether the project's workspace already contains a `.git` directory. */
  getProjectRepoState: (projectId: string) =>
    electroviewRpc.request.getProjectRepoState({ projectId }),

  /** Clone the project's configured GitHub URL into its (empty) workspace path. */
  cloneProjectRepo: (projectId: string) =>
    electroviewRpc.request.cloneProjectRepo({ projectId }),

  /** Open (or reuse) a Quick Chat project for an existing folder; always returns a fresh conversation. */
  openQuickChatForPath: (workspacePath: string) =>
    electroviewRpc.request.openQuickChatForPath({ workspacePath }),

  /** Open (or focus) a Quick Chat window rooted at the OS Documents folder — the in-app "Open Quick Chat" entry point. */
  openQuickChatDefault: () =>
    electroviewRpc.request.openQuickChatDefault({}),

  /** Promote a Quick Chat project to a normal, visible project (no file copy). */
  promoteQuickChatProject: (projectId: string) =>
    electroviewRpc.request.promoteQuickChatProject({ projectId }),

  /** Pull-based fallback: ask what Quick Chat route this window (by its own window.__electrobunWindowId) was opened for; null for a non-Quick-Chat window. */
  getQuickChatRoute: (windowId: number) =>
    electroviewRpc.request.getQuickChatRoute({ windowId }),

  /** Cascade-delete a project and all its data. */
  deleteProjectCascade: (id: string) =>
    electroviewRpc.request.deleteProjectCascade({ id }),

  /** Permanently hard-delete a soft-deleted project (blocks if workspace folder still exists). */
  permanentDeleteProject: (id: string) =>
    electroviewRpc.request.permanentDeleteProject({ id }),

  /** Reset all project data without deleting the project itself. */
  resetProjectData: (id: string) =>
    electroviewRpc.request.resetProjectData({ id }),

  /** Persist a project-scoped setting. */
  saveProjectSetting: (projectId: string, key: string, value: string) =>
    electroviewRpc.request.saveProjectSetting({ projectId, key, value }),

  /** Fetch all settings for a project as a flat key/value map. */
  getProjectSettings: (projectId: string) =>
    electroviewRpc.request.getProjectSettings({ projectId }),

  /** List immediate contents of a workspace directory (lazy, one level at a time). */
  listWorkspaceFiles: (projectId: string, subPath?: string) =>
    electroviewRpc.request.listWorkspaceFiles({ projectId, subPath }),

  /** Read the text content of a single workspace file (path relative to workspace root). */
  readWorkspaceFile: (projectId: string, filePath: string) =>
    electroviewRpc.request.readWorkspaceFile({ projectId, filePath }),

  /** Read an image file as base64 (for previewing binary image assets). */
  readWorkspaceImageFile: (projectId: string, filePath: string) =>
    electroviewRpc.request.readWorkspaceImageFile({ projectId, filePath }),

  /** Scan the global workspace path and register any new subdirectories as projects. */
  syncWorkspaceFolders: () => electroviewRpc.request.syncWorkspaceFolders({}),

  // ---- System --------------------------------------------------------------

  /** Open a native OS directory picker and return the chosen path. */
  selectDirectory: () => electroviewRpc.request.selectDirectory({}),

  /** Return basic app metadata (version, platform, data directory). */
  getAppInfo: () => electroviewRpc.request.getAppInfo({}),

  /** Probe real internet connectivity from the Bun process (no CORS restrictions). */
  checkInternet: () => electroviewRpc.request.checkInternet({}),

  /**
   * Return whether this is the first time the app has been launched
   * (i.e. no providers exist in the database yet).
   */
  isFirstLaunch: () => electroviewRpc.request.isFirstLaunch({}),
  markOnboardingComplete: () => electroviewRpc.request.markOnboardingComplete({}),

  // ---- Conversations -------------------------------------------------------

  /** Fetch all conversations for a project. */
  getConversations: (projectId: string) =>
    electroviewRpc.request.getConversations({ projectId }),

  /** Create a new conversation, optionally with a title. */
  createConversation: (projectId: string, title?: string) =>
    electroviewRpc.request.createConversation({ projectId, title }),

  /** Delete a conversation by id. */
  deleteConversation: (id: string) =>
    electroviewRpc.request.deleteConversation({ id }),

  /** Clear all messages in a conversation without deleting the conversation. */
  clearConversationMessages: (id: string) =>
    electroviewRpc.request.clearConversationMessages({ id }),

  /** Fetch message parts for a message (inline agent tool calls, text, etc). */
  getMessageParts: (messageId: string) =>
    electroviewRpc.request.getMessageParts({ messageId }),

  /** Delete a single message by ID. */
  deleteMessage: (id: string) =>
    electroviewRpc.request.deleteMessage({ id }),

  /** Branch a conversation by copying messages up to and including the given message. */
  branchConversation: (conversationId: string, upToMessageId: string) =>
    electroviewRpc.request.branchConversation({ conversationId, upToMessageId }),

  /** Rename a conversation. */
  renameConversation: (id: string, title: string) =>
    electroviewRpc.request.renameConversation({ id, title }),

  /** Pin or unpin a conversation. */
  pinConversation: (id: string, pinned: boolean) =>
    electroviewRpc.request.pinConversation({ id, pinned }),

  // ---- Messages ------------------------------------------------------------

  /** Fetch messages for a conversation, with optional pagination. */
  getMessages: (conversationId: string, limit?: number, before?: string) =>
    electroviewRpc.request.getMessages({ conversationId, limit, before }),

  /** Send a user message and start generation. */
  sendMessage: (projectId: string, conversationId: string, content: string) =>
    electroviewRpc.request.sendMessage({ projectId, conversationId, content }),

  /** Stop the current generation. Pass conversationId to scope the sub-agent
   *  abort to just this conversation — omitting it falls back to aborting
   *  every sub-agent in the project (scheduler runs, other conversations,
   *  review-cycle/issue-fixer agents included), which is almost never what's
   *  actually wanted. */
  stopGeneration: (projectId: string, conversationId?: string) =>
    electroviewRpc.request.stopGeneration({ projectId, conversationId }),

  /** Queue a message server-side for later delivery once this conversation is idle. */
  enqueueMessage: (projectId: string, conversationId: string, content: string) =>
    electroviewRpc.request.enqueueMessage({ projectId, conversationId, content }),
  /** Remove one queued message before it's sent. */
  removeQueuedMessage: (projectId: string, conversationId: string, messageId: string) =>
    electroviewRpc.request.removeQueuedMessage({ projectId, conversationId, messageId }),
  /** Current queue snapshot for a conversation. */
  getQueuedMessages: (projectId: string, conversationId: string) =>
    electroviewRpc.request.getQueuedMessages({ projectId, conversationId }),
  /** Discard every queued message for a conversation (e.g. Stop button). */
  clearQueuedMessages: (projectId: string, conversationId: string) =>
    electroviewRpc.request.clearQueuedMessages({ projectId, conversationId }),

  /** Re-dispatch a failed sub-agent with its original task after a network error. */
  retryAgent: (projectId: string, conversationId: string, agentName: string, task: string) =>
    electroviewRpc.request.retryAgent({ projectId, conversationId, agentName, task }),

  setAppFocused: (focused: boolean) =>
    electroviewRpc.request.setAppFocused({ focused }),

  // ---- Agents --------------------------------------------------------------

  /** Fetch all registered runtime agents. */
  getAgents: () => electroviewRpc.request.getAgents({}),

  /** Update mutable fields on an agent. */
  updateAgent: (params: { id: string; displayName?: string; color?: string; systemPrompt?: string; providerId?: string | null; modelId?: string | null; temperature?: string | null; maxTokens?: number | null; isEnabled?: boolean; thinkingBudget?: string | null; useSystemPromptOnly?: boolean; chatEnabled?: boolean; availableToPm?: boolean }) =>
    electroviewRpc.request.updateAgent(params),

  /** Reset a built-in agent's overrides to defaults. */
  resetAgent: (id: string) =>
    electroviewRpc.request.resetAgent({ id }),

  /** Create a new custom agent. */
  createAgent: (params: { name: string; displayName: string; color: string; systemPrompt: string; providerId?: string; modelId?: string; useSystemPromptOnly?: boolean; chatEnabled?: boolean; availableToPm?: boolean }) =>
    electroviewRpc.request.createAgent(params),

  /** Delete a custom (non-built-in) agent by id. */
  deleteAgent: (id: string) =>
    electroviewRpc.request.deleteAgent({ id }),

  /** Get tool assignments for an agent. */
  getAgentTools: (agentId: string) =>
    electroviewRpc.request.getAgentTools({ agentId }),

  /** Replace all tool assignments for an agent. */
  setAgentTools: (agentId: string, tools: Array<{ toolName: string; isEnabled: boolean }>) =>
    electroviewRpc.request.setAgentTools({ agentId, tools }),

  /** Get all registered tool definitions (for UI display). */
  getAllToolDefinitions: () =>
    electroviewRpc.request.getAllToolDefinitions({}),

  /** Reset agent tools to built-in defaults. */
  resetAgentTools: (agentId: string) =>
    electroviewRpc.request.resetAgentTools({ agentId }),

  // ---- Kanban --------------------------------------------------------------

  /** Fetch all kanban tasks for a project. */
  getKanbanTasks: (projectId: string) =>
    electroviewRpc.request.getKanbanTasks({ projectId }),

  /** Fetch a single kanban task. */
  getKanbanTask: (id: string) =>
    electroviewRpc.request.getKanbanTask({ id }),

  /** Create a new kanban task. */
  createKanbanTask: (params: {
    projectId: string;
    title: string;
    description?: string;
    column?: string;
    priority?: string;
    assignedAgentId?: string;
    blockedBy?: string;
    dueDate?: string;
  }) => electroviewRpc.request.createKanbanTask(params),

  /** Update an existing kanban task. */
  updateKanbanTask: (params: {
    id: string;
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    importantNotes?: string;
    column?: string;
    priority?: string;
    assignedAgentId?: string;
    blockedBy?: string;
    dueDate?: string;
    position?: number;
  }) => electroviewRpc.request.updateKanbanTask(params),

  /** Move a kanban task to a different column. */
  moveKanbanTask: (id: string, column: string, position?: number) =>
    electroviewRpc.request.moveKanbanTask({ id, column, position }),

  /** Delete a kanban task. */
  deleteKanbanTask: (id: string) =>
    electroviewRpc.request.deleteKanbanTask({ id }),

  // ---- Notes ----------------------------------------------------------------

  /** Fetch all notes for a project. */
  getProjectNotes: (projectId: string) =>
    electroviewRpc.request.getProjectNotes({ projectId }),

  /** Fetch a single note by id. */
  getNote: (id: string) =>
    electroviewRpc.request.getNote({ id }),

  /** Create a new note. */
  createNote: (params: { projectId: string; title: string; content: string; authorAgentId?: string }) =>
    electroviewRpc.request.createNote(params),

  /** Update an existing note. */
  updateNote: (params: { id: string; title?: string; content?: string }) =>
    electroviewRpc.request.updateNote(params),

  /** Delete a note by id. */
  deleteNote: (id: string) =>
    electroviewRpc.request.deleteNote({ id }),

  /** Search notes by title and content. */
  searchNotes: (projectId: string, query: string) =>
    electroviewRpc.request.searchNotes({ projectId, query }),

  /** Fetch plan .md files from the project workspace plans/ folder. */
  getWorkspacePlans: (projectId: string) =>
    electroviewRpc.request.getWorkspacePlans({ projectId }),

  /** Delete a plan .md file from the workspace. */
  deleteWorkspacePlan: (path: string) =>
    electroviewRpc.request.deleteWorkspacePlan({ path }),

  // ---- Collections -----------------------------------------------------------
  // Personal, cross-project knowledge base (see docs/collections-plan.md).
  // Wrappers are added incrementally as each phase's RPC methods land — only
  // the Phase-1 CRUD surface used by the Library screen shell is wired so far.

  /** List every collection with its live note count. */
  listCollections: () => electroviewRpc.request.listCollections({}),

  /** Create a new collection. */
  createCollection: (params: { name: string; color: string; icon?: string }) =>
    electroviewRpc.request.createCollection(params),

  /** Rename a collection (Default included — only its isDefault status is protected, not its name). */
  renameCollection: (params: { id: string; name: string }) =>
    electroviewRpc.request.renameCollection(params),

  /** Change a collection's color swatch. */
  recolorCollection: (params: { id: string; color: string; icon?: string }) =>
    electroviewRpc.request.recolorCollection(params),

  /** Delete a collection (rejected for the Default collection); its notes move to Default. */
  deleteCollection: (params: { id: string }) =>
    electroviewRpc.request.deleteCollection(params),

  /** Persist a new drag-and-drop order for custom (non-Default) collections in the rail. */
  reorderCollections: (params: { orderedIds: string[] }) =>
    electroviewRpc.request.reorderCollections(params),

  /** List notes in a collection, or the virtual "favorites"/"trash" scopes. */
  listNotes: (params: { collectionId: string; query?: string; tags?: string[]; sort?: "updated" | "created" | "title" | "favorite" }) =>
    electroviewRpc.request.listNotes(params),

  /** Fetch a single collection note by id, including attachments. */
  getCollectionNote: (params: { id: string }) =>
    electroviewRpc.request.getCollectionNote(params),

  /** Create a new collection note. */
  createCollectionNote: (params: { collectionId: string; title: string; contentMarkdown?: string }) =>
    electroviewRpc.request.createCollectionNote(params),

  /** Update an existing collection note's title, content, or tags. */
  updateCollectionNote: (params: { id: string; title?: string; contentMarkdown?: string; tags?: string[] }) =>
    electroviewRpc.request.updateCollectionNote(params),

  /** Toggle a note's favorite flag. Favorites is a virtual view over this flag, not a real collection. */
  toggleFavorite: (params: { id: string }) =>
    electroviewRpc.request.toggleFavorite(params),

  /** Move a note into a different real collection (drag-and-drop onto a rail item). */
  moveNote: (params: { id: string; targetCollectionId: string }) =>
    electroviewRpc.request.moveNote(params),

  /** Move a note to Trash (isDeleted=1). updatedAt is bumped and doubles as the 30-day purge clock. */
  softDeleteNote: (params: { id: string }) =>
    electroviewRpc.request.softDeleteNote(params),

  /** Restore a note out of Trash (isDeleted=0). */
  restoreNote: (params: { id: string }) =>
    electroviewRpc.request.restoreNote(params),

  /** Permanently delete a single trashed note and its attachment files. Irreversible. */
  permanentlyDeleteNote: (params: { id: string }) =>
    electroviewRpc.request.permanentlyDeleteNote(params),

  /** Permanently delete every trashed note and their attachment files. Irreversible. */
  emptyTrash: () => electroviewRpc.request.emptyTrash({}),

  /** FTS5 keyword search over notes, scoped to one collection/favorites/trash, or "all" for global search. */
  searchCollectionNotes: (params: { query: string; scope: string }) =>
    electroviewRpc.request.searchCollectionNotes(params),

  /** Opens the native OS file picker; the chosen path arrives via the "agentdesk:collection-attachment-file-picked" event. */
  pickAttachmentFile: (params: { noteId: string }) =>
    electroviewRpc.request.pickAttachmentFile(params),

  /** Copy an already-picked file into a note's attachment storage and record it. */
  addAttachment: (params: { noteId: string; sourcePath: string }) =>
    electroviewRpc.request.addAttachment(params),

  /** Remove an attachment (deletes both the DB row and the file on disk). */
  removeAttachment: (params: { id: string }) =>
    electroviewRpc.request.removeAttachment(params),

  /** Resolve an attachment's real absolute path for download. */
  getAttachmentDownloadPath: (params: { id: string }) =>
    electroviewRpc.request.getAttachmentDownloadPath(params),

  /** Reveal an attachment in the OS file explorer (no in-app "Save As" dialog exists). */
  revealAttachment: (params: { id: string }) =>
    electroviewRpc.request.revealAttachment(params),

  /** Export a single note as Markdown/PDF/JSON — writes the file and reveals it in the OS file explorer. */
  exportNote: (params: { id: string; format: "markdown" | "pdf" | "json" }) =>
    electroviewRpc.request.exportNote(params),

  /** Export every note in a collection as one bundle (JSON array / multi-page PDF / zip of .md files). */
  exportCollection: (params: { id: string; format: "markdown" | "pdf" | "json" }) =>
    electroviewRpc.request.exportCollection(params),

  /** Notes this note links out to via [[wiki-links]] in its own content. */
  getLinkedNotes: (params: { id: string }) =>
    electroviewRpc.request.getLinkedNotes(params),

  /** Notes that link to this note via a [[wiki-link]] in their own content. */
  getBacklinks: (params: { id: string }) =>
    electroviewRpc.request.getBacklinks(params),

  /** Save chat/inbox content into a collection note, stamped with provenance (sourceType/sourceRef). */
  saveToCollection: (params: {
    collectionId: string;
    title: string;
    contentMarkdown: string;
    sourceType?: "pm_chat" | "council" | "freelance_chat" | "skills_chat" | "freelance_inbox" | "inbox_message" | "manual";
    sourceRef?: { projectId?: string; projectName?: string; taskId?: string };
  }) => electroviewRpc.request.saveToCollection(params),

  /** Lightweight cross-collection note search for the "Attach a note" picker. */
  listNotesForAttachPicker: (params: { query?: string }) =>
    electroviewRpc.request.listNotesForAttachPicker(params),

  /** Full markdown content of a note, for inlining into an outgoing chat message. */
  getNoteContentForContext: (params: { id: string }) =>
    electroviewRpc.request.getNoteContentForContext(params),

  /** Total size/file count under the collections attachment storage root, for the Settings tab's Attachment storage card. */
  getAttachmentStorageInfo: () => electroviewRpc.request.getAttachmentStorageInfo({}),

  /** Reveals the collections attachment storage root in the OS file explorer. */
  openAttachmentStorageFolder: () => electroviewRpc.request.openAttachmentStorageFolder({}),

  /** Embedding model download/readiness status — drives the Settings tab's Embedding & Chat card and the chat FAB's gating. */
  getEmbeddingModelStatus: () => electroviewRpc.request.getEmbeddingModelStatus({}),

  /** Downloads the local embedding model. Resolves once fully downloaded and verified; incremental progress arrives via collectionEmbeddingModelStatus events. */
  downloadEmbeddingModel: () => electroviewRpc.request.downloadEmbeddingModel({}),

  /** Manually re-embeds every note (e.g. after a model change). Resolves once the full pass completes. */
  reindexNotes: () => electroviewRpc.request.reindexNotes({}),

  /** Send a message to the Collections chat assistant. Returns immediately; tokens arrive via collectionsChatChunk events. */
  sendCollectionsChatMessage: (sessionId: string, content: string, scope: string) =>
    electroviewRpc.request.sendCollectionsChatMessage({ sessionId, content, scope }),

  /** Abort an in-flight Collections chat stream. */
  abortCollectionsChatMessage: (sessionId: string) =>
    electroviewRpc.request.abortCollectionsChatMessage({ sessionId }),

  /** Clear Collections chat conversation history for a session. */
  clearCollectionsChatSession: (sessionId: string) =>
    electroviewRpc.request.clearCollectionsChatSession({ sessionId }),

  // ---- Discord -------------------------------------------------------------

  /** Fetch all Discord channel configurations. */
  getDiscordConfigs: () => electroviewRpc.request.getDiscordConfigs({}),

  /** Create or update a Discord channel configuration. Omit `id` to create. */
  saveDiscordConfig: (params: { id?: string; projectId?: string; token: string; serverId: string; channelId: string; enabled?: boolean }) =>
    electroviewRpc.request.saveDiscordConfig(params),

  /** Remove a Discord channel configuration by id. */
  deleteDiscordConfig: (id: string) => electroviewRpc.request.deleteDiscordConfig({ id }),

  /** Test a Discord bot token — returns bot name and accessible servers on success. */
  testDiscordConnection: (token: string) => electroviewRpc.request.testDiscordConnection({ token }),

  /** Return current Discord bot connection status. */
  getDiscordStatus: () => electroviewRpc.request.getDiscordStatus({}),

  // ---- Git ------------------------------------------------------------------

  getGitStatus: (projectId: string) => electroviewRpc.request.getGitStatus({ projectId }),
  getGitBranches: (projectId: string) => electroviewRpc.request.getGitBranches({ projectId }),
  getCurrentBranch: (projectId: string) => electroviewRpc.request.getCurrentBranch({ projectId }),
  getGitLog: (projectId: string, limit?: number) => electroviewRpc.request.getGitLog({ projectId, limit }),
  getGitDiff: (projectId: string, file?: string) => electroviewRpc.request.getGitDiff({ projectId, file }),
  getCommitFiles: (projectId: string, hash: string) => electroviewRpc.request.getCommitFiles({ projectId, hash }),
  gitCheckout: (projectId: string, branch: string) => electroviewRpc.request.gitCheckout({ projectId, branch }),
  gitCreateBranch: (projectId: string, name: string) => electroviewRpc.request.gitCreateBranch({ projectId, name }),
  gitStageFiles: (projectId: string, files: string[]) => electroviewRpc.request.gitStageFiles({ projectId, files }),
  gitCommit: (projectId: string, message: string) => electroviewRpc.request.gitCommit({ projectId, message }),
  gitPush: (projectId: string) => electroviewRpc.request.gitPush({ projectId }),
  gitPull: (projectId: string, remoteBranch?: string) => electroviewRpc.request.gitPull({ projectId, remoteBranch }),

  // ---- Plugins --------------------------------------------------------------

  getPlugins: () => electroviewRpc.request.getPlugins({}),
  togglePlugin: (name: string, enabled: boolean) => electroviewRpc.request.togglePlugin({ name, enabled }),
  getPluginSettings: (name: string) => electroviewRpc.request.getPluginSettings({ name }),
  savePluginSettings: (name: string, settings: Record<string, unknown>) => electroviewRpc.request.savePluginSettings({ name, settings }),
  savePluginPrompt: (name: string, prompt: string | null) => electroviewRpc.request.savePluginPrompt({ name, prompt }),

  // ---- Deploy --------------------------------------------------------------

  getEnvironments: (projectId: string) => electroviewRpc.request.getEnvironments({ projectId }),
  saveEnvironment: (params: {
    projectId: string;
    id?: string;
    name: string;
    branch?: string;
    command: string;
    url?: string;
  }) => electroviewRpc.request.saveEnvironment(params),
  deleteEnvironment: (id: string) => electroviewRpc.request.deleteEnvironment({ id }),
  getDeployHistory: (environmentId: string, limit?: number) => electroviewRpc.request.getDeployHistory({ environmentId, limit }),
  executeDeploy: (environmentId: string) => electroviewRpc.request.executeDeploy({ environmentId }),

  // ---- Prompts ---------------------------------------------------------------

  /** Fetch all prompt templates, ordered by name. */
  getPrompts: () => electroviewRpc.request.getPrompts({}),

  /** Create or update a prompt template. Omit `id` to create a new one. */
  savePrompt: (params: { id?: string; name: string; description: string; content: string; category?: string }) =>
    electroviewRpc.request.savePrompt(params),

  /** Remove a prompt template by id. */
  deletePrompt: (id: string) => electroviewRpc.request.deletePrompt({ id }),

  /** Search prompt templates by name or description. */
  searchPrompts: (query: string) => electroviewRpc.request.searchPrompts({ query }),

  // ---- Search --------------------------------------------------------------

  /** Search across projects, conversations, kanban tasks, and notes. */
  globalSearch: (query: string) =>
    electroviewRpc.request.globalSearch({ query }),

  // ---- Inbox ---------------------------------------------------------------
  getInboxMessages: (filters?: { projectId?: string; isRead?: boolean; isArchived?: boolean; isFavorite?: boolean; limit?: number }) =>
    electroviewRpc.request.getInboxMessages(filters ?? {}),
  markAsRead: (id: string) =>
    electroviewRpc.request.markAsRead({ id }),
  markAsUnread: (id: string) =>
    electroviewRpc.request.markAsUnread({ id }),
  markAllAsRead: (projectId?: string) =>
    electroviewRpc.request.markAllAsRead({ projectId }),
  deleteInboxMessage: (id: string) =>
    electroviewRpc.request.deleteInboxMessage({ id }),
  getUnreadCount: (projectId?: string) =>
    electroviewRpc.request.getUnreadCount({ projectId }),
  searchInboxMessages: (query: string, projectId?: string, isFavorite?: boolean) =>
    electroviewRpc.request.searchInboxMessages({ query, projectId, isFavorite }),
  archiveInboxMessage: (id: string) =>
    electroviewRpc.request.archiveInboxMessage({ id }),
  unarchiveInboxMessage: (id: string) =>
    electroviewRpc.request.unarchiveInboxMessage({ id }),
  favoriteInboxMessage: (id: string) =>
    electroviewRpc.request.favoriteInboxMessage({ id }),
  unfavoriteInboxMessage: (id: string) =>
    electroviewRpc.request.unfavoriteInboxMessage({ id }),
  bulkArchiveInboxMessages: (ids: string[]) =>
    electroviewRpc.request.bulkArchiveInboxMessages({ ids }),
  bulkDeleteInboxMessages: (ids: string[]) =>
    electroviewRpc.request.bulkDeleteInboxMessages({ ids }),
  bulkMarkAsReadInboxMessages: (ids: string[]) =>
    electroviewRpc.request.bulkMarkAsReadInboxMessages({ ids }),
  replyToInboxMessage: (id: string, content: string) =>
    electroviewRpc.request.replyToInboxMessage({ id, content }),

  // ---- Agent pause/resume/redirect/stop ------------------------------------

  /** Resume a paused agent — re-runs the same task from scratch. */
  resumeAgent: (projectId: string, agentId: string) =>
    electroviewRpc.request.resumeAgent({ projectId, agentId }),

  /** Redirect a paused agent with new human instructions. */
  redirectAgent: (projectId: string, agentId: string, instructions: string) =>
    electroviewRpc.request.redirectAgent({ projectId, agentId, instructions }),

  /** Stop a specific running agent by name. Pass conversationId to avoid
   *  matching the wrong same-named agent running in a different conversation. */
  stopAgent: (projectId: string, agentName: string, conversationId?: string) =>
    electroviewRpc.request.stopAgent({ projectId, agentName, conversationId }),

  /** Stop all running sub-agents and set the engine stopped flag. */
  stopAllAgents: (projectId: string) =>
    electroviewRpc.request.stopAllAgents({ projectId }),

  /** Get currently running sub-agents project-wide (dashboard project cards). */
  getRunningAgents: (projectId: string) =>
    electroviewRpc.request.getRunningAgents({ projectId }),

  /** Get currently running sub-agents scoped to one conversation — the
   *  correct source for a per-conversation running-agent badge/count. */
  getRunningAgentsForConversation: (projectId: string, conversationId: string) =>
    electroviewRpc.request.getRunningAgentsForConversation({ projectId, conversationId }),

  /** Get active agent counts for all projects (for the dashboard). */
  getActiveProjectAgents: () =>
    electroviewRpc.request.getActiveProjectAgents({}),

  /** Get task done/total counts per project (for dashboard cards). */
  getProjectTaskStats: () =>
    electroviewRpc.request.getProjectTaskStats({}),

  /** Check if the PM is currently streaming a response. Pass conversationId to scope the check to one conversation. */
  getPmStatus: (projectId: string, conversationId?: string) =>
    electroviewRpc.request.getPmStatus({ projectId, conversationId }),

  /** Test OS-level desktop notification. */
  testOsNotification: () =>
    electroviewRpc.request.testOsNotification({}),

  /** Search workspace files recursively (for @ mentions). */
  searchWorkspaceFiles: (projectId: string, query?: string) =>
    electroviewRpc.request.searchWorkspaceFiles({ projectId, query }),

  /** Execute a shell command directly in project workspace (for ! mode). */
  executeShellCommand: (projectId: string, command: string, timeout?: number) =>
    electroviewRpc.request.executeShellCommand({ projectId, command, timeout }),

  /** Manually trigger conversation compaction (for /compact). */
  compactConversation: (projectId: string, conversationId: string) =>
    electroviewRpc.request.compactConversation({ projectId, conversationId }),

  /** Open system terminal at project workspace (for /terminal). */
  openTerminal: (projectId: string) =>
    electroviewRpc.request.openTerminal({ projectId }),

  /**
   * Open a URL in the system default browser. In web mode, open it in the
   * user's own browser (a new tab) instead of routing to the remote desktop,
   * which would open the link on the desktop machine the user can't see.
   */
  openExternalUrl: (url: string) =>
    IS_REMOTE
      ? Promise.resolve(void window.open(url, "_blank", "noopener,noreferrer"))
      : electroviewRpc.request.openExternalUrl({ url }),

  /** Open a local folder path in the OS file explorer. */
  openInExplorer: (path: string) =>
    electroviewRpc.request.openInExplorer({ path }),

  /** Get the absolute path to the app's data directory (DB, logs, backups). */
  getDataPath: () =>
    electroviewRpc.request.getDataPath({}),

  /** Read the OS clipboard's text via Bun's native clipboard API. */
  readClipboardText: () =>
    electroviewRpc.request.readClipboardText({}),

  /** Write text to the OS clipboard via Bun's native clipboard API. */
  writeClipboardText: (text: string) =>
    electroviewRpc.request.writeClipboardText({ text }),

  /** Enhance a user prompt via AI. */
  enhancePrompt: (projectId: string, text: string, providerId?: string, modelId?: string) =>
    electroviewRpc.request.enhancePrompt({ projectId, text, providerId, modelId }),

  /** Respond to a shell command approval request. */
  respondShellApproval: (requestId: string, decision: "allow" | "deny" | "always") =>
    electroviewRpc.request.respondShellApproval({ requestId, decision }),

  /** Save an attached file to the project workspace. */
  saveAttachment: (projectId: string, fileName: string, dataBase64: string, type: "text" | "image" | "audio" | "binary") =>
    electroviewRpc.request.saveAttachment({ projectId, fileName, dataBase64, type }),

  /** Respond to a user question from the PM agent. */
  respondUserQuestion: (requestId: string, answer: string) =>
    electroviewRpc.request.respondUserQuestion({ requestId, answer }),

  /** Re-fetch still-pending approvals for a project (used after a reconnect). */
  getPendingApprovals: (projectId: string) =>
    electroviewRpc.request.getPendingApprovals({ projectId }),

  /** Clear the prompt debug log file. */
  clearPromptLog: () => electroviewRpc.request.clearPromptLog({}),

  /** Open the prompt debug log file in the OS default editor. */
  openPromptLog: () => electroviewRpc.request.openPromptLog({}),

  /** Get per-entry stats parsed from the prompt debug log (most recent first). */
  getPromptLogStats: (limit?: number) => electroviewRpc.request.getPromptLogStats({ limit }),

  /** Get the full system prompt + messages content for one prompt log entry. */
  getPromptLogEntry: (timestamp: string) => electroviewRpc.request.getPromptLogEntry({ timestamp }),

  // ---- WhatsApp ------------------------------------------------------------

  /** Fetch all WhatsApp channel configurations. */
  getWhatsAppConfigs: () => electroviewRpc.request.getWhatsAppConfigs({}),

  /** Create or update a WhatsApp channel configuration. Omit `id` to create. */
  saveWhatsAppConfig: (params: { id?: string; projectId?: string; enabled?: boolean }) =>
    electroviewRpc.request.saveWhatsAppConfig(params),

  /** Remove a WhatsApp channel configuration by id. */
  deleteWhatsAppConfig: (id: string) => electroviewRpc.request.deleteWhatsAppConfig({ id }),

  /** Return current WhatsApp connection status for a channel. */
  getWhatsAppStatus: (id: string) => electroviewRpc.request.getWhatsAppStatus({ id }),

  /** Connect a WhatsApp channel adapter — triggers QR code generation. */
  connectWhatsApp: (id: string) => electroviewRpc.request.connectWhatsApp({ id }),
  getDefaultChannelProject: () => electroviewRpc.request.getDefaultChannelProject({}),
  setDefaultChannelProject: (projectId: string | null) => electroviewRpc.request.setDefaultChannelProject({ projectId }),

  // ---- Email ---------------------------------------------------------------

  /** Fetch all Email channel configurations. */
  getEmailConfigs: () => electroviewRpc.request.getEmailConfigs({}),

  /** Create or update an Email channel configuration. Omit `id` to create. */
  saveEmailConfig: (params: { id?: string; projectId?: string; imapHost: string; imapPort: number; imapUser: string; imapPass: string; imapTls: boolean; smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; smtpTls: boolean; enabled?: boolean }) =>
    electroviewRpc.request.saveEmailConfig(params),

  /** Remove an Email channel configuration by id. */
  deleteEmailConfig: (id: string) => electroviewRpc.request.deleteEmailConfig({ id }),

  /** Test IMAP and SMTP connectivity for given credentials. */
  testEmailConnection: (params: { imapHost: string; imapPort: number; imapUser: string; imapPass: string; imapTls: boolean; smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; smtpTls: boolean }) =>
    electroviewRpc.request.testEmailConnection(params),

  // ---- Notifications -------------------------------------------------------

  /** Fetch notification preferences, optionally filtered by platform and project. */
  getNotificationPreferences: (params?: { platform?: string; projectId?: string }) =>
    electroviewRpc.request.getNotificationPreferences(params ?? {}),

  /** Create or update a notification preference entry. Omit `id` to create. */
  saveNotificationPreference: (params: { id?: string; platform: string; projectId?: string; soundEnabled?: boolean; badgeEnabled?: boolean; bannerEnabled?: boolean; muteUntil?: string | null }) =>
    electroviewRpc.request.saveNotificationPreference(params),

  // ---- Inbox Rules ---------------------------------------------------------

  /** Fetch all inbox rules, optionally filtered by project. */
  getInboxRules: (projectId?: string) =>
    electroviewRpc.request.getInboxRules({ projectId }),

  /** Create a new inbox rule. */
  createInboxRule: (params: { projectId?: string; name: string; conditions: string; actions: string; priority?: number }) =>
    electroviewRpc.request.createInboxRule(params),

  /** Update an existing inbox rule. */
  updateInboxRule: (params: { id: string; name?: string; conditions?: string; actions?: string; enabled?: boolean; priority?: number }) =>
    electroviewRpc.request.updateInboxRule(params),

  /** Delete an inbox rule by id. */
  deleteInboxRule: (id: string) => electroviewRpc.request.deleteInboxRule({ id }),

  // ---- Cron Jobs -----------------------------------------------------------

  getCronJobs: (params?: { projectId?: string }) =>
    electroviewRpc.request.getCronJobs(params ?? {}),

  createCronJob: (params: { projectId?: string; name: string; cronExpression: string; timezone?: string; taskType: string; taskConfig: string; enabled?: boolean; oneShot?: boolean }) =>
    electroviewRpc.request.createCronJob(params),

  updateCronJob: (params: { id: string; name?: string; cronExpression?: string; timezone?: string; taskType?: string; taskConfig?: string; enabled?: boolean; oneShot?: boolean }) =>
    electroviewRpc.request.updateCronJob(params),

  deleteCronJob: (id: string) => electroviewRpc.request.deleteCronJob({ id }),

  getCronJobHistory: (jobId: string, limit?: number) =>
    electroviewRpc.request.getCronJobHistory({ jobId, limit }),

  clearCronJobHistory: (jobId?: string) =>
    electroviewRpc.request.clearCronJobHistory({ jobId }),

  previewCronSchedule: (cronExpression: string, timezone?: string, count?: number) =>
    electroviewRpc.request.previewCronSchedule({ cronExpression, timezone, count }),

  triggerCronJob: (params: { id: string }) =>
    electroviewRpc.request.triggerCronJob(params),

  stopCronJob: (params: { id: string }) =>
    electroviewRpc.request.stopCronJob(params),

  getRunningSchedulerMessages: () =>
    electroviewRpc.request.getRunningSchedulerMessages({}),

  // ---- Automation Rules ----------------------------------------------------

  getAutomationRules: (projectId?: string) =>
    electroviewRpc.request.getAutomationRules({ projectId }),

  createAutomationRule: (params: { projectId?: string; name: string; trigger: string; actions: string; priority?: number }) =>
    electroviewRpc.request.createAutomationRule(params),

  updateAutomationRule: (params: { id: string; name?: string; trigger?: string; actions?: string; enabled?: boolean; priority?: number }) =>
    electroviewRpc.request.updateAutomationRule(params),

  deleteAutomationRule: (id: string) => electroviewRpc.request.deleteAutomationRule({ id }),

  getAutomationTemplates: () => electroviewRpc.request.getAutomationTemplates({}),

  // ── Git (Phase 9 additions) ──
  getConflicts: (projectId: string) =>
    electroviewRpc.request.getConflicts({ projectId }),
  getConflictDiff: (projectId: string, file: string) =>
    electroviewRpc.request.getConflictDiff({ projectId, file }),
  gitDeleteBranch: (projectId: string, name: string) =>
    electroviewRpc.request.gitDeleteBranch({ projectId, name }),
  gitMergeBranch: (projectId: string, branch: string, strategy?: string) =>
    electroviewRpc.request.gitMergeBranch({ projectId, branch, strategy }),
  gitRebaseBranch: (projectId: string, onto: string) =>
    electroviewRpc.request.gitRebaseBranch({ projectId, onto }),
  gitAbortMerge: (projectId: string) =>
    electroviewRpc.request.gitAbortMerge({ projectId }),

  // ── Pull Requests ──
  getPullRequests: (projectId: string, state?: string) =>
    electroviewRpc.request.getPullRequests({ projectId, state }),
  createPullRequest: (params: { projectId: string; title: string; description?: string; sourceBranch: string; targetBranch: string; linkedTaskId?: string }) =>
    electroviewRpc.request.createPullRequest(params),
  updatePullRequest: (params: { id: string; title?: string; description?: string; state?: string }) =>
    electroviewRpc.request.updatePullRequest(params),
  mergePullRequest: (id: string, strategy: "merge" | "squash" | "rebase", deleteBranch?: boolean) =>
    electroviewRpc.request.mergePullRequest({ id, strategy, deleteBranch }),
  deletePullRequest: (id: string) =>
    electroviewRpc.request.deletePullRequest({ id }),
  getPrDiff: (id: string) =>
    electroviewRpc.request.getPrDiff({ id }),
  getPrComments: (prId: string) =>
    electroviewRpc.request.getPrComments({ prId }),
  addPrComment: (params: { prId: string; content: string; file?: string; lineNumber?: number; authorName?: string; authorType?: string }) =>
    electroviewRpc.request.addPrComment(params),
  deletePrComment: (id: string) =>
    electroviewRpc.request.deletePrComment({ id }),
  generatePrDescription: (projectId: string, sourceBranch: string, targetBranch: string) =>
    electroviewRpc.request.generatePrDescription({ projectId, sourceBranch, targetBranch }),

  // ── GitHub Issues ──
  getGithubIssues: (projectId: string, state?: string) =>
    electroviewRpc.request.getGithubIssues({ projectId, state }),
  syncGithubIssues: (projectId: string) =>
    electroviewRpc.request.syncGithubIssues({ projectId }),
  createGithubIssueFromTask: (taskId: string, projectId: string) =>
    electroviewRpc.request.createGithubIssueFromTask({ taskId, projectId }),
  linkIssueToTask: (issueId: string, taskId: string | null) =>
    electroviewRpc.request.linkIssueToTask({ issueId, taskId }),
  validateGithubToken: (token: string) =>
    electroviewRpc.request.validateGithubToken({ token }),
  getProjectGitHubTokenInfo: (projectId: string) =>
    electroviewRpc.request.getProjectGitHubTokenInfo({ projectId }),

  // ── Multi-source Issues ──
  listIssueSources: (projectId: string) =>
    electroviewRpc.request.listIssueSources({ projectId }),
  getIssueSourceConfig: (projectId: string, source: import("../../shared/rpc/issues").IssueSource) =>
    electroviewRpc.request.getIssueSourceConfig({ projectId, source }),
  saveIssueSourceConfig: (projectId: string, source: import("../../shared/rpc/issues").IssueSource, config: Record<string, string>) =>
    electroviewRpc.request.saveIssueSourceConfig({ projectId, source, config }),
  deleteIssueSourceConfig: (projectId: string, source: import("../../shared/rpc/issues").IssueSource) =>
    electroviewRpc.request.deleteIssueSourceConfig({ projectId, source }),
  testIssueSource: (projectId: string, source: import("../../shared/rpc/issues").IssueSource, config?: Record<string, string>) =>
    electroviewRpc.request.testIssueSource({ projectId, source, config }),
  getExternalIssues: (projectId: string, source?: import("../../shared/rpc/issues").IssueSource, state?: string) =>
    electroviewRpc.request.getExternalIssues({ projectId, source, state }),
  syncIssueSource: (projectId: string, source: import("../../shared/rpc/issues").IssueSource) =>
    electroviewRpc.request.syncIssueSource({ projectId, source }),
  linkExternalIssueToTask: (issueId: string, taskId: string | null) =>
    electroviewRpc.request.linkExternalIssueToTask({ issueId, taskId }),
  createExternalIssueFromTask: (taskId: string, projectId: string, source: import("../../shared/rpc/issues").IssueSource) =>
    electroviewRpc.request.createExternalIssueFromTask({ taskId, projectId, source }),
  getSourceBuckets: (source: import("../../shared/rpc/issues").IssueSource, config: Record<string, string>) =>
    electroviewRpc.request.getSourceBuckets({ source, config }),

  // ── Branch Strategy ──
  getBranchStrategy: (projectId: string) =>
    electroviewRpc.request.getBranchStrategy({ projectId }),
  saveBranchStrategy: (params: { projectId: string; model?: string; defaultBranch?: string; featureBranchPrefix?: string; releaseBranchPrefix?: string; hotfixBranchPrefix?: string; namingTemplate?: string; protectedBranches?: string[]; autoCleanup?: boolean }) =>
    electroviewRpc.request.saveBranchStrategy(params),
  createFeatureBranch: (projectId: string, taskId: string, taskTitle: string) =>
    electroviewRpc.request.createFeatureBranch({ projectId, taskId, taskTitle }),
  getMergedBranches: (projectId: string) =>
    electroviewRpc.request.getMergedBranches({ projectId }),
  cleanupMergedBranches: (projectId: string) =>
    electroviewRpc.request.cleanupMergedBranches({ projectId }),

  // ── Analytics ──
  getProjectStats: (projectId: string, days?: number) =>
    electroviewRpc.request.getProjectStats({ projectId, days }),
  getAnalyticsSummary: (projectId: string) =>
    electroviewRpc.request.getAnalyticsSummary({ projectId }),
  getTelemetryUsage: (params: { projectId?: string; agentName?: string; provider?: string; days?: number }) =>
    electroviewRpc.request.getTelemetryUsage(params),
  getProviderHealth: (days?: number) =>
    electroviewRpc.request.getProviderHealth({ days }),

  // MCP
  getMcpConfig: () => electroviewRpc.request.getMcpConfig({}),
  saveMcpConfig: (configJson: string) => electroviewRpc.request.saveMcpConfig({ configJson }),
  getMcpStatus: () => electroviewRpc.request.getMcpStatus({}),
  reconnectMcpServer: (name?: string) => electroviewRpc.request.reconnectMcpServer({ name }),
  disconnectMcpServer: (name: string) => electroviewRpc.request.disconnectMcpServer({ name }),

  // Plugin Extensions
  getPluginExtensions: () => electroviewRpc.request.getPluginExtensions({}),

  // LSP
  getLspStatus: () => electroviewRpc.request.getLspStatus({}),
  installLspServer: (serverId: string) => electroviewRpc.request.installLspServer({ serverId }),
  uninstallLspServer: (serverId: string) => electroviewRpc.request.uninstallLspServer({ serverId }),

  // ── Database Viewer ──
  dbViewerGetTables: () => electroviewRpc.request.dbViewerGetTables({}),
  dbViewerGetRows: (params: { table: string; page: number; pageSize?: number }) =>
    electroviewRpc.request.dbViewerGetRows(params),
  dbViewerDeleteRow: (params: { table: string; id: string }) =>
    electroviewRpc.request.dbViewerDeleteRow(params),

  // ── Phase 13: Audit Log ──
  getAuditLog: (params: { action?: string; entityType?: string; limit?: number; offset?: number; before?: string; after?: string }) =>
    electroviewRpc.request.getAuditLog(params),
  clearAuditLog: (before?: string) =>
    electroviewRpc.request.clearAuditLog({ before }),

  // ── Phase 13: Backup/Restore ──
  createBackup: () => electroviewRpc.request.createBackup({}),
  listBackups: () => electroviewRpc.request.listBackups({}),
  deleteBackup: (filename: string) => electroviewRpc.request.deleteBackup({ filename }),
  restoreBackup: (filename: string) => electroviewRpc.request.restoreBackup({ filename }),

  // ── Phase 13: Export/Import ──
  exportProjectData: (projectId: string) => electroviewRpc.request.exportProjectData({ projectId }),
  importProjectData: (projectId: string, data: string, mode: "merge" | "replace") =>
    electroviewRpc.request.importProjectData({ projectId, data, mode }),

  // ── Settings Export/Import ──
  exportSettings: () => electroviewRpc.request.exportSettings({}),
  importSettings: (data: string) => electroviewRpc.request.importSettings({ data }),

  // ── Reset Application ──
  resetApplication: () => electroviewRpc.request.resetApplication({}),

  // ── System Health ──
  getHealthStatus: () => electroviewRpc.request.getHealthStatus({}),
  checkDatabase: () => electroviewRpc.request.checkDatabase({}),
  restartScheduler: () => electroviewRpc.request.restartScheduler({}),
  cleanupEngines: () => electroviewRpc.request.cleanupEngines({}),

  // ── Database Maintenance ──
  optimizeDatabase: () => electroviewRpc.request.optimizeDatabase({}),
  vacuumDatabase: () => electroviewRpc.request.vacuumDatabase({}),
  pruneDatabase: (days?: number) => electroviewRpc.request.pruneDatabase({ days }),
  getMaintenanceStatus: () => electroviewRpc.request.getMaintenanceStatus({}),

  // ── Conversation Archive ──
  archiveConversation: (id: string) => electroviewRpc.request.archiveConversation({ id }),
  restoreConversation: (id: string) => electroviewRpc.request.restoreConversation({ id }),
  archiveOldConversations: (projectId: string, daysOld?: number) =>
    electroviewRpc.request.archiveOldConversations({ projectId, daysOld }),
  getArchivedConversations: (projectId: string) =>
    electroviewRpc.request.getArchivedConversations({ projectId }),

  // ---- Messages (fire-and-forget) ------------------------------------------

  /** Forward a log entry to the bun-side console. */
  log: (level: string, message: string) =>
    electroviewRpc.send.log({ level, message }),

  /** Forward a client-side error to the bun-side error log file. */
  logClientError: (type: string, message: string, stack?: string) =>
    electroviewRpc.send.logClientError({ type, message, stack }),

  // ---- Dashboard PM Chat ---------------------------------------------------

  /** Send a message to the dashboard PM chatbot. Returns immediately; tokens arrive via dashboardPMChunk events. */
  sendDashboardMessage: (sessionId: string, content: string) =>
    electroviewRpc.request.sendDashboardMessage({ sessionId, content }),

  /** Abort an in-flight dashboard PM stream. */
  abortDashboardMessage: (sessionId: string) =>
    electroviewRpc.request.abortDashboardMessage({ sessionId }),

  /** Clear dashboard PM conversation history for a session. */
  clearDashboardSession: (sessionId: string) =>
    electroviewRpc.request.clearDashboardSession({ sessionId }),

  /** List custom agents that have "Enable Chat" turned on (and are enabled). */
  getChatEnabledAgents: () =>
    electroviewRpc.request.getChatEnabledAgents({}),

  /** Send a message to a custom agent in its dashboard chat session. */
  sendDashboardAgentMessage: (sessionId: string, agentName: string, content: string) =>
    electroviewRpc.request.sendDashboardAgentMessage({ sessionId, agentName, content }),

  /** Abort an in-flight custom-agent dashboard chat stream. */
  abortDashboardAgentMessage: (sessionId: string) =>
    electroviewRpc.request.abortDashboardAgentMessage({ sessionId }),

  /** Clear the in-memory history for a custom-agent dashboard chat session. */
  clearDashboardAgentSession: (sessionId: string) =>
    electroviewRpc.request.clearDashboardAgentSession({ sessionId }),

  // ---- Skills --------------------------------------------------------------

  /** Get all loaded skills (summary metadata). */
  getSkills: () => electroviewRpc.request.getSkills({}),

  /** Get a single skill's full detail including content. */
  getSkill: (name: string) => electroviewRpc.request.getSkill({ name }),

  /** Re-scan the skills directory and reload all skills. */
  refreshSkills: () => electroviewRpc.request.refreshSkills({}),

  /** Get the absolute path to the skills directory. */
  getSkillsDirectory: () => electroviewRpc.request.getSkillsDirectory({}),

  /** Open a skill's SKILL.md in the OS default editor. */
  openSkillInEditor: (name: string) => electroviewRpc.request.openSkillInEditor({ name }),

  /** Open the skills directory in the OS file explorer. */
  openSkillsFolder: () => electroviewRpc.request.openSkillsFolder({}),

  /** Get all available agent tools (name, category, description). */
  getAvailableTools: () => electroviewRpc.request.getAvailableTools({}),

  /** Delete a user-installed skill by name. */
  deleteSkill: (name: string) => electroviewRpc.request.deleteSkill({ name }),

  // ---- Custom Env Vars -------------------------------------------------------

  /** List all user-created environment variables. */
  listCustomEnvVars: () =>
    electroviewRpc.request.listCustomEnvVars({}),

  /** Create a new custom environment variable. */
  createCustomEnvVar: (name: string, value: string) =>
    electroviewRpc.request.createCustomEnvVar({ name, value }),

  /** Update an existing custom environment variable. */
  updateCustomEnvVar: (id: string, params: { name?: string; value?: string }) =>
    electroviewRpc.request.updateCustomEnvVar({ id, ...params }),

  /** Delete a custom environment variable by id. */
  deleteCustomEnvVar: (id: string) =>
    electroviewRpc.request.deleteCustomEnvVar({ id }),

  // ---- Recommendations (system dependencies) --------------------------------

  /** Check installation status of all recommended system dependencies. */
  checkDependencies: () =>
    electroviewRpc.request.checkDependencies({}),

  /** Trigger the install agent for a dependency. Returns immediately; result arrives via "agentdesk:recommendation-status-changed". */
  installDependency: (dependencyId: string) =>
    electroviewRpc.request.installDependency({ dependencyId: dependencyId as import("../../shared/rpc/recommendations").DependencyId }),

  // ---- Updater -------------------------------------------------------------

  /** Check for an available app update. Returns devMode=true when running in dev channel. */
  checkForUpdate: () => electroviewRpc.request.checkForUpdate({}),

  /** Download and decompress the latest update. Progress arrives via "agentdesk:update-status" events. */
  downloadUpdate: () => electroviewRpc.request.downloadUpdate({}),

  /** Apply the downloaded update and restart the app. */
  applyUpdate: () => electroviewRpc.request.applyUpdate({}),

  /** Check if there are unseen release notes since the last seen version. */
  getWhatsNewStatus: () => electroviewRpc.request.getWhatsNewStatus({}),

  /** Mark the current version's release notes as seen. */
  markWhatsNewSeen: () => electroviewRpc.request.markWhatsNewSeen({}),

  // ---- Council -------------------------------------------------------------

  /** Start a council session with a user query. Returns the session ID immediately. */
  startCouncil: (query: string, context?: string) =>
    electroviewRpc.request.startCouncil({ query, context }),

  /** Stop an in-flight council session. */
  stopCouncil: (sessionId: string) =>
    electroviewRpc.request.stopCouncil({ sessionId }),

  /** Submit a user answer to a pending PM question in a council session. */
  answerCouncilQuestion: (sessionId: string, questionId: string, answer: string) =>
    electroviewRpc.request.answerCouncilQuestion({ sessionId, questionId, answer }),

  // ---- Playground ----------------------------------------------------------

  /** Send a message to the Playground Agent (streams activity via broadcasts).
   *  Pass captured preview console messages so the agent can fix runtime errors. */
  playgroundSend: (message: string, consoleErrors?: string[]) =>
    electroviewRpc.request.playgroundSend({ message, consoleErrors }),

  /** Abort the in-flight playground run. */
  playgroundStop: () => electroviewRpc.request.playgroundStop({}),

  /** Wipe the playground (delete temp files + stop dev servers). Pass `force` to
   *  first kill running dev servers that may be holding file locks. */
  newPlayground: (force?: boolean) => electroviewRpc.request.newPlayground({ force }),

  /** Get the current playground state (running / hasFiles / preview) for restore. */
  getPlaygroundState: () => electroviewRpc.request.getPlaygroundState({}),

  /** Promote the current playground into a real project. */
  createProjectFromPlayground: () =>
    electroviewRpc.request.createProjectFromPlayground({}),

  /** Zip the playground files into the Downloads folder. */
  exportPlaygroundZip: () => electroviewRpc.request.exportPlaygroundZip({}),

  /** Read the playground's raw text source files (for the "View source" dialog). */
  getPlaygroundSource: () => electroviewRpc.request.getPlaygroundSource({}),

  /** Write an edited source file back to the playground directory (triggers hot-reload). */
  savePlaygroundFile: (filePath: string, content: string) =>
    electroviewRpc.request.savePlaygroundFile({ path: filePath, content }),

  /** Update the current preview's URL (persists to preview.json). */
  setPlaygroundPreviewUrl: (url: string) =>
    electroviewRpc.request.setPlaygroundPreviewUrl({ url }),

  /** List background dev servers currently running in the playground temp folder. */
  getPlaygroundDevServers: () => electroviewRpc.request.getPlaygroundDevServers({}),

  /** Stop a specific playground dev server. */
  stopPlaygroundDevServer: (jobId: string) =>
    electroviewRpc.request.stopPlaygroundDevServer({ jobId }),

  /** Restart a stopped playground dev server by its command. */
  startPlaygroundDevServer: (command: string) =>
    electroviewRpc.request.startPlaygroundDevServer({ command }),

  /** Deploy the current static playground to surge.sh and return the live URL. */
  deployPlayground: () => electroviewRpc.request.deployPlayground({}),

  // ---- Issue Fixer ---------------------------------------------------------

  /** Fetch the Issue Fixer config for a project (null if never configured). */
  getIssueFixerConfig: (projectId: string) =>
    electroviewRpc.request.getIssueFixerConfig({ projectId }),

  /** Save (upsert) the Issue Fixer config for a project. */
  saveIssueFixerConfig: (
    projectId: string,
    config: Partial<Omit<IssueFixerConfigDto, "projectId">>,
  ) => electroviewRpc.request.saveIssueFixerConfig({ projectId, config }),

  /** List Issue Fixer run history for a project. */
  listIssueFixRuns: (projectId: string, limit?: number) =>
    electroviewRpc.request.listIssueFixRuns({ projectId, limit }),

  /** Fetch a single Issue Fixer run by id. */
  getIssueFixRun: (id: string) => electroviewRpc.request.getIssueFixRun({ id }),

  /** Current/most-recent live run snapshot for the Activity tab to hydrate on mount. */
  getActiveIssueFixRun: (projectId: string) =>
    electroviewRpc.request.getActiveIssueFixRun({ projectId }),

  /** Poll this project's GitHub issues/comments immediately. */
  pollIssueFixerNow: (projectId: string) =>
    electroviewRpc.request.pollIssueFixerNow({ projectId }),

  /** Cancel the in-flight Issue Fixer run. */
  cancelIssueFixRun: (runId: string) =>
    electroviewRpc.request.cancelIssueFixRun({ runId }),

  /** Manually queue an Issue Fixer run for a specific issue. */
  triggerIssueFixManually: (projectId: string, issueNumber: number) =>
    electroviewRpc.request.triggerIssueFixManually({ projectId, issueNumber }),

  /** Get the predefined agentdesk-* keyword catalog for the settings UI. */
  getIssueFixerKeywordCatalog: () =>
    electroviewRpc.request.getIssueFixerKeywordCatalog({}),

  // ---- Remote Sync (SFTP/FTP) ---------------------------------------------

  /** Fetch the Remote Sync config for a project (null if never configured). */
  getRemoteSyncConfig: (projectId: string) =>
    electroviewRpc.request.getRemoteSyncConfig({ projectId }),

  /** Save (upsert) the Remote Sync config. Secrets are encrypted server-side. */
  saveRemoteSyncConfig: (projectId: string, input: RemoteSyncConfigInput) =>
    electroviewRpc.request.saveRemoteSyncConfig({ projectId, input }),

  /** Decrypt and return saved secrets for viewing/editing (explicit reveal). */
  revealRemoteSyncSecret: (projectId: string) =>
    electroviewRpc.request.revealRemoteSyncSecret({ projectId }),

  /** Test the saved connection by listing the remote base path. */
  testRemoteConnection: (projectId: string) =>
    electroviewRpc.request.testRemoteConnection({ projectId }),

  /** List a single remote directory (lazy tree expansion). */
  browseRemoteDir: (projectId: string, remoteDir: string) =>
    electroviewRpc.request.browseRemoteDir({ projectId, remoteDir }),

  /** Preflight: selected files with un-pushed local edits a Pull would overwrite. */
  computeRemotePullConflicts: (projectId: string) =>
    electroviewRpc.request.computeRemotePullConflicts({ projectId }),

  /** Start downloading all selected files/folders (async; streams progress). */
  startRemotePull: (projectId: string) =>
    electroviewRpc.request.startRemotePull({ projectId }),

  /** Compute which local files would be uploaded (new/modified/deleted). */
  computeRemotePushDiff: (projectId: string) =>
    electroviewRpc.request.computeRemotePushDiff({ projectId }),

  /** Local + server content for one file, for a diff preview. */
  getRemotePushFileDiff: (projectId: string, remotePath: string) =>
    electroviewRpc.request.getRemotePushFileDiff({ projectId, remotePath }),

  /** Start uploading the given remote paths back to the server. */
  startRemotePush: (projectId: string, remotePaths: string[]) =>
    electroviewRpc.request.startRemotePush({ projectId, remotePaths }),

  /** List Remote Sync operation history for a project. */
  listRemoteSyncRuns: (projectId: string, limit?: number) =>
    electroviewRpc.request.listRemoteSyncRuns({ projectId, limit }),

  /** Cancel the in-flight pull/push for a project. */
  cancelRemoteSync: (projectId: string) =>
    electroviewRpc.request.cancelRemoteSync({ projectId }),

  // ---- Unread activity -----------------------------------------------------

  /** All (projectId, location) pairs with unseen agent activity. */
  getUnreadActivity: () =>
    electroviewRpc.request.getUnreadActivity({}),

  /** Mark a (projectId, location) as seen — clears its unread dot. */
  markActivitySeen: (projectId: string, location: string) =>
    electroviewRpc.request.markActivitySeen({ projectId, location }),

  // ---- Freelance -----------------------------------------------------------

  /** Check if the freelance feature is enabled. */
  freelanceGetFeatureEnabled: () =>
    electroviewRpc.request["freelance.getFeatureEnabled"]({}),

  /** Fetch freelance general settings. */
  freelanceGetSettings: () =>
    electroviewRpc.request["freelance.getSettings"]({}),

  /** Persist freelance general settings. */
  freelanceSaveSettings: (params: {
    rssSources: Array<{ name: string; url: string; enabled: boolean }>;
    keywords: string[];
    pollingInterval: number;
    maxFeeds: number;
    maxListings: number;
    autoShortlistEnabled: boolean;
    autoShortlistCount: number;
    autoShortlistOnStartup: boolean;
    analysisProviderId: string | null;
    additionalNotes: string;
    preferredCurrency: string;
  }) => electroviewRpc.request["freelance.saveSettings"](params),

  /** Get counts for each listing filter tab. */
  freelanceGetListingCounts: () =>
    electroviewRpc.request["freelance.getListingCounts"]({}),

  /** Fetch paginated listings. */
  freelanceGetListings: (params?: { status?: "new" | "approved" | "shortlisted" | "closed" | "bids"; page?: number; search?: string; kind?: import("../../shared/rpc/freelance").FreelanceListingKind; excludeKinds?: import("../../shared/rpc/freelance").FreelanceListingKind[] }) =>
    electroviewRpc.request["freelance.getListings"](params ?? {}),

  /** Approve a listing (creates a project). */
  freelanceApproveListing: (listingId: string) =>
    electroviewRpc.request["freelance.approveListing"]({ listingId }),

  /** Soft-delete a listing (excluded from all future queries). */
  freelanceDeleteListing: (listingId: string) =>
    electroviewRpc.request["freelance.deleteListing"]({ listingId }),

  /** Manually trigger a fetch cycle. */
  freelanceTriggerFetch: () =>
    electroviewRpc.request["freelance.triggerFetch"]({}),

  /** Hard-delete all listings and their chat messages. */
  freelanceDeleteListings: (ids: string[]) =>
    electroviewRpc.request["freelance.deleteListings"]({ ids }),

  /** Danger Zone — permanently delete EVERY freelance listing (any status) and their chat messages. Cannot be undone. */
  freelanceCleanUpAllListings: () =>
    electroviewRpc.request["freelance.cleanUpAllListings"]({}),

  /** Fetch all chat messages for a listing. */
  freelanceChatGetMessages: (listingId: string) =>
    electroviewRpc.request["freelance.chat.getMessages"]({ listingId }),

  /** Send a chat message and start streaming the AI response. */
  freelanceChatSendMessage: (listingId: string, content: string) =>
    electroviewRpc.request["freelance.chat.sendMessage"]({ listingId, content }),

  /** Regenerate the last assistant message. */
  freelanceChatRegenerate: (listingId: string) =>
    electroviewRpc.request["freelance.chat.regenerate"]({ listingId }),

  /** Clear all chat messages for a listing. */
  freelanceChatClearMessages: (listingId: string) =>
    electroviewRpc.request["freelance.chat.clearMessages"]({ listingId }),

  /** Stop the in-flight chat stream for a listing. */
  freelanceChatStop: (listingId: string) =>
    electroviewRpc.request["freelance.chat.stop"]({ listingId }),

  /** Fetch all messages in the (in-memory, single global) Skills Search chat. */
  getSkillsChatMessages: () =>
    electroviewRpc.request["skillsChat.getMessages"]({}),

  /** Send a Skills Search chat message and start streaming the AI response. */
  sendSkillsChatMessage: (content: string) =>
    electroviewRpc.request["skillsChat.sendMessage"]({ content }),

  /** Regenerate the last assistant message in the Skills Search chat. */
  regenerateSkillsChat: () =>
    electroviewRpc.request["skillsChat.regenerate"]({}),

  /** Clear the Skills Search chat conversation. */
  clearSkillsChatMessages: () =>
    electroviewRpc.request["skillsChat.clearMessages"]({}),

  /** Stop the in-flight Skills Search chat stream. */
  stopSkillsChat: () =>
    electroviewRpc.request["skillsChat.stop"]({}),

  /** Start the "Find Workable Projects" wizard (fire-and-forget).
   *  Pass { count } for a one-shot run or { hours } to repeat every hour. */
  freelanceWizardStart: (params: { count?: number; hours?: number }) =>
    electroviewRpc.request["freelance.wizard.start"](params),

  /** Stop the running wizard immediately. */
  freelanceWizardStop: () =>
    electroviewRpc.request["freelance.wizard.stop"]({}),

  /** Run workability analysis on a single listing. */
  freelanceWizardAnalyzeListing: (listingId: string) =>
    electroviewRpc.request["freelance.wizard.analyzeListing"]({ listingId }),

  /** Mark selected listings as shortlisted. */
  freelanceShortlistListings: (listingIds: string[]) =>
    electroviewRpc.request["freelance.shortlistListings"]({ listingIds }),

  /** Mark an approved listing as done (closed). */
  freelanceMarkListingDone: (listingId: string) =>
    electroviewRpc.request["freelance.markListingDone"]({ listingId }),

  freelanceRefreshListingDescription: (listingId: string) =>
    electroviewRpc.request["freelance.refreshListingDescription"]({ listingId }),

  /** Fetch cached USD-based currency rates (fetches from network if stale). */
  freelanceGetCurrencyRates: () =>
    electroviewRpc.request["freelance.getCurrencyRates"]({}),

  // ---- Auto-Earn inbox (read-only v1) --------------------------------------

  /** Forward intercepted platform JSON to be normalized + stored. */
  freelanceInboxIngest: (records: Array<{ url: string; body: string }>, platform?: string) =>
    electroviewRpc.request["freelance.inbox.ingest"]({ records, platform }),

  /** Connection status + identity of the connected freelance account. */
  freelanceInboxGetAccount: (platform?: string) =>
    electroviewRpc.request["freelance.inbox.getAccount"]({ platform }),

  /** List normalized inbox threads (optionally filtered by search). */
  freelanceInboxGetThreads: (search?: string, platform?: string) =>
    electroviewRpc.request["freelance.inbox.getThreads"]({ search, platform }),

  /** Fetch normalized messages for a thread. */
  freelanceInboxGetMessages: (threadId: string, platform?: string) =>
    electroviewRpc.request["freelance.inbox.getMessages"]({ threadId, platform }),

  /** Log an inbox sync (auto/manual) to the governor audit trail. */
  freelanceLogInboxSync: (source?: string, platform?: string) =>
    electroviewRpc.request["freelance.inbox.logSync"]({ source, platform }),

  /** Report a platform anomaly (429/403/captcha) seen in the live session — trips the circuit breaker. */
  freelanceReportAnomaly: (kind: string, detail?: string, platform?: string) =>
    electroviewRpc.request["freelance.session.anomaly"]({ kind, detail, platform }),

  /** Clear the partition session (cookies/storage) for a platform. */
  freelanceAccountDisconnect: (platform?: string) =>
    electroviewRpc.request["freelance.account.disconnect"]({ platform }),

  /** Set per-account autonomy mode (assisted or full_auto). */
  freelanceAccountSetAutonomy: (mode: "assisted" | "full_auto", platform?: string) =>
    electroviewRpc.request["freelance.account.setAutonomy"]({ mode, platform }),

  /** Whether the Auto-Earn feature is available (gated by the `autoearn` flag file). */
  freelanceAutoEarnAvailable: () =>
    electroviewRpc.request["freelance.autoearn.isAvailable"]({}),

  /** Fetch Auto-Earn settings (master switch, governor knobs). */
  freelanceGetAutoEarnSettings: () =>
    electroviewRpc.request["freelance.autoearn.getSettings"]({}),

  /** Persist Auto-Earn settings. */
  freelanceSaveAutoEarnSettings: (params: import("../../shared/rpc/freelance").FreelanceAutoEarnSettingsDto) =>
    electroviewRpc.request["freelance.autoearn.saveSettings"](params),

  // ---- Auto-Earn outbox (approval queue) -----------------------------------
  freelanceOutboxList: (status?: string) =>
    electroviewRpc.request["freelance.outbox.list"]({ status }),
  freelanceOutboxDraftReply: (threadId: string, platform?: string) =>
    electroviewRpc.request["freelance.outbox.draftReply"]({ threadId, platform }),
  freelanceAnalyzeBidRequirements: (listingId: string, platform?: string) =>
    electroviewRpc.request["freelance.analyzeBidRequirements"]({ listingId, platform }),
  freelanceOutboxDraftBid: (listingId: string, platform?: string, humanAnswers?: import("../../shared/rpc/freelance").BidAnswerDto[]) =>
    electroviewRpc.request["freelance.outbox.draftBid"]({ listingId, platform, humanAnswers }),
  freelanceOutboxUpdateDraft: (id: string, body: string) =>
    electroviewRpc.request["freelance.outbox.updateDraft"]({ id, body }),
  freelanceOutboxApproveSend: (id: string, userInitiated?: boolean) =>
    electroviewRpc.request["freelance.outbox.approveSend"]({ id, userInitiated }),
  freelanceOutboxMarkResult: (id: string, ok: boolean, error?: string) =>
    electroviewRpc.request["freelance.outbox.markResult"]({ id, ok, error }),
  freelanceOutboxRetry: (id: string) =>
    electroviewRpc.request["freelance.outbox.retry"]({ id }),
  freelanceOutboxMarkBidPrefilled: (id: string, needsAmount?: boolean) =>
    electroviewRpc.request["freelance.outbox.markBidPrefilled"]({ id, needsAmount }),
  freelanceOutboxReject: (id: string) =>
    electroviewRpc.request["freelance.outbox.reject"]({ id }),
  freelanceOutboxGetSentBid: (listingId: string) =>
    electroviewRpc.request["freelance.outbox.getSentBid"]({ listingId }),
  freelanceOutboxGetSentReply: (threadId: string) =>
    electroviewRpc.request["freelance.outbox.getSentReply"]({ threadId }),
  freelanceOutboxKillSwitch: () =>
    electroviewRpc.request["freelance.outbox.killSwitch"]({}),
  freelanceGovernorGetState: () =>
    electroviewRpc.request["freelance.governor.getState"]({}),
  freelanceGovernorPause: (hours: number) =>
    electroviewRpc.request["freelance.governor.pause"]({ hours }),
  freelanceGovernorResume: () =>
    electroviewRpc.request["freelance.governor.resume"]({}),
  freelanceGovernorCheckStuck: () =>
    electroviewRpc.request["freelance.governor.checkStuck"]({}),

  // ---- Auto-Earn freelance-expert (jobs / escalations / earnings) ----------
  freelanceGetEscalations: (status?: "open" | "resolved" | "all") =>
    electroviewRpc.request["freelance.expert.getEscalations"]({ status }),
  freelanceResolveEscalation: (id: string) =>
    electroviewRpc.request["freelance.expert.resolveEscalation"]({ id }),
  freelanceResolveAllEscalations: () =>
    electroviewRpc.request["freelance.expert.resolveAllEscalations"]({}),
  freelanceApproveDelivery: (jobId: string) =>
    electroviewRpc.request["freelance.expert.approveDelivery"]({ jobId }),
  freelanceGetJobs: (state?: string) =>
    electroviewRpc.request["freelance.expert.getJobs"]({ state }),
  freelanceGetJobTimeline: (jobId: string) =>
    electroviewRpc.request["freelance.expert.getJobTimeline"]({ jobId }),
  freelanceGetEarnings: () =>
    electroviewRpc.request["freelance.expert.getEarnings"]({}),
} as const;
