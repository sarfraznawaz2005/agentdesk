import { rpc } from "./rpc";

export type Theme = "light" | "dark";
const STORAGE_KEY = "agentdesk_theme";

export function getStoredTheme(): Theme {
  return (localStorage.getItem(STORAGE_KEY) as Theme) ?? "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Call once synchronously before first render to avoid flash */
export function initTheme() {
  applyTheme(getStoredTheme());
}

export async function setTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent("agentdesk:theme-changed", { detail: { theme } }));
  await rpc.saveSetting("theme_mode", theme, "appearance").catch(() => {});
}

/** Sync localStorage with persisted DB value on app start */
export async function syncThemeFromDB() {
  try {
    const settings = await rpc.getSettings("appearance");
    const saved = settings["theme_mode"] as Theme | undefined;
    if (saved === "light" || saved === "dark") {
      localStorage.setItem(STORAGE_KEY, saved);
      applyTheme(saved);
    }
  } catch {
    // fall back to localStorage
  }
}
