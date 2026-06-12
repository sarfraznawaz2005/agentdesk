export type FreelanceListingStatus = "new" | "approved" | "closed" | "shortlisted";

export interface FreelanceChatMessageDto {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface FreelanceListingDto {
  id: string;
  platform: string;
  title: string;
  description: string;
  skills: string[];
  budgetType: "fixed" | "hourly";
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string;
  url: string;
  postedAt: string | null;
  status: FreelanceListingStatus;
  projectId: string | null;
  fetchedAt: string;
  wizardVerdict: "workable" | "not_workable" | null;
  wizardReason: string | null;
  wizardBlockers: string[] | null;
  wizardAnalysisText: string | null;
  /** True when a bid for this listing has already been sent (outbox status = 'sent'). */
  hasBid: boolean;
  /** Full description extracted from the listing page. null = never fetched, "" = fetch failed. */
  fullDescription: string | null;
}

export interface WizardWorkableListing {
  id: string;
  title: string;
  budgetMin: number | null;
  budgetMax: number | null;
  budgetType: "fixed" | "hourly";
  currency: string;
}

export interface WizardFailedListing {
  id: string;
  title: string;
  reason: string;
  blockers: string[];
}

// ─── Auto-Earn inbox (read-only v1) ───────────────────────────────────────────

export interface FreelanceAccountDto {
  connected: boolean;
  platform: string;
  displayName: string | null;
  selfUserId: string | null;
  lastSyncAt: string | null;
  autonomyMode: "assisted" | "full_auto";
}

export interface FreelanceInboxThreadDto {
  id: string;
  clientUserId: string | null;
  clientName: string | null;
  threadType: string | null;
  contextType: string | null;
  contextId: string | null;
  title: string | null;
  listingId: string | null;
  linkConfidence: string | null;
  lastMessageText: string | null;
  lastMessageFrom: string | null;
  lastMessageAt: number | null;
  unread: number;
  url: string | null;
}

export interface FreelanceAutoEarnSettingsDto {
  enabled: boolean;
  autonomyMode: "assisted" | "full_auto";
  pollMin: number;
  pollMax: number;
  activeHours: { start: number; end: number };
  maxSendsPerHour: number;
  bidDailyCap: number;      // hard daily budget for bids (0 = no daily cap)
  minGapSeconds: number;
  fullautoAck: boolean;
  notifyDesktop: boolean;   // desktop notification on a new client reply
  notifyChannels: boolean;  // forward new client reply to connected channels
  bidDeliveryDays: number;  // default "delivered in" days prefilled on a bid
  bidStaleHours: number;    // auto-dismiss awaiting_review bids older than this (0 = never)
  autoBidShortlisted: boolean; // auto-draft a proposal when a listing is auto-shortlisted
  bidPricingMode: string;   // "avg" | "min" | "max" | "percentile"
  bidPercentile: number;    // 0-100 position in the budget range (mode = percentile)
  bidMinClamp: number;      // absolute floor for the bid amount (0 = none)
  bidMaxClamp: number;      // absolute ceiling for the bid amount (0 = none)
  bidHourlyRate: number;    // rate to bid on hourly projects (0 = use the budget)
  clientFilterEnabled: boolean; // filter out low-quality clients before AI analysis
  clientMinReviews: number;     // block clients with fewer than this many reviews (0 = disabled)
  clientBlockNewDays: number;   // block clients who joined within this many days (0 = disabled)
}

export interface FreelanceGovernorActionStateDto {
  usedThisHour: number;
  cap: number;
  nextAllowedInMs: number;
}
export interface FreelanceGovernorStateDto {
  withinActiveHours: boolean;
  pausedUntilMs: number; // 0 if not paused
  reply: FreelanceGovernorActionStateDto;
  bid: FreelanceGovernorActionStateDto;
}

export interface FreelanceOutboxItemDto {
  id: string;
  platform: string;
  kind: string; // reply | bid
  threadId: string | null;
  listingId: string | null;
  draftBody: string;
  status: string; // draft|approved|sending|sent|failed|rejected
  autonomyMode: string;
  createdAt: string;
  error?: string | null; // populated when status === 'failed'
}

export interface FreelanceInboxMessageDto {
  id: string;
  threadId: string;
  fromUser: string | null;
  fromName: string | null;
  body: string;
  sentAt: number | null;
  outbound: boolean;
}

// ─── freelance-expert (autonomous pipeline) ──────────────────────────────────

export interface FreelanceEscalationDto {
  id: string;
  jobId: string | null;
  platform: string | null;
  threadId: string | null;
  reason: string;
  detail: string | null;
  severity: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface FreelanceJobDto {
  id: string;
  platform: string;
  threadId: string | null;
  listingId: string | null;
  projectId: string | null;
  title: string | null;
  state: string;
  bidAmount: number | null;
  currency: string | null;
  earned: number;
  awardedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FreelanceEarningsDto {
  bidsSent: number;
  jobsWon: number;
  delivered: number;
  openEscalations: number;
  earned: number;
  conversionPct: number;       // bids → jobs won (%)
  avgResponseMinutes: number;  // avg time from a client message to our reply (0 = n/a)
}

export type FreelanceRequests = {
  "freelance.expert.getEscalations": {
    params: { status?: "open" | "resolved" | "all" };
    response: { items: FreelanceEscalationDto[] };
  };
  "freelance.expert.resolveEscalation": {
    params: { id: string };
    response: { success: boolean };
  };
  "freelance.expert.resolveAllEscalations": {
    params: Record<string, never>;
    response: { resolved: number };
  };
  "freelance.expert.approveDelivery": {
    params: { jobId: string };
    response: { success: boolean };
  };
  "freelance.expert.getJobs": {
    params: { state?: string };
    response: { jobs: FreelanceJobDto[] };
  };
  "freelance.expert.getJobTimeline": {
    params: { jobId: string };
    response: { entries: Array<{ action: string; detail: string | null; outcome: string; createdAt: string }> };
  };
  "freelance.expert.getEarnings": {
    params: Record<string, never>;
    response: FreelanceEarningsDto;
  };
  "freelance.inbox.ingest": {
    params: { platform?: string; records: Array<{ url: string; body: string }> };
    response: { threads: number; messages: number; users: number };
  };
  "freelance.inbox.getAccount": {
    params: { platform?: string };
    response: FreelanceAccountDto;
  };
  "freelance.inbox.logSync": {
    params: { platform?: string; source?: string };
    response: { success: boolean };
  };
  "freelance.session.anomaly": {
    params: { platform?: string; kind: string; detail?: string };
    response: { paused: boolean; pausedUntil: string | null };
  };
  "freelance.account.disconnect": {
    params: { platform?: string };
    response: { success: boolean };
  };
  "freelance.account.setAutonomy": {
    params: { platform?: string; mode: "assisted" | "full_auto" };
    response: { success: boolean };
  };
  "freelance.autoearn.isAvailable": {
    params: Record<string, never>;
    response: { available: boolean };
  };
  "freelance.autoearn.getSettings": {
    params: Record<string, never>;
    response: FreelanceAutoEarnSettingsDto;
  };
  "freelance.autoearn.saveSettings": {
    params: FreelanceAutoEarnSettingsDto;
    response: { success: boolean };
  };
  "freelance.outbox.list": {
    params: { status?: string };
    response: { items: FreelanceOutboxItemDto[] };
  };
  "freelance.outbox.draftReply": {
    params: { threadId: string; platform?: string };
    response: { item: FreelanceOutboxItemDto };
  };
  "freelance.outbox.draftBid": {
    params: { listingId: string; platform?: string };
    response: { item: FreelanceOutboxItemDto };
  };
  "freelance.outbox.updateDraft": {
    params: { id: string; body: string };
    response: { success: boolean };
  };
  "freelance.outbox.approveSend": {
    params: { id: string; userInitiated?: boolean };
    response: {
      allowed: boolean;
      reason?: string;
      platform: string;
      kind: string;
      threadId: string | null;
      listingId: string | null;
      listingUrl?: string | null; // real platform URL for bids (avoids /projects/<dbId> 404)
      body: string;
      bidAmount?: number | null;  // avg of budget range / single value / null = user fills
      bidDays?: number;           // delivery period to prefill
      autoPlace?: boolean;        // full-auto + known amount → script clicks Place Bid
    };
  };
  "freelance.outbox.retry": {
    params: { id: string };
    response: { success: boolean };
  };
  "freelance.outbox.markBidPrefilled": {
    params: { id: string; needsAmount?: boolean };
    response: { success: boolean };
  };
  "freelance.outbox.markResult": {
    params: { id: string; ok: boolean; error?: string };
    response: { success: boolean };
  };
  "freelance.outbox.reject": {
    params: { id: string };
    response: { success: boolean };
  };
  "freelance.outbox.killSwitch": {
    params: Record<string, never>;
    response: { success: boolean; halted: number };
  };
  "freelance.governor.getState": {
    params: Record<string, never>;
    response: FreelanceGovernorStateDto;
  };
  "freelance.governor.pause": {
    params: { hours: number };
    response: { pausedUntil: string | null };
  };
  "freelance.governor.resume": {
    params: Record<string, never>;
    response: { success: boolean };
  };
  "freelance.governor.checkStuck": {
    params: Record<string, never>;
    response: { success: boolean };
  };
  "freelance.inbox.getThreads": {
    params: { platform?: string; search?: string };
    response: { threads: FreelanceInboxThreadDto[] };
  };
  "freelance.inbox.getMessages": {
    params: { threadId: string; platform?: string };
    response: { messages: FreelanceInboxMessageDto[] };
  };
  "freelance.getFeatureEnabled": {
    params: Record<string, never>;
    response: { enabled: boolean };
  };
  "freelance.getSettings": {
    params: Record<string, never>;
    response: {
      rssSources: Array<{ name: string; url: string; enabled: boolean }>;
      keywords: string[];
      pollingInterval: number;
      maxFeeds: number;
      maxListings: number;
      autoShortlistEnabled: boolean;
      autoShortlistCount: number;
      autoShortlistOnStartup: boolean;
      autoShortlistLastRun: string | null;
      autoShortlistLastCount: number;
      analysisProviderId: string | null;
      additionalNotes: string;
      preferredCurrency: string;
    };
  };
  "freelance.saveSettings": {
    params: {
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
      // NOTE: lastRun and lastCount are NOT here — set by the runner, not the user
    };
    response: { success: boolean };
  };
  "freelance.getCurrencyRates": {
    params: Record<string, never>;
    response: {
      rates: Record<string, number>;
      fetchedAt: string | null;
    };
  };
  "freelance.getListings": {
    params: { status?: FreelanceListingStatus; page?: number; search?: string };
    response: {
      listings: FreelanceListingDto[];
      total: number;
      page: number;
    };
  };
  "freelance.getListingCounts": {
    params: Record<string, never>;
    response: { new: number; approved: number; shortlisted: number; closed: number; all: number };
  };
  "freelance.markListingDone": {
    params: { listingId: string };
    response: { success: boolean };
  };
  "freelance.approveListing": {
    params: { listingId: string };
    response: { projectId: string };
  };
  "freelance.deleteListing": {
    params: { listingId: string };
    response: { success: boolean };
  };
  "freelance.triggerFetch": {
    params: Record<string, never>;
    response: { success: boolean; skipped?: boolean; reason?: string };
  };
  "freelance.deleteListings": {
    params: { ids: string[] };
    response: { success: boolean; deleted: number };
  };
  "freelance.chat.getMessages": {
    params: { listingId: string };
    response: { messages: FreelanceChatMessageDto[] };
  };
  "freelance.chat.sendMessage": {
    params: { listingId: string; content: string };
    response: { success: boolean; messageId: string };
  };
  "freelance.chat.regenerate": {
    params: { listingId: string };
    response: { success: boolean; messageId: string };
  };
  "freelance.chat.clearMessages": {
    params: { listingId: string };
    response: { success: boolean };
  };
  "freelance.chat.stop": {
    params: { listingId: string };
    response: { success: boolean };
  };
  "freelance.wizard.start": {
    params: { count: number };
    response: { success: boolean };
  };
  "freelance.wizard.stop": {
    params: Record<string, never>;
    response: { success: boolean };
  };
  "freelance.wizard.analyzeListing": {
    params: { listingId: string };
    response: {
      verdict: "workable" | "not_workable";
      reason: string;
      blockers: string[];
      analysisText: string;
    };
  };
  "freelance.shortlistListings": {
    params: { listingIds: string[] };
    response: { success: boolean };
  };
};
