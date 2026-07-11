/**
 * Web-mode transport for the renderer (TASK-479 / 482).
 *
 * When the React app runs in a PLAIN BROWSER (not the Electrobun native
 * webview), there is no Electroview bridge. This module provides a drop-in
 * replacement with the same `.request` / `.send` surface backed by the WS-RPC
 * client (src/shared/remote/ws-rpc-client.ts), and re-emits server broadcasts as
 * the SAME `agentdesk:*` DOM events the in-app code already listens for.
 *
 * `rpc.ts` selects this transport via `IS_REMOTE`; the Electrobun path is
 * untouched.
 *
 * NOTE: the broadcast→event map below mirrors the `messages` handlers in
 * `rpc.ts`. They must stay in sync; unifying them behind one shared map is a
 * safe follow-up once the renderer can be type-checked in this flow.
 */

import { createRelayRpcClient, type RelayRpcClient } from "../../shared/remote/relay-rpc-client";
import { createWsRpcClient } from "../../shared/remote/ws-rpc-client";
import { loadStoredPairing, isPaired, clearStoredPairing } from "../../shared/remote/web-pairing";

export { isPaired };

/** sessionStorage key carrying a one-shot reason to show on the pairing screen. */
export const REPAIR_REASON_KEY = "agentdesk:repair-reason";

/**
 * Forget the current pairing and return to the pairing screen (TASK-493 escape
 * hatch). Used both automatically when the desktop rejects us and manually from
 * the status banner, so a stale/revoked pairing can never strand the user on
 * "Connecting…" with no way to enter a new code.
 */
export function forgetRemotePairing(reason?: string): void {
  try {
    clearStoredPairing();
  } catch {
    /* ignore */
  }
  try {
    if (reason) sessionStorage.setItem(REPAIR_REASON_KEY, reason);
    else sessionStorage.removeItem(REPAIR_REASON_KEY);
  } catch {
    /* ignore */
  }
  // Hard reload so main.tsx re-evaluates `needsPairing` and renders PairingScreen.
  if (typeof window !== "undefined") window.location.reload();
}

/** True when running in a plain browser rather than the Electrobun webview. */
export const IS_REMOTE: boolean =
  typeof window !== "undefined" && !("__electrobunWebviewId" in window);

/**
 * True for a plain browser tab hitting the Vite dev server directly (`bun run
 * dev`/`run.ps1`, then http://localhost:5173). Lets local development and
 * visual/browser-automation testing skip pairing entirely and talk straight to
 * the dev-only local RPC server the Bun backend starts in this case (see
 * DEV_REMOTE_RPC_PORT in src/bun/index.ts). `import.meta.env.DEV` is always
 * false in production/canary builds, so this never affects real users.
 */
export const IS_DEV_DIRECT: boolean = IS_REMOTE && import.meta.env.DEV;

/** Must match DEV_REMOTE_RPC_PORT in src/bun/index.ts. */
const DEV_RPC_PORT = 5174;

// ---------------------------------------------------------------------------
// Broadcast method → DOM event name (mirrors rpc.ts `messages`)
// ---------------------------------------------------------------------------

