import { Mic } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";

export interface VoiceInputButtonProps {
  listening: boolean;
  error: string | null;
  onClick: () => void;
  disabled?: boolean;
}

/** Shared voice-input toggle button — pair with the `useVoiceInput` hook. */
export function VoiceInputButton({ listening, error, onClick, disabled }: VoiceInputButtonProps) {
  return (
    <Tip content={error ?? (listening ? "Stop voice input" : "Voice input")} side="top">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "flex-shrink-0 p-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60",
          listening
            ? "text-red-500 hover:text-red-600 hover:bg-red-50 animate-pulse"
            : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted",
        )}
        aria-label={listening ? "Stop voice input" : "Start voice input"}
        // Queried by Ambient Mode's idle timer to avoid auto-activating mid-dictation.
        data-voice-listening={listening || undefined}
      >
        <Mic className="w-4 h-4" />
      </button>
    </Tip>
  );
}
