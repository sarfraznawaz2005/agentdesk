// ---------------------------------------------------------------------------
// Auto-Earn — persistent session webview host (singleton)
//
// WHY THIS EXISTS: <electrobun-webview> is a NATIVE overlay. Creating/destroying
// it on every React mount is unreliable on Windows — the native window can orphan
// and float over other pages (and React StrictMode in dev makes it worse by
// double-invoking lifecycle). The robust fix is to create the webview ONCE for
// the app's lifetime and never destroy it; we only **hide** it (which is reliable
// because the view is still alive) and **reposition** it over the inbox panel.
//
// The element lives at document.body, position:fixed, and we keep its rect synced
// to a placeholder <div> that the Inbox tab renders. When the Inbox unmounts we
// just hide it — the buggy native destroy path is never taken.
// ---------------------------------------------------------------------------

import { getPlatform } from "../../../shared/freelance/platforms";

const PLATFORM = "freelancer";
const DESC = getPlatform(PLATFORM);
const PARTITION = `persist:freelance-${PLATFORM}`;

export type SessionWebview = HTMLElement & {
  loadURL?: (url: string) => void;
  reload?: () => void;
  executeJavascript?: (js: string) => void;
  toggleHidden?: (hidden?: boolean) => void;
  on?: (name: string, handler: (e: unknown) => void) => void;
  off?: (name: string, handler: (e: unknown) => void) => void;
};

let el: SessionWebview | null = null;
let holder: HTMLElement | null = null;
let rafId: number | null = null;

export function runtimeAvailable(): boolean {
  return typeof customElements !== "undefined" && !!customElements.get("electrobun-webview");
}

/** Get (creating once) the singleton webview element. Never removed from the DOM. */
export function getSessionWebview(): SessionWebview | null {
  if (!runtimeAvailable()) return null;
  if (!el) {
    const node = document.createElement("electrobun-webview") as SessionWebview;
    node.setAttribute("partition", PARTITION);
    node.setAttribute("src", DESC.inboxUrl);
    Object.assign(node.style, {
      position: "fixed",
      left: "-10000px", // start off-screen until attached
      top: "0px",
      width: "1px",
      height: "1px",
      zIndex: "30",
      border: "none",
      background: "#ffffff",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(node); // created ONCE, never removed
    try {
      node.toggleHidden?.(true);
    } catch {
      /* not ready yet */
    }
    el = node;
  }
  return el;
}

function syncRect(): void {
  if (!el || !holder) return;
  const r = holder.getBoundingClientRect();
  // If the holder is collapsed or off-screen, keep the view hidden instead of
  // painting a sliver.
  if (r.width < 2 || r.height < 2) {
    el.style.left = "-10000px";
    return;
  }
  el.style.left = `${Math.round(r.left)}px`;
  el.style.top = `${Math.round(r.top)}px`;
  el.style.width = `${Math.round(r.width)}px`;
  el.style.height = `${Math.round(r.height)}px`;
}

function startSync(): void {
  stopSync();
  const loop = () => {
    syncRect();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function stopSync(): void {
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
}

/** Position the webview over `holderEl`, keep it synced, and show it. */
export function attachSessionWebview(holderEl: HTMLElement): SessionWebview | null {
  const wv = getSessionWebview();
  if (!wv) return null;
  holder = holderEl;
  syncRect();
  startSync();
  try {
    wv.toggleHidden?.(false);
  } catch {
    /* ignore */
  }
  return wv;
}

/** Hide the webview and stop tracking — but DO NOT destroy it (avoids the leak). */
export function detachSessionWebview(): void {
  stopSync();
  holder = null;
  if (el) {
    el.style.left = "-10000px";
    try {
      el.toggleHidden?.(true);
    } catch {
      /* ignore */
    }
  }
}

/** Show/hide without detaching (used when the Live-session panel is collapsed). */
export function setSessionWebviewVisible(visible: boolean): void {
  if (!el) return;
  try {
    el.toggleHidden?.(!visible);
  } catch {
    /* ignore */
  }
  if (!visible) el.style.left = "-10000px";
}
