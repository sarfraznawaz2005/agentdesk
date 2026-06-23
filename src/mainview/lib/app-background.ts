import { rpc } from "./rpc";

// ---------------------------------------------------------------------------
// App background presets
//
// Each preset is a `.appbg-<id>` CSS class (defined in index.css) that adapts to
// the active light/dark theme. The selected preset class is applied to <html>
// (like the theme `.dark` class) and consumed by the `.app-background` canvas on
// the app-shell root. The empty id ("") means the default theme background.
// ---------------------------------------------------------------------------

export type AppBackgroundCategory = "color" | "pattern";

export interface AppBackgroundPreset {
  /** "" = default theme background (no preset class). */
  id: string;
  label: string;
  category: AppBackgroundCategory;
  /**
   * "full"   → paints the whole app incl. behind the translucent sidebar
   *            (solid colors & gradients look fine there).
   * "content"→ paints only the main content area (line/mark patterns would
   *            look strange bleeding through the sidebar).
   */
  scope: "full" | "content";
}

export const APP_BACKGROUNDS: AppBackgroundPreset[] = [
  // Colors — no lines, safe across the whole app.
  { id: "", label: "Default", category: "color", scope: "full" },
  { id: "slate", label: "Slate", category: "color", scope: "full" },
  { id: "sand", label: "Warm Sand", category: "color", scope: "full" },
  { id: "mint", label: "Mint", category: "color", scope: "full" },
  { id: "lavender", label: "Lavender", category: "color", scope: "full" },
  { id: "sky", label: "Sky", category: "color", scope: "full" },
  { id: "rose", label: "Rose", category: "color", scope: "full" },
  { id: "amber", label: "Amber", category: "color", scope: "full" },
  { id: "teal", label: "Teal", category: "color", scope: "full" },
  { id: "graphite", label: "Graphite", category: "color", scope: "full" },
  // Line / mark patterns — content area only.
  { id: "dots", label: "Dots", category: "pattern", scope: "content" },
  { id: "grid", label: "Grid", category: "pattern", scope: "content" },
  { id: "iso", label: "Isometric", category: "pattern", scope: "content" },
  { id: "diagonal", label: "Diagonal", category: "pattern", scope: "content" },
  { id: "checks", label: "Checks", category: "pattern", scope: "content" },
  { id: "lines", label: "Lines", category: "pattern", scope: "content" },
  // Gradient patterns — no lines, safe across the whole app.
  { id: "mesh", label: "Mesh", category: "pattern", scope: "full" },
  { id: "aurora", label: "Aurora", category: "pattern", scope: "full" },
  { id: "sunset", label: "Sunset", category: "pattern", scope: "full" },
  { id: "ocean", label: "Ocean", category: "pattern", scope: "full" },
];

const PRESET_BY_ID = new Map(APP_BACKGROUNDS.map((b) => [b.id, b]));

const STORAGE_KEY = "agentdesk_app_bg";
const VALID = new Set(APP_BACKGROUNDS.map((b) => b.id));

export function getStoredBackground(): string {
  const v = localStorage.getItem(STORAGE_KEY) ?? "";
  return VALID.has(v) ? v : "";
}

/** Swap the active `appbg-*` class on <html>. Adds `appbg-full` for full-scope
 *  presets so the canvas also paints behind the (translucent) sidebar. */
export function applyBackground(id: string) {
  const root = document.documentElement;
  const stale = Array.from(root.classList).filter(
    (c) => c.startsWith("appbg-") || c === "appbg-full",
  );
  stale.forEach((c) => root.classList.remove(c));
  if (id) {
    root.classList.add(`appbg-${id}`);
    if (PRESET_BY_ID.get(id)?.scope === "full") root.classList.add("appbg-full");
  }
}

/** Call once synchronously before first render to avoid a flash of the default. */
export function initBackground() {
  applyBackground(getStoredBackground());
}

/** Apply + persist (localStorage for instant boot, DB as the durable store). */
export async function setBackground(id: string) {
  const val = VALID.has(id) ? id : "";
  localStorage.setItem(STORAGE_KEY, val);
  applyBackground(val);
  window.dispatchEvent(new CustomEvent("agentdesk:app-bg-changed", { detail: { background: val } }));
  await rpc.saveSetting("app_background", val, "appearance").catch(() => {});
}

/** Reconcile localStorage with the persisted DB value on app start. */
export async function syncBackgroundFromDB() {
  try {
    const settings = await rpc.getSettings("appearance");
    const saved = settings["app_background"];
    if (typeof saved === "string" && VALID.has(saved)) {
      localStorage.setItem(STORAGE_KEY, saved);
      applyBackground(saved);
    }
  } catch {
    // fall back to localStorage
  }
}
