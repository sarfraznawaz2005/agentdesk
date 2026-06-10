// ---------------------------------------------------------------------------
// Auto-Earn — Inbox (read-only v1)
//
// Two regions:
//   • INBOX (top): your normalized Freelancer messages, read from the DB —
//     thread list + selected conversation. Updates live as data syncs.
//   • LIVE SESSION (bottom, collapsible): the embedded Freelancer webview that
//     IS the sync engine. A preload-style interceptor (injected on navigation)
//     tees the platform's own messaging JSON and forwards it to Bun, which
//     normalizes + stores it. You log in / browse here; the inbox above fills in.
//
// Nothing is ever requested by Bun directly — every network call stays inside
// the genuine browser session, so it is indistinguishable from normal usage.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { useFreelanceEngineStore } from "@/stores/freelance-engine-store";
import { getPlatform, endpointPaths } from "../../../shared/freelance/platforms";
import { buildSendReplyScript, buildSubmitBidScript } from "../../../shared/freelance/write-steps";
import {
  attachSessionWebview,
  detachSessionWebview,
  setSessionWebviewVisible,
} from "./session-webview-host";
import type {
  FreelanceAccountDto,
  FreelanceInboxThreadDto,
  FreelanceInboxMessageDto,
  FreelanceOutboxItemDto,
  FreelanceGovernorStateDto,
} from "../../../shared/rpc/freelance";

const PLATFORM = "freelancer";
const DESC = getPlatform(PLATFORM);
const LOGIN_URL = DESC.loginUrl;
const INBOX_URL = DESC.inboxUrl;

// Injected into the embedded page. Tees responses from the platform's messaging
// endpoints (full JSON) back to the host; capped to avoid flooding the bridge.
// The endpoint path list comes from the shared platform descriptor.
const ENDPOINT_PATHS_JSON = JSON.stringify(endpointPaths(PLATFORM));
const INTERCEPTOR_SRC = `
(function(){
  if (window.__flInbox) return;
  window.__flInbox = true;
  var PATHS = ${ENDPOINT_PATHS_JSON};
  function matches(u){ u = String(u); for (var i=0;i<PATHS.length;i++){ if (u.indexOf(PATHS[i]) !== -1) return true; } return false; }
  var n = 0;
  function send(url, body){
    try {
      if (n++ > 800) return;
      if (window.__electrobunSendToHost) window.__electrobunSendToHost({
        type:'fl-rec', url:String(url).slice(0,400),
        body: typeof body==='string' ? body.slice(0,200000) : ''
      });
    } catch(e){}
  }
  // Anomaly reporting (circuit breaker feed): 429 anywhere, 403 on the messaging
  // API, or a captcha/challenge page. Throttled in-page; the host pauses autonomy.
  var lastAnom = 0;
  function anomaly(kind, detail){
    try {
      var t = Date.now();
      if (t - lastAnom < 300000) return; // one per 5 min
      lastAnom = t;
      if (window.__electrobunSendToHost) window.__electrobunSendToHost({ type:'fl-anomaly', kind:kind, error:String(detail||'').slice(0,300) });
    } catch(e){}
  }
  function checkStatus(url, status){
    if (status === 429) anomaly('rate_limit', 'HTTP 429 on ' + String(url).slice(0,200));
    else if (status === 403 && matches(url)) anomaly('forbidden', 'HTTP 403 on ' + String(url).slice(0,200));
  }
  function checkCaptcha(){
    try {
      if (document.querySelector('iframe[src*="captcha" i], .g-recaptcha, #challenge-form, [class*="cf-challenge"]')
          || /just a moment|attention required|are you a robot|unusual activity/i.test(document.title||'')) {
        anomaly('captcha', 'captcha/challenge detected on ' + location.pathname);
      }
    } catch(e){}
  }
  setTimeout(checkCaptcha, 3000);
  setInterval(checkCaptcha, 45000);
  var of = window.fetch;
  if (of) window.fetch = function(){
    var a = arguments; var url = (a[0] && a[0].url) ? a[0].url : a[0];
    return of.apply(this, a).then(function(resp){
      try { checkStatus(url, resp.status); } catch(e){}
      try { if (matches(url)) resp.clone().text().then(function(t){ send(url, t); }).catch(function(){}); } catch(e){}
      return resp;
    });
  };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ this.__u=u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(){
    var x=this;
    this.addEventListener('load', function(){
      try { checkStatus(x.__u, x.status); } catch(e){}
      try { if (matches(x.__u)) send(x.__u, x.responseText); } catch(e){}
    });
    return os.apply(this, arguments);
  };
  // Realtime: tap the platform's own notification socket. When a frame mentions a
  // new message/thread, nudge the host to refresh (throttled) — near-real-time
  // without polling, using the page's own socket.
  try {
    var OW = window.WebSocket;
    if (OW) {
      var lastHint = 0;
      var Patched = function(url, protocols){
        var ws = protocols ? new OW(url, protocols) : new OW(url);
        ws.addEventListener('message', function(ev){
          try {
            var d = ev.data;
            if (typeof d === 'string' && /message|thread|inbox/i.test(d)) {
              var t = Date.now();
              if (t - lastHint > 4000) {
                lastHint = t;
                if (window.__electrobunSendToHost) window.__electrobunSendToHost({ type:'fl-ws' });
              }
            }
          } catch(e){}
        });
        return ws;
      };
      Patched.prototype = OW.prototype;
      Patched.CONNECTING = OW.CONNECTING; Patched.OPEN = OW.OPEN; Patched.CLOSING = OW.CLOSING; Patched.CLOSED = OW.CLOSED;
      window.WebSocket = Patched;
    }
  } catch(e){}
})();
`;

