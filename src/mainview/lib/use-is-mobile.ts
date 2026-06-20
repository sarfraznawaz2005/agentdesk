import { useEffect, useState } from "react";

/**
 * Track whether the viewport is at a mobile width (TASK-487 responsive pass).
 * Matches Tailwind's `md` breakpoint boundary (≤ 767px = mobile) so JS-driven
 * layout decisions (off-canvas sidebar, label visibility) stay in lockstep with
 * the `md:` utility classes used for the same components.
 */
const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
