import { useState, useEffect } from "react";

const MIN = 70;
const MAX = 150;
const STEP = 10;

/** Default key — used by the main project chat. Pass a unique key per widget for independent zoom. */
export const CONV_FONT_SIZE_KEY = "conv-font-size-percent";

export function useConvFontSize(storageKey = CONV_FONT_SIZE_KEY) {
  const [percent, setPercent] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) return Math.min(MAX, Math.max(MIN, parseInt(stored, 10)));
    } catch {}
    return 100;
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, String(percent)); } catch {}
  }, [percent, storageKey]);

  const zoomIn = () => setPercent((p) => Math.min(MAX, p + STEP));
  const zoomOut = () => setPercent((p) => Math.max(MIN, p - STEP));
  const reset = () => setPercent(100);

  return { percent, zoomIn, zoomOut, reset, atMin: percent <= MIN, atMax: percent >= MAX };
}
