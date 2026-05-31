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

export type FreelanceRequests = {
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
      // NOTE: lastRun and lastCount are NOT here — set by the runner, not the user
    };
    response: { success: boolean };
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
  "freelance.deleteAllListings": {
    params: Record<string, never>;
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
