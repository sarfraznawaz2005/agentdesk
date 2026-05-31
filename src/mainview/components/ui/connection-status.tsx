import { useState, useEffect, useRef } from "react";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";

/**
 * Periodically pings the backend via a lightweight RPC call.
 * Shows a banner when the backend is unreachable.
 */
export function ConnectionStatus() {
  const [connected, setConnected] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        await rpc.getAppInfo();
        setConnected(true);
      } catch {
        setConnected(false);
      }
    };

    // Check immediately, then every 10 seconds
    check();
    intervalRef.current = setInterval(check, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  if (connected) return null;

  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-1.5",
        "bg-red-50 border-b border-red-200 text-red-700 text-xs font-medium",
        "animate-in fade-in slide-in-from-top-1 duration-300",
      )}
      role="alert"
    >
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Backend unreachable — RPC calls will fail until connection is restored</span>
    </div>
  );
}
