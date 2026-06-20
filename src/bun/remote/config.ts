/**
 * Relay endpoint configuration (Model A — Cloudflare free tier).
 *
 * Baked into the build; overridable via env for local development against a
 * `wrangler dev` relay (e.g. AGENTDESK_RELAY_HTTP=http://127.0.0.1:8787).
 *
 * The production relay is deployed under TASK-473; until then these defaults
 * point at the (future) fixed URL and local dev uses the env override.
 */

const DEFAULT_RELAY_HTTP = "https://relay.agentdesk.workers.dev";
const DEFAULT_WEB_URL = "https://agentdeskweb.pages.dev";

export const RELAY_HTTP: string = process.env.AGENTDESK_RELAY_HTTP || DEFAULT_RELAY_HTTP;
export const RELAY_WSS: string = RELAY_HTTP.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
export const WEB_URL: string = process.env.AGENTDESK_WEB_URL || DEFAULT_WEB_URL;
export const RELAY_CONFIGURED: boolean = RELAY_HTTP.length > 0;
