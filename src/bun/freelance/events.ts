// Centralised event name constants for broadcastToWebview calls in the
// freelance subsystem. Using this module prevents typos and makes it easy
// to audit which events the frontend subscribes to.
export const FREELANCE_EVENTS = {
  // General listing lifecycle
  LISTINGS_UPDATED: "freelance.listingsUpdated",
  FETCH_STARTED: "freelance.fetchStarted",

  // Find-workable wizard
  WIZARD_PROGRESS: "freelance.wizard.progress",
  WIZARD_COMPLETE: "freelance.wizard.complete",
  WIZARD_STOPPED: "freelance.wizard.stopped",
  WIZARD_ERROR: "freelance.wizard.error",

  // Per-listing chat streaming
  CHAT_FETCHING: "freelance.chat.fetching",
  CHAT_FETCH_DONE: "freelance.chat.fetch_done",
  CHAT_TOOL_START: "freelance.chat.tool_start",
  CHAT_TOOL_DONE: "freelance.chat.tool_done",
  CHAT_TOKEN: "freelance.chat.token",
  CHAT_COMPLETE: "freelance.chat.complete",
  CHAT_ERROR: "freelance.chat.error",
  CHAT_STOPPED: "freelance.chat.stopped",
} as const;
