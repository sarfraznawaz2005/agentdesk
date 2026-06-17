/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState, useCallback } from "react";
import { create } from "zustand";
import { CheckCircle, XCircle, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Toast {
  id: string;
  type: "success" | "error" | "warning" | "info";
  message: string;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
  },
  removeToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

export function toast(type: Toast["type"], message: string) {
  useToastStore.getState().addToast({ type, message });
}

// ---------------------------------------------------------------------------
// Style maps — full colored backgrounds, dark-mode aware
// ---------------------------------------------------------------------------

const typeStyles: Record<
  Toast["type"],
  { container: string; icon: string; close: string; Icon: React.ElementType }
> = {
  success: {
    container: "bg-green-600 border-green-700 text-white dark:bg-green-500 dark:border-green-600",
    icon: "text-white/90",
    close: "text-white/60 hover:text-white",
    Icon: CheckCircle,
  },
  error: {
    container: "bg-red-600 border-red-700 text-white dark:bg-red-500 dark:border-red-600",
    icon: "text-white/90",
    close: "text-white/60 hover:text-white",
    Icon: XCircle,
  },
  warning: {
    container: "bg-amber-500 border-amber-600 text-white dark:bg-amber-500 dark:border-amber-600",
    icon: "text-white/90",
    close: "text-white/60 hover:text-white",
    Icon: AlertTriangle,
  },
  info: {
    container: "bg-blue-600 border-blue-700 text-white dark:bg-blue-500 dark:border-blue-600",
    icon: "text-white/90",
    close: "text-white/60 hover:text-white",
    Icon: Info,
  },
};

// ---------------------------------------------------------------------------
// Single toast item
// ---------------------------------------------------------------------------

const AUTO_DISMISS_MS = 7000;

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const { container, icon, close, Icon } = typeStyles[toast.type];
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exiting, setExiting] = useState(false);

  const dismiss = useCallback(() => setExiting(true), []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(dismiss, AUTO_DISMISS_MS);
  }, [clearTimer, dismiss]);

  useEffect(() => {
    startTimer();
    return clearTimer;
  }, [toast.id, startTimer, clearTimer]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onClick={dismiss}
      onMouseEnter={clearTimer}
      onMouseLeave={startTimer}
      onAnimationEnd={() => { if (exiting) onDismiss(toast.id); }}
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg cursor-pointer",
        "w-96 max-w-[calc(100vw-2rem)] overflow-hidden",
        container,
        exiting
          ? "animate-out slide-out-to-right-full fade-out-0 duration-300 fill-mode-forwards"
          : "animate-in slide-in-from-right-full fade-in-0 duration-300",
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", icon)} aria-hidden="true" />
      <p className="flex-1 text-[15px] break-words line-clamp-5">
        {toast.message.length > 300 ? `${toast.message.slice(0, 300)}…` : toast.message}
      </p>
      <button
        onClick={dismiss}
        aria-label="Dismiss notification"
        className={cn(
          "ml-auto shrink-0 rounded-sm transition-colors",
          "focus:outline-none focus:ring-2 focus:ring-current focus:ring-offset-1",
          close,
        )}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toaster (mount once at app root)
// ---------------------------------------------------------------------------

export function Toaster() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-label="Notifications"
      className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={removeToast} />
      ))}
    </div>
  );
}