const BROADCAST_EVENTS: Record<string, string> = {
  navigateTo: "agentdesk:navigate",
  showToast: "agentdesk:show-toast",
  settingsChanged: "agentdesk:settings-changed",
  maintenance: "agentdesk:maintenance",
  streamToken: "agentdesk:stream-token",
  streamReset: "agentdesk:stream-reset",
  streamComplete: "agentdesk:stream-complete",
  streamError: "agentdesk:stream-error",
  agentStatus: "agentdesk:agent-status",
  partCreated: "agentdesk:part-created",
  partUpdated: "agentdesk:part-updated",
  agentInlineStart: "agentdesk:agent-inline-start",
  agentInlineComplete: "agentdesk:agent-inline-complete",
  contextUsage: "agentdesk:context-usage",
  presentPlan: "agentdesk:plan-presented",
  kanbanTaskUpdated: "agentdesk:kanban-task-updated",
  agentSessionComplete: "agentdesk:agent-session-complete",
  messageQueueUpdated: "agentdesk:message-queue-updated",
  providerTestResult: "agentdesk:provider-test-result",
  providersChanged: "agentdesk:providers-changed",
  directorySelected: "agentdesk:directory-selected",
  collectionAttachmentFilePicked: "agentdesk:collection-attachment-file-picked",
  collectionEmbeddingModelStatus: "agentdesk:collection-embedding-model-status",
  shellApprovalRequest: "agentdesk:shell-approval-request",
  shellApprovalExpired: "agentdesk:shell-approval-expired",
  userQuestionRequest: "agentdesk:user-question-request",
  userQuestionCancel: "agentdesk:user-question-cancel",
  whatsappQR: "agentdesk:whatsapp-qr",
  whatsappStatus: "agentdesk:whatsapp-status",
  inboxMessageReceived: "agentdesk:inbox-message-received",
  inboxResponseUpdated: "agentdesk:inbox-response-updated",
  cronJobRunStateChanged: "agentdesk:cron-run-state-changed",
  schedulerInboxRunState: "agentdesk:scheduler-inbox-run-state",
  conversationTitleChanged: "agentdesk:conversation-title-changed",
  conversationUpdated: "agentdesk:conversation-updated",
  switchToConversation: "agentdesk:switch-to-conversation",
  compactionStarted: "agentdesk:compaction-started",
  conversationCompacted: "agentdesk:conversation-compacted",
  newMessage: "agentdesk:new-message",
  pmThinking: "agentdesk:pm-thinking",
  dashboardPMChunk: "agentdesk:dashboard-pm-chunk",
  dashboardPMComplete: "agentdesk:dashboard-pm-complete",
  dashboardPMToolCall: "agentdesk:dashboard-pm-tool-call",
  dashboardPMError: "agentdesk:dashboard-pm-error",
  dashboardAgentChunk: "agentdesk:dashboard-agent-chunk",
  dashboardAgentComplete: "agentdesk:dashboard-agent-complete",
  dashboardAgentToolCall: "agentdesk:dashboard-agent-tool-call",
  dashboardAgentError: "agentdesk:dashboard-agent-error",
  councilEvent: "agentdesk:council-event",
  playgroundRunStarted: "agentdesk:playground-run-started",
  playgroundPart: "agentdesk:playground-part",
  playgroundPartUpdated: "agentdesk:playground-part-updated",
  playgroundAgentStart: "agentdesk:playground-agent-start",
  playgroundAgentComplete: "agentdesk:playground-agent-complete",
  playgroundRunComplete: "agentdesk:playground-run-complete",
  playgroundRunError: "agentdesk:playground-run-error",
  playgroundPreviewReady: "agentdesk:playground-preview-ready",
  playgroundRejected: "agentdesk:playground-rejected",
  playgroundReset: "agentdesk:playground-reset",
  playgroundFilesChanged: "agentdesk:playground-files-changed",
  issueFixerRunStarted: "agentdesk:issuefixer-run-started",
  issueFixerPart: "agentdesk:issuefixer-part",
  issueFixerPartUpdated: "agentdesk:issuefixer-part-updated",
  issueFixerRunComplete: "agentdesk:issuefixer-run-complete",
  issueFixerRunError: "agentdesk:issuefixer-run-error",
  remoteSyncRunStarted: "agentdesk:remotesync-run-started",
  remoteSyncProgress: "agentdesk:remotesync-progress",
  remoteSyncRunComplete: "agentdesk:remotesync-run-complete",
  remoteSyncRunError: "agentdesk:remotesync-run-error",
  remoteSyncLog: "agentdesk:remotesync-log",
  activityUpdated: "agentdesk:activity-updated",
  projectsUpdated: "agentdesk:projects-updated",
  recommendationStatusChanged: "agentdesk:recommendation-status-changed",
  updateStatus: "agentdesk:update-status",
  "freelance.fetchStarted": "agentdesk:freelance-fetch-started",
  "freelance.listingsUpdated": "agentdesk:freelance-listings-updated",
  "freelance.inbox.updated": "agentdesk:freelance-inbox-updated",
  "freelance.inbox.newMessage": "agentdesk:freelance-inbox-new-message",
  "freelance.outbox.updated": "agentdesk:freelance-outbox-updated",
  "freelance.governor.blocked": "agentdesk:freelance-governor-blocked",
  "freelance.account.statusChanged": "agentdesk:freelance-account-status-changed",
  "freelance.escalation.created": "agentdesk:freelance-escalation-created",
  "freelance.escalation.resolved": "agentdesk:freelance-escalation-resolved",
  "freelance.job.updated": "agentdesk:freelance-job-updated",
  "freelance.chat.fetching": "agentdesk:freelance-chat-fetching",
  "freelance.chat.fetch_done": "agentdesk:freelance-chat-fetch-done",
  "freelance.chat.tool_start": "agentdesk:freelance-chat-tool-start",
  "freelance.chat.tool_done": "agentdesk:freelance-chat-tool-done",
  "freelance.chat.token": "agentdesk:freelance-chat-token",
  "freelance.chat.complete": "agentdesk:freelance-chat-complete",
  "freelance.chat.error": "agentdesk:freelance-chat-error",
  "freelance.chat.stopped": "agentdesk:freelance-chat-stopped",
  "skillsChat.toolStart": "agentdesk:skills-chat-tool-start",
  "skillsChat.toolDone": "agentdesk:skills-chat-tool-done",
  "skillsChat.token": "agentdesk:skills-chat-token",
  "skillsChat.complete": "agentdesk:skills-chat-complete",
  "skillsChat.error": "agentdesk:skills-chat-error",
  "skillsChat.stopped": "agentdesk:skills-chat-stopped",
  "skillsChat.registryRefreshed": "agentdesk:skills-chat-registry-refreshed",
  "freelance.wizard.progress": "agentdesk:freelance-wizard-progress",
  "freelance.wizard.complete": "agentdesk:freelance-wizard-complete",
  "freelance.wizard.error": "agentdesk:freelance-wizard-error",
  "freelance.wizard.stopped": "agentdesk:freelance-wizard-stopped",
};

