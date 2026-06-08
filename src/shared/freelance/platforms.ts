// ---------------------------------------------------------------------------
// Auto-Earn — Platform descriptors (the extension seam)
//
// One source of truth for everything platform-specific in the Auto-Earn engine:
// URLs, which network endpoints to intercept + how to classify them, and (later)
// the write-step selectors used to type+send a reply. Shared by Bun (normalizer/
// ingest/correlation) AND the frontend interceptor so there is no duplication.
//
// Adding a platform (PeoplePerHour, Upwork) = one new descriptor here. No engine
// changes elsewhere.
// ---------------------------------------------------------------------------

// PeoplePerHour was removed; may return in future. Keep the type open to one id.
export type PlatformId = "freelancer";

export type CaptureEndpoint = "threads" | "messages" | "users" | "self" | "projects";

export interface EndpointRule {
  /** URL substring that identifies this endpoint. */
  path: string;
  endpoint: CaptureEndpoint;
}

/** Selectors/scripts for the WRITE path (typing + sending a reply in the page). */
export interface ComposerConfig {
  /** CSS selector(s) for the message input (first match wins). */
  inputSelectors: string[];
  /** CSS selector(s) for the send button. */
  sendSelectors: string[];
}

export interface PlatformDescriptor {
  id: PlatformId;
  label: string;
  loginUrl: string;
  inboxUrl: string;
  /** Cookie domain used for Session-based logged-in detection. */
  cookieDomain: string;
  /** Deep link to a single conversation. */
  threadUrl: (threadId: string) => string;
  /** Deep link to a listing/project (for bidding). */
  listingUrl: (listingId: string) => string;
  /** Endpoints whose JSON responses we tee out of the page. */
  endpoints: EndpointRule[];
  /** Reply composer selectors (write path). */
  composer: ComposerConfig;
}

export const FREELANCER: PlatformDescriptor = {
  id: "freelancer",
  label: "Freelancer.com",
  loginUrl: "https://www.freelancer.com/login",
  inboxUrl: "https://www.freelancer.com/messages",
  cookieDomain: "freelancer.com",
  threadUrl: (id) => `https://www.freelancer.com/messages/thread/${id}`,
  listingUrl: (id) => `https://www.freelancer.com/projects/${id}`,
  endpoints: [
    { path: "/messages/0.1/threads", endpoint: "threads" },
    { path: "/messages/0.1/messages", endpoint: "messages" },
    { path: "/users/0.1/self", endpoint: "self" },
    { path: "/users/0.1/users", endpoint: "users" },
    { path: "/projects/0.1/projects", endpoint: "projects" },
  ],
  // Freelancer's message composer (best-effort; tune from live DOM if it drifts).
  composer: {
    inputSelectors: [
      "textarea[name='message']",
      "textarea[placeholder*='message' i]",
      "div[contenteditable='true']",
      "textarea",
    ],
    sendSelectors: [
      "button[type='submit']",
      "button[aria-label*='send' i]",
      "fl-button[aria-label*='send' i] button",
    ],
  },
};

const REGISTRY: Record<PlatformId, PlatformDescriptor> = {
  freelancer: FREELANCER,
};

export function getPlatform(id: string): PlatformDescriptor {
  return REGISTRY[(id as PlatformId)] ?? FREELANCER;
}

/** Classify a captured URL against a platform's endpoint rules (or null). */
export function classifyEndpoint(platformId: string, url: string): CaptureEndpoint | null {
  const u = String(url);
  for (const rule of getPlatform(platformId).endpoints) {
    if (u.includes(rule.path)) return rule.endpoint;
  }
  return null;
}

/** The list of endpoint path substrings to match inside the page interceptor. */
export function endpointPaths(platformId: string): string[] {
  return getPlatform(platformId).endpoints.map((e) => e.path);
}