// Active profile-skills capture. Asks the platform for our OWN profile including
// skills ("jobs"). The interceptor above (installed immediately before this runs)
// patches window.fetch, so this request is tee'd through the normal
// /users/0.1/self ingest path — which extracts + caches the skill names. The
// shortlist engine then uses them to pre-filter projects we cannot bid on
// (Freelancer blocks bidding unless the profile shares a skill with the project).
// Best-effort: a logged-out 401 simply yields no skills (fail-open downstream).
const PROFILE_SKILLS_SRC = `
(function(){
  try {
    fetch('https://www.freelancer.com/api/users/0.1/self?jobs=true&webapp=1&compact=true&new_errors=true&new_pools=true', { credentials: 'include' }).catch(function(){});
  } catch(e){}
})();
`;

// Profile skills change rarely — refresh at most once every few hours per app run.
const PROFILE_SKILLS_REFRESH_MS = 6 * 60 * 60 * 1000;
let lastProfileSkillsFetch = 0;

type WebviewTagEl = HTMLElement & {
  loadURL?: (url: string) => void;
  reload?: () => void;
  executeJavascript?: (js: string) => void;
  toggleHidden?: (hidden?: boolean) => void;
  on?: (name: string, handler: (e: unknown) => void) => void;
  off?: (name: string, handler: (e: unknown) => void) => void;
};

function parseHostMessage(
  e: unknown,
): { type?: string; url?: string; body?: string; ok?: boolean; error?: string; kind?: string } | null {
  const ev = e as { detail?: unknown };
  let d = ev?.detail;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (d && typeof d === "object") return d as { type?: string; url?: string; body?: string; ok?: boolean; error?: string; kind?: string };
  return null;
}

// A textarea that grows/shrinks to fit its content (no inner scrollbar). Stays
// uncontrolled (defaultValue + onBlur) so typing never re-renders the list.
function AutoGrowTextarea({
  defaultValue,
  onBlur,
  className,
}: {
  defaultValue: string;
  onBlur: (value: string) => void;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const lastWidth = useRef(0);
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(() => {
    resize();
  }, [resize, defaultValue]);
  // The inbox engine is always mounted (often in a hidden container), so this
  // textarea may first render with 0 width → scrollHeight 0 → collapsed. Recompute
  // when its width changes (i.e. when it becomes visible / the layout shifts).
  // Guard on width so our own height changes don't cause a feedback loop.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth;
      if (w !== lastWidth.current) {
        lastWidth.current = w;
        resize();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [resize]);
  return (
    <textarea
      ref={ref}
      defaultValue={defaultValue}
      onInput={resize}
      onBlur={(e) => onBlur(e.target.value)}
      rows={1}
      style={{ overflow: "hidden" }}
      className={className}
    />
  );
}

function navUrl(e: unknown): string | null {
  const ev = e as { detail?: unknown; data?: unknown };
  const d = ev?.detail ?? ev?.data;
  if (typeof d === "string") return d;
  if (d && typeof d === "object") {
    const o = d as { url?: string; detail?: string };
    return o.url ?? o.detail ?? null;
  }
  return null;
}

// Current hour (0–23) in the given IANA timezone (from General settings); empty
// string falls back to OS local time. Mirrors the governor's server-side logic.
function hourInTz(tz: string): number {
  if (!tz) return new Date().getHours();
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date());
    const h = parseInt(s, 10);
    if (!Number.isFinite(h)) return new Date().getHours();
    return h === 24 ? 0 : h;
  } catch {
    return new Date().getHours();
  }
}

function fmtTime(sec: number | null): string {
  if (!sec) return "";
  try {
    return new Date(sec * 1000).toLocaleString();
  } catch {
    return "";
  }
}