/** Fallback for any unmapped method: agentdesk:<kebab-of-method>. */
function fallbackEventName(method: string): string {
  const kebab = method
    .replace(/\./g, "-")
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return `agentdesk:${kebab}`;
}

/** Re-emit a server broadcast as the matching `agentdesk:*` DOM event. */
export function dispatchRemoteBroadcast(method: string, payload: unknown): void {
  const eventName = BROADCAST_EVENTS[method] ?? fallbackEventName(method);
  window.dispatchEvent(new CustomEvent(eventName, { detail: payload }));
}

// ---------------------------------------------------------------------------
// Transport — connects to the desktop over the relay using the stored pairing.
// ---------------------------------------------------------------------------

export interface RemoteTransport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: any;
}

/**
 * Build a `.request` / `.send` transport for web mode. Loads the stored pairing
 * and re-derives the E2E session asynchronously; requests issued before it is
 * ready await that. If the device is not paired, requests reject so the UI can
 * route to the pairing screen.
 */
export function createRemoteRpcTransport(): RemoteTransport {
  let relayClient: RelayRpcClient | null = null;

  const ready = (async () => {
    const active = await loadStoredPairing();
    if (!active) return;
    relayClient = createRelayRpcClient({
      relayWss: active.relayWss,
      clientToken: active.clientToken,
      pairingId: active.pairingId,
      clientPublicKeyB64: active.clientPublicKeyB64,
      sessionKey: active.sessionKey,
      onBroadcast: (method, payload) => dispatchRemoteBroadcast(method, payload),
      onRejected: () => {
        // The desktop refused this pairing (revoked / removed / expired). Clear
        // the dead pairing and return to the pairing screen with a reason, so
        // the user can paste a fresh code instead of staring at "Connecting…".
        forgetRemotePairing("This device was removed. Enter a new pairing code from the desktop.");
      },
      onStatus: (status) => {
        // Stash the latest status so a late-mounting banner can read it without
        // missing an early "online" event.
        const w = window as { __agentdeskRemoteStatus?: string };
        const prev = w.__agentdeskRemoteStatus;
        w.__agentdeskRemoteStatus = status;
        window.dispatchEvent(new CustomEvent("agentdesk:remote-status", { detail: { status } }));
        // Came back online after a drop → re-surface approvals broadcast during
        // the gap (TASK-478 durability). `prev` is defined only after the first
        // connect, so the initial "online" doesn't count as a reconnect.
        if (status === "online" && prev && prev !== "online") {
          window.dispatchEvent(new CustomEvent("agentdesk:remote-reconnected"));
        }
      },
    });
  })().catch(() => undefined);

  return {
    request: new Proxy(
      {},
      {
        get: (_t, method: string) => async (params: unknown) => {
          await ready;
          if (!relayClient) throw new Error("not paired — connect this browser to your desktop first");
          return relayClient.request(method, params);
        },
      },
    ),
    // Fire-and-forget messages (e.g. renderer logs) stay local in web mode.
    send: new Proxy({}, { get: () => () => undefined }),
  };
}

/**
 * Build a `.request` / `.send` transport for local dev browser testing
 * (IS_DEV_DIRECT). Connects straight to the dev-only local RPC server over
 * plaintext WebSocket — no pairing, no relay, no encryption — since both ends
 * are the same machine's dev build.
 */
export function createDevRpcTransport(): RemoteTransport {
  const client = createWsRpcClient({
    url: `ws://localhost:${DEV_RPC_PORT}`,
    onBroadcast: (method, payload) => dispatchRemoteBroadcast(method, payload),
  });

  return {
    request: new Proxy(
      {},
      { get: (_t, method: string) => (params: unknown) => client.request(method, params) },
    ),
    send: new Proxy({}, { get: () => () => undefined }),
  };
}
