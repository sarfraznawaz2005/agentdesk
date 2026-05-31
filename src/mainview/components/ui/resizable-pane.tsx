import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

interface ResizablePaneProps {
  left: ReactNode;
  right: ReactNode;
  defaultLeftWidth?: number; // percentage, default 50
  minLeftWidth?: number; // percentage, default 20
  maxLeftWidth?: number; // percentage, default 80
}

export function ResizablePane({
  left,
  right,
  defaultLeftWidth = 50,
  minLeftWidth = 20,
  maxLeftWidth = 80,
}: ResizablePaneProps) {
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const clamp = useCallback(
    (value: number) => Math.min(Math.max(value, minLeftWidth), maxLeftWidth),
    [minLeftWidth, maxLeftWidth]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(true);
    },
    []
  );

  useEffect(() => {
    if (!isDragging) return;

    function handleMouseMove(e: MouseEvent) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const percentage = (offsetX / rect.width) * 100;
      setLeftWidth(clamp(percentage));
    }

    function handleMouseUp() {
      setIsDragging(false);
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, clamp]);

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full overflow-hidden"
      style={{ cursor: isDragging ? "col-resize" : undefined }}
    >
      {/* Left pane */}
      <div
        className="h-full overflow-auto"
        style={{ width: `${leftWidth}%` }}
      >
        {left}
      </div>

      {/* Draggable divider */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onKeyDown={(e) => {
          // Allow keyboard adjustment of split position
          if (e.key === "ArrowLeft") {
            setLeftWidth((w) => clamp(w - 2));
          } else if (e.key === "ArrowRight") {
            setLeftWidth((w) => clamp(w + 2));
          }
        }}
        className={cn(
          "relative shrink-0 w-1 cursor-col-resize",
          "flex items-center justify-center",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-inset",
          "transition-colors",
          isDragging
            ? "bg-indigo-400"
            : "bg-muted hover:bg-indigo-300 dark:hover:bg-indigo-500/50"
        )}
      />

      {/* Right pane */}
      <div
        className="h-full overflow-auto flex-1"
      >
        {right}
      </div>
    </div>
  );
}