export function InboxTab() {
  const wvRef = useRef<WebviewTagEl | null>(null);
  const holderRef = useRef<HTMLDivElement | null>(null);
  const bufferRef = useRef<Array<{ url: string; body: string }>>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [account, setAccount] = useState<FreelanceAccountDto | null>(null);
  const [threads, setThreads] = useState<FreelanceInboxThreadDto[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<FreelanceInboxMessageDto[]>([]);
  const [sessionOpen, setSessionOpen] = useState(true);
  // The webview tag is registered by Electrobun's preload before app JS runs, so
  // we can determine availability once at mount (no setState in an effect).
  const [runtimeAvailable] = useState(
    () => typeof customElements !== "undefined" && !!customElements.get("electrobun-webview"),
  );
  const [outbox, setOutbox] = useState<FreelanceOutboxItemDto[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The in-flight send awaiting its fl-send-result host-message.
  const pendingSend = useRef<{ id: string } | null>(null);
  // A send we gave up on (safety timeout) — if its result arrives late we correct
  // the record, so a slow-but-successful send is never left marked 'failed'
  // (retrying a send that actually went through double-messages the client).
  const timedOutSend = useRef<{ id: string; at: number } | null>(null);
  // Client-side throttle for anomaly reports (the page also throttles).
  const lastAnomalyAt = useRef(0);
  const sendingIdRef = useRef<string | null>(null);
  useEffect(() => {
    sendingIdRef.current = sendingId;
  }, [sendingId]);
  const wsReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Global timezone (General settings) used for active-hours; "" = OS local.
  const tzRef = useRef<string>("");
  useEffect(() => {
    rpc
      .getSettings("general")
      .then((g) => {
        tzRef.current = (g as Record<string, unknown>)?.timezone as string ?? "";
      })
      .catch(() => {});
  }, []);

  const refreshAccount = useCallback(() => {
    rpc.freelanceInboxGetAccount().then(setAccount).catch(() => {});
  }, []);

  const refreshThreads = useCallback(() => {
    rpc
      .freelanceInboxGetThreads(search || undefined)
      .then((r) => setThreads(r.threads))
      .catch(() => {});
  }, [search]);

  const loadMessages = useCallback((threadId: string) => {
    rpc
      .freelanceInboxGetMessages(threadId)
      .then((r) => setMessages(r.messages))
      .catch(() => {});
  }, []);

  const refreshOutbox = useCallback(() => {
    rpc
      .freelanceOutboxList()
      .then((r) => setOutbox(r.items))
      .catch(() => {});
  }, []);

  // Governor visibility (sends used / caps / next-allowed / pause) — polled so the
  // figures stay current, and refreshed on outbox changes.
  const [gov, setGov] = useState<FreelanceGovernorStateDto | null>(null);
  const refreshGov = useCallback(() => {
    rpc.freelanceGovernorGetState().then(setGov).catch(() => {});
  }, []);
  useEffect(() => {
    refreshGov();
    const t = setInterval(refreshGov, 15_000);
    return () => clearInterval(t);
  }, [refreshGov]);
  const pauseFor = useCallback((hours: number) => {
    rpc.freelanceGovernorPause(hours).then(refreshGov).catch(() => {});
  }, [refreshGov]);
  const resumeAutonomy = useCallback(() => {
    rpc.freelanceGovernorResume().then(refreshGov).catch(() => {});
  }, [refreshGov]);

  const draftReply = useCallback(
    (threadId: string) => {
      setDrafting(true);
      setNotice(null);
      rpc
        .freelanceOutboxDraftReply(threadId)
        .then(() => refreshOutbox())
        .catch((err) => setNotice(`Draft failed: ${String(err?.message ?? err)}`))
        .finally(() => setDrafting(false));
    },
    [refreshOutbox],
  );

  const updateDraft = useCallback((id: string, body: string) => {
    rpc.freelanceOutboxUpdateDraft(id, body).catch(() => {});
  }, []);

  const rejectDraft = useCallback(
    (id: string) => {
      rpc.freelanceOutboxReject(id).then(refreshOutbox).catch(() => {});
    },
    [refreshOutbox],
  );

  // Revert a failed send back to an editable draft so the user can fix + resend.
  const retryDraft = useCallback(
    (id: string) => {
      rpc.freelanceOutboxRetry(id).then(refreshOutbox).catch(() => {});
    },
    [refreshOutbox],
  );

  const killSwitch = useCallback(() => {
    rpc
      .freelanceOutboxKillSwitch()
      .then((r) => {
        setNotice(r.halted > 0 ? `Stopped ${r.halted} in-progress send(s).` : "Nothing in progress to stop (drafts stay as drafts).");
        refreshOutbox();
      })
      .catch(() => {});
  }, [refreshOutbox]);

  // Approve & Send: governor-gate (Bun) → run the human-paced write-step in the
  // webview → markResult via the fl-send-result host message.
  const approveSend = useCallback(
    async (item: FreelanceOutboxItemDto, autonomous = false) => {
      setNotice(null);
      // A human clicking Approve & Send is user-initiated (skips active-hours);
      // the full-auto loop passes autonomous=true (active-hours enforced).
      const res = await rpc.freelanceOutboxApproveSend(item.id, !autonomous).catch(() => null);
      if (!res) {
        if (!autonomous) setNotice("Couldn't reach the backend — please try again.");
        return;
      }
      if (!res.allowed) {
        if (!autonomous) setNotice(`Held: ${res.reason ?? "rate limited"}. Your draft is safe — try again shortly.`);
        refreshOutbox();
        return;
      }
      const wv = wvRef.current;
      if (!wv) {
        if (!autonomous) setNotice("The live session isn't ready yet — open it below (Show live session) and try again.");
        return;
      }
      setSendingId(item.id);
      pendingSend.current = { id: item.id };
      if (!sessionOpen) setSessionOpen(true);
      // Navigate to the right page (thread for replies, listing for bids) so the
      // composer/bid form is present, then type + submit with human pacing.
      const isBid = res.kind === "bid";
      // Prefer the listing's REAL platform URL (from the source feed); only fall
      // back to reconstructing /projects/<id> if it is somehow missing.
      const bidUrl = res.listingUrl ?? (res.listingId ? getPlatform(res.platform).listingUrl(res.listingId) : null);
      if (isBid && bidUrl) {
        wv.loadURL?.(bidUrl);
      } else if (res.threadId) {
        wv.loadURL?.(getPlatform(res.platform).threadUrl(res.threadId));
      }
      const script = isBid
        ? buildSubmitBidScript(res.platform, {
            proposal: res.body,
            amount: res.bidAmount ?? null,
            days: res.bidDays ?? 7,
            autoPlace: !!res.autoPlace,
          })
        : buildSendReplyScript(res.platform, res.body);
      setTimeout(() => {
        try {
          wv.executeJavascript?.(script);
        } catch {
          /* will time out below */
        }
      }, 2800);
      // Safety backstop: must always outlast the in-page script's own waits so its
      // precise result (e.g. "bid form did not appear within 30s") wins the race and
      // we don't mask it with a generic "send timed out". Worst in-page case ≈
      // inject delay (2.8s) + bid-form wait (30s) + post-click verify (8s) + the
      // per-character typing of the body (~scaled below). 45s base covers the fixed
      // waits with headroom; body.length*100 covers the human-paced typing.
      const timeoutMs = 45_000 + res.body.length * 100;
      setTimeout(() => {
        if (pendingSend.current?.id === item.id) {
          pendingSend.current = null;
          timedOutSend.current = { id: item.id, at: Date.now() };
          setSendingId(null);
          rpc.freelanceOutboxMarkResult(item.id, false, "send timed out").then(refreshOutbox).catch(() => {});
          setNotice("Send timed out — check the live session before retrying (it may still have gone through).");
        }
      }, timeoutMs);
    },
    [refreshOutbox, sessionOpen],
  );

  // Flush buffered captures to Bun (debounced).
  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      const batch = bufferRef.current;
      bufferRef.current = [];
      if (batch.length === 0) return;
      rpc.freelanceInboxIngest(batch).catch(() => {});
    }, 600);
  }, []);

  // Attach the persistent (app-lifetime, never-destroyed) session webview over the
  // placeholder, wire the interceptor + listeners, and DETACH (hide, not destroy)
  // on unmount — so the native overlay can never orphan/linger over other pages.
  useEffect(() => {
    const wv = holderRef.current ? attachSessionWebview(holderRef.current) : null;
    wvRef.current = wv;
    if (!wv?.on) return;

    // Fire the active profile-skills fetch after the interceptor is installed,
    // debounced. `url` is passed from navigation events so we can skip login/
    // challenge pages (where the call would 401 and waste the refresh window).
    const maybeFetchProfileSkills = (url?: string | null) => {
      if (url && /\/login|\/signup|captcha|challenge|verify|recaptcha/i.test(url)) return;
      const now = Date.now();
      if (now - lastProfileSkillsFetch < PROFILE_SKILLS_REFRESH_MS) return;
      lastProfileSkillsFetch = now;
      try {
        wv.executeJavascript?.(PROFILE_SKILLS_SRC);
      } catch {
        /* mid-navigation */
      }
    };
    const inject = () => {
      try {
        wv.executeJavascript?.(INTERCEPTOR_SRC);
      } catch {
        /* mid-navigation */
      }
      maybeFetchProfileSkills();
    };
    // Re-auth / CAPTCHA detection: landing on a login/challenge page while we
    // thought we were connected means the session needs attention. We pause
    // (the auto loops gate on `connected`) and prompt — never auto-solve.
    const onNav = (e: unknown) => {
      inject();
      const u = navUrl(e);
      if (u && /\/login|\/signup|captcha|challenge|verify|recaptcha/i.test(u)) {
        // We're logged out — any profile-skills fetch just 401s. Reset the debounce
        // so the next logged-in navigation re-fetches the skills promptly.
        lastProfileSkillsFetch = 0;
        setNotice("Freelancer needs you to log in or complete a verification — please do it in the live session below.");
        setSessionOpen(true);
        refreshAccount();
      }
    };
    const onHostMessage = (e: unknown) => {
      const msg = parseHostMessage(e);
      if (!msg) return;
      if (msg.type === "fl-rec" && msg.url) {
        bufferRef.current.push({ url: msg.url, body: msg.body ?? "" });
        scheduleFlush();
        return;
      }
      if (msg.type === "fl-ws") {
        // A socket frame hinted at new activity — refresh the inbox view so the
        // SPA re-fetches threads (and the interceptor captures them). Throttled
        // in-page; we also avoid disrupting an in-flight send.
        if (!sendingIdRef.current && wsReloadTimer.current === null) {
          wsReloadTimer.current = setTimeout(() => {
            wsReloadTimer.current = null;
            wvRef.current?.loadURL?.(INBOX_URL);
          }, 1500);
        }
        return;
      }
      if (msg.type === "fl-anomaly") {
        // Platform pushed back (429/403/captcha) — trip the bun-side circuit
        // breaker, which pauses autonomy and alerts the user.
        if (Date.now() - lastAnomalyAt.current > 5 * 60_000) {
          lastAnomalyAt.current = Date.now();
          rpc.freelanceReportAnomaly(msg.kind || "rate_limit", msg.error || undefined).catch(() => {});
          setNotice("The platform is pushing back (rate limit / verification) — autonomy paused as a precaution.");
        }
        return;
      }
      if (msg.type === "fl-send-result") {
        const pending = pendingSend.current;
        pendingSend.current = null;
        setSendingId(null);
        if (pending) {
          rpc
            .freelanceOutboxMarkResult(pending.id, !!msg.ok, msg.error || undefined)
            .then(() => refreshOutbox())
            .catch(() => {});
          setNotice(msg.ok ? "Reply sent." : `Send failed: ${msg.error || "unknown"}`);
          // Re-sync the thread so the sent message is captured back.
          setTimeout(() => wvRef.current?.reload?.(), 1500);
        } else if (timedOutSend.current && Date.now() - timedOutSend.current.at < 10 * 60_000) {
          // The result arrived AFTER our safety timeout already marked it failed —
          // correct the record so a successful slow send isn't retried (and a
          // confirmed failure keeps its real error).
          const lateId = timedOutSend.current.id;
          timedOutSend.current = null;
          rpc.freelanceOutboxMarkResult(lateId, !!msg.ok, msg.ok ? undefined : msg.error || undefined).then(() => refreshOutbox()).catch(() => {});
          if (msg.ok) setNotice("That timed-out send actually completed — the record has been corrected.");
        }
      }
      if (msg.type === "fl-bid-prefilled") {
        const pending = pendingSend.current;
        pendingSend.current = null;
        setSendingId(null);
        if (!pending) return;
        if (msg.ok) {
          // Filled but not submitted — park for review + desktop notification.
          const needsAmount = msg.error === "amount";
          rpc.freelanceOutboxMarkBidPrefilled(pending.id, needsAmount).then(() => refreshOutbox()).catch(() => {});
          setSessionOpen(true); // keep the live session visible so the user can click Place Bid
          setNotice(
            needsAmount
              ? "Bid filled — set your bid amount and click Place Bid in the live session below."
              : "Bid filled — review it and click Place Bid in the live session below.",
          );
        } else {
          // Couldn't fill the form — mark failed so the user can Retry.
          rpc.freelanceOutboxMarkResult(pending.id, false, msg.error || "could not fill bid form").then(() => refreshOutbox()).catch(() => {});
          setNotice(`Bid form not filled: ${msg.error || "unknown"}`);
        }
      }
    };

    wv.on("dom-ready", inject);
    wv.on("did-navigate", onNav);
    wv.on("did-navigate-in-page", onNav);
    wv.on("host-message", onHostMessage);
    inject(); // the page may already be loaded — install the interceptor now too
    return () => {
      wv.off?.("dom-ready", inject);
      wv.off?.("did-navigate", onNav);
      wv.off?.("did-navigate-in-page", onNav);
      wv.off?.("host-message", onHostMessage);
      detachSessionWebview(); // hide + stop tracking; the element is never destroyed
      wvRef.current = null;
    };
  }, [scheduleFlush, refreshAccount, refreshOutbox]);

  // Show/hide (never destroy) the native view. Visible only when the live-session
  // panel is open AND we're in the FOREGROUND (the Inbox tab is actually on screen,
  // i.e. the engine host is parented into the freelance slot). In the background the
  // webview is fully hidden so it can never flash over another page.
  const inForeground = useFreelanceEngineStore((s) => s.slot != null);
  useEffect(() => {
    setSessionWebviewVisible(sessionOpen && inForeground);
  }, [sessionOpen, inForeground]);

  // Initial load + live refresh on ingest broadcasts.
  useEffect(() => {
    refreshAccount();
    refreshThreads();
    refreshOutbox();
    const onUpdated = () => {
      refreshAccount();
      refreshThreads();
      if (selectedId) loadMessages(selectedId);
    };
    const onOutbox = () => refreshOutbox();
    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent).detail as { status?: string } | undefined;
      if (detail?.status === "logged_out") {
        setNotice("Session logged out — automatic syncing and sending are paused until you log in again in the live session.");
      }
      refreshAccount();
    };
    window.addEventListener("agentdesk:freelance-inbox-updated", onUpdated);
    window.addEventListener("agentdesk:freelance-outbox-updated", onOutbox);
    window.addEventListener("agentdesk:freelance-account-status-changed", onStatus);
    return () => {
      window.removeEventListener("agentdesk:freelance-inbox-updated", onUpdated);
      window.removeEventListener("agentdesk:freelance-outbox-updated", onOutbox);
      window.removeEventListener("agentdesk:freelance-account-status-changed", onStatus);
    };
  }, [refreshAccount, refreshThreads, refreshOutbox, selectedId, loadMessages]);

  useEffect(() => {
    refreshThreads();
  }, [search, refreshThreads]);

  // Jittered background auto-sync — inert unless Auto-Earn is enabled. Reloads
  // the session inbox within active hours so threads refresh hands-free; each
  // tick is logged to the governor's action_log. Manual "Sync now" always works.
  const connected = !!account?.connected;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const withinActiveHours = (ah: { start: number; end: number }) => {
      const h = hourInTz(tzRef.current);
      if (ah.start === ah.end) return true;
      return ah.start < ah.end ? h >= ah.start && h < ah.end : h >= ah.start || h < ah.end;
    };

    const schedule = async () => {
      if (cancelled) return;
      let pollMin = 180;
      let pollMax = 480;
      let enabled = false;
      let activeHours = { start: 9, end: 22 };
      try {
        const s = await rpc.freelanceGetAutoEarnSettings();
        pollMin = s.pollMin;
        pollMax = s.pollMax;
        enabled = s.enabled;
        activeHours = s.activeHours;
      } catch {
        /* keep defaults */
      }
      const delay = (pollMin + Math.random() * Math.max(0, pollMax - pollMin)) * 1000;
      timer = setTimeout(() => {
        if (!cancelled && enabled && connected && !sendingId && withinActiveHours(activeHours)) {
          rpc.freelanceLogInboxSync("auto").catch(() => {});
          wvRef.current?.loadURL?.(INBOX_URL);
        }
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connected, sendingId]);

  // Full-auto engine — OFF unless the account is full_auto AND the risk ack is
  // set AND Auto-Earn is enabled. One action per tick, governor-paced: it auto-
  // drafts a reply to an unread inbound thread, then auto-sends pending drafts.
  const faState = useRef({ outbox, threads, account });
  const approveSendRef = useRef(approveSend);
  useEffect(() => {
    faState.current = { outbox, threads, account };
    approveSendRef.current = approveSend;
  });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        const s = await rpc.freelanceGetAutoEarnSettings();
        const { outbox: ob, account: acct } = faState.current;
        const fullAuto = s.enabled && s.fullautoAck && acct?.autonomyMode === "full_auto";
        // Every tick: stuck-queue check + engine heartbeat (the bun-side watchdog
        // uses the heartbeat to detect a silently-dead engine in full-auto).
        if (s.enabled) rpc.freelanceGovernorCheckStuck().catch(() => {});
        if (fullAuto && connected && !sendingId) {
          // The freelance-expert agent (backend) decides + drafts replies/bids and
          // queues them in the outbox. Here we only SEND queued items, governor-paced,
          // by driving the live session. (Drafting moved to the expert agent.)
          const queued = ob.find((o) => o.status === "draft");
          if (queued) {
            await approveSendRef.current(queued, true); // autonomous — active-hours enforced
          }
        }
      } catch {
        /* idle */
      }
      timer = setTimeout(tick, 60_000 + Math.random() * 60_000);
    };
    timer = setTimeout(tick, 8_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connected, sendingId]);

  const selectThread = (t: FreelanceInboxThreadDto) => {
    setSelectedId(t.id);
    loadMessages(t.id);
    // Drive the live session to that thread so its full message history is
    // fetched by the page (and intercepted) — best-effort.
    if (t.url) wvRef.current?.loadURL?.(t.url);
    if (!sessionOpen) setSessionOpen(true);
  };

  const syncNow = () => {
    const wv = wvRef.current;
    if (!wv) return;
    rpc.freelanceLogInboxSync("manual").catch(() => {});
    wv.loadURL?.(INBOX_URL);
    if (!sessionOpen) setSessionOpen(true);
  };

  const setAutonomy = (mode: "assisted" | "full_auto") => {
    rpc.freelanceAccountSetAutonomy(mode).then(refreshAccount).catch(() => {});
  };

  const disconnect = () => {
    rpc
      .freelanceAccountDisconnect()
      .then(() => {
        wvRef.current?.loadURL?.(LOGIN_URL);
        setThreads([]);
        setSelectedId(null);
        setMessages([]);
        refreshAccount();
        if (!sessionOpen) setSessionOpen(true);
      })
      .catch(() => {});
  };

  const selectedThread = threads.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            account?.connected
              ? "bg-green-500/15 text-green-600 dark:text-green-400"
              : "bg-muted text-muted-foreground"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${account?.connected ? "bg-green-500" : "bg-muted-foreground"}`} />
          {account?.connected
            ? `Connected${account.displayName ? ` as ${account.displayName}` : ""}`
            : "Not connected"}
        </span>
        {account?.lastSyncAt && (
          <span className="text-xs text-muted-foreground">
            Last sync: {new Date(account.lastSyncAt).toLocaleTimeString()}
          </span>
        )}
        {account?.connected && (
          <>
            <select
              value={account.autonomyMode}
              onChange={(e) => setAutonomy(e.target.value as "assisted" | "full_auto")}
              title="Autonomy mode"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            >
              <option value="assisted">Assisted (you send)</option>
              <option value="full_auto">Full-auto</option>
            </select>
            <button
              onClick={disconnect}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            >
              Disconnect
            </button>
          </>
        )}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search messages…"
          className="ml-auto w-56 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
        <button onClick={syncNow} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
          Sync now
        </button>
        <button
          onClick={() => setSessionOpen((v) => !v)}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          {sessionOpen ? "Hide live session" : "Show live session"}
        </button>
      </div>

      {/* Governor visibility + global pause */}
      {account?.connected && gov && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {gov.pausedUntilMs > 0 ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-700 dark:text-amber-400">
              Autonomy paused until {new Date(gov.pausedUntilMs).toLocaleTimeString()}
              <button onClick={resumeAutonomy} className="underline hover:no-underline">Resume now</button>
            </span>
          ) : (
            <>
              <span
                className="text-muted-foreground"
                title="Sends used this hour vs cap (reply / bid). Bids are throttled harder. 'next in' is the minimum gap remaining."
              >
                Sends this hour — reply {gov.reply.usedThisHour}/{gov.reply.cap} · bid{" "}
                {gov.bid.usedThisHour}/{gov.bid.cap}
                {gov.reply.nextAllowedInMs > 0 ? ` · next in ${Math.ceil(gov.reply.nextAllowedInMs / 1000)}s` : ""}
                {!gov.withinActiveHours ? " · outside active hours" : ""}
              </span>
              <select
                value=""
                onChange={(e) => {
                  const h = Number(e.target.value);
                  if (h > 0) pauseFor(h);
                }}
                title="Pause all sending + full-auto for a while. Inbox sync keeps running."
                className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              >
                <option value="">Pause…</option>
                <option value="1">1 hour</option>
                <option value="3">3 hours</option>
                <option value="8">8 hours</option>
                <option value="24">24 hours</option>
              </select>
            </>
          )}
        </div>
      )}

      {/* Inbox: threads | conversation */}
      <div className="grid h-[44vh] grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="overflow-auto rounded-md border border-border lg:col-span-1">
          {threads.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No messages synced yet. Open the live session below, log in, and open your
              Freelancer inbox — your conversations will appear here. If it stays empty
              after syncing while you are logged in, the page may need attention (the
              site structure can change) — tell us and we will re-tune the sync.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => selectThread(t)}
                    className={`flex w-full flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-accent ${
                      selectedId === t.id ? "bg-accent" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {t.clientName || t.title || `Thread ${t.id}`}
                      </span>
                      {t.unread > 0 && (
                        <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
                          {t.unread}
                        </span>
                      )}
                    </div>
                    {t.lastMessageText && (
                      <span className="truncate text-xs text-muted-foreground">{t.lastMessageText}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground">{fmtTime(t.lastMessageAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col overflow-hidden rounded-md border border-border lg:col-span-2">
          {selectedThread ? (
            <>
              <div className="flex items-start gap-2 border-b border-border px-3 py-2">
                <div className="flex-1">
                <div className="text-sm font-medium">
                  {selectedThread.clientName || selectedThread.title || `Thread ${selectedThread.id}`}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  {selectedThread.contextType && (
                    <span>
                      {selectedThread.contextType}
                      {selectedThread.contextId ? ` · #${selectedThread.contextId}` : ""}
                    </span>
                  )}
                  {selectedThread.listingId && (
                    <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-green-600 dark:text-green-400">
                      Linked listing{selectedThread.linkConfidence === "probable" ? " (probable)" : ""}
                    </span>
                  )}
                </div>
                </div>
                <button
                  onClick={() => draftReply(selectedThread.id)}
                  disabled={drafting}
                  className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
                >
                  {drafting ? "Drafting…" : "Draft reply"}
                </button>
              </div>
              <div className="flex-1 overflow-auto p-3">
                {messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No messages stored yet — opening this thread in the live session will fetch them.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {messages.map((m) => (
                      <li
                        key={m.id}
                        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                          m.outbound
                            ? "self-end bg-primary text-primary-foreground"
                            : "self-start bg-muted"
                        }`}
                      >
                        <div className="whitespace-pre-wrap break-words">{m.body}</div>
                        <div
                          className={`mt-1 text-[10px] ${
                            m.outbound ? "text-primary-foreground/70" : "text-muted-foreground"
                          }`}
                        >
                          {m.outbound ? "You" : m.fromName || "Client"} · {fmtTime(m.sentAt)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
              Select a conversation to read it.
            </div>
          )}
        </div>
      </div>

      {notice && (
        <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
          {notice}
          <button onClick={() => setNotice(null)} className="ml-2 text-xs text-muted-foreground hover:underline">
            dismiss
          </button>
        </div>
      )}

      {/* Approval queue (Outbox) */}
      {outbox.length > 0 && (
        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-medium">Drafts &amp; queue ({outbox.length})</span>
            <button
              onClick={killSwitch}
              className="ml-auto rounded-md border border-red-500/50 px-2.5 py-1 text-xs text-red-600 hover:bg-red-500/10 dark:text-red-400"
            >
              Kill-switch
            </button>
          </div>
          <ul className="divide-y divide-border">
            {outbox.map((item) => (
              <li key={item.id} className="p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 uppercase text-primary">{item.kind}</span>
                  <span>{item.status}</span>
                  {item.autonomyMode === "full_auto" && <span className="text-amber-500">full-auto</span>}
                </div>
                {item.status === "draft" ? (
                  <AutoGrowTextarea
                    key={item.id}
                    defaultValue={item.draftBody}
                    onBlur={(value) => updateDraft(item.id, value)}
                    className="w-full min-h-[4rem] rounded-md border border-border bg-background p-2 text-sm"
                  />
                ) : (
                  <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-sm">{item.draftBody}</p>
                )}
                {item.status === "draft" && (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => approveSend(item)}
                      disabled={sendingId === item.id}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {sendingId === item.id ? "Sending…" : "Approve & Send"}
                    </button>
                    <button
                      onClick={() => rejectDraft(item.id)}
                      className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
                    >
                      Reject
                    </button>
                  </div>
                )}
                {item.status === "failed" && (
                  <div className="mt-2 space-y-2">
                    {item.error && (
                      <p className="text-xs text-red-600 dark:text-red-400">Failed: {item.error}</p>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => retryDraft(item.id)}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90"
                      >
                        Retry
                      </button>
                      <button
                        onClick={() => rejectDraft(item.id)}
                        className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
                {item.status === "awaiting_review" && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Filled into the bid form in the live session below — review the amount and click
                      <span className="font-medium"> Place Bid</span> there. Then mark it placed.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => rpc.freelanceOutboxMarkResult(item.id, true).then(refreshOutbox).catch(() => {})}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90"
                      >
                        Mark as placed
                      </button>
                      <button
                        onClick={() => rejectDraft(item.id)}
                        className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Live session (sync engine) */}
      <div className="rounded-md border border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-medium">Live session</span>
          <span className="text-xs text-muted-foreground">— logs in &amp; feeds your inbox</span>
          <button
            onClick={() => wvRef.current?.loadURL?.(LOGIN_URL)}
            className="ml-auto rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
          >
            Log in
          </button>
          <button
            onClick={() => wvRef.current?.loadURL?.(INBOX_URL)}
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
          >
            Open Inbox
          </button>
        </div>
        {runtimeAvailable ? (
          // Placeholder: the persistent native webview is positioned over this
          // div's rect by the session host. It is NOT a child here — that's what
          // lets it survive navigation without orphaning.
          <div
            ref={holderRef}
            className="w-full overflow-hidden"
            style={{ height: sessionOpen ? "90vh" : 0 }}
          />
        ) : (
          <div className="p-4 text-sm text-red-600 dark:text-red-400">
            The embedded webview runtime is unavailable in this view.
          </div>
        )}
      </div>
    </div>
  );
}
