/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef } from "react";
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
// Style maps
// ---------------------------------------------------------------------------

const typeStyles: Record<
  Toast["type"],
  { container: string; icon: string; Icon: React.ElementType }
> = {
  success: {
    container: "border-green-500 bg-background",
    icon: "text-green-500",
    Icon: CheckCircle,
  },
  error: {
    container: "border-destructive bg-background",
    icon: "text-destructive",
    Icon: XCircle,
  },
  warning: {
    container: "border-amber-400 bg-background",
    icon: "text-amber-500",
    Icon: AlertTriangle,
  },
  info: {
    container: "border-primary bg-background",
    icon: "text-primary",
    Icon: Info,
  },
};

// ---------------------------------------------------------------------------
// Single toast item
// ---------------------------------------------------------------------------

const AUTO_DISMISS_MS = 4000;

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const { container, icon, Icon } = typeStyles[toast.type];
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => {
      onDismiss(toast.id);
    }, AUTO_DISMISS_MS);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [toast.id, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "flex items-start gap-3 rounded-lg border-l-4 px-4 py-3 shadow-md",
        "w-96 max-w-[calc(100vw-2rem)] overflow-hidden",
        container
      )}
    >
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", icon)}
        aria-hidden="true"
      />
      <p className="flex-1 text-sm text-foreground break-words line-clamp-5">
        {toast.message.length > 300 ? toast.message.slice(0, 300) + "..." : toast.message}
      </p>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="ml-auto shrink-0 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
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
