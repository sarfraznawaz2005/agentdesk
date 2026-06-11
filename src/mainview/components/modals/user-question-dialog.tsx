import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { rpc } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { MessageSquare, Check, CheckSquare, Square } from "lucide-react";
import { useAgentColorMap } from "@/lib/use-agent-colors";

interface UserQuestionPayload {
  requestId: string;
  question: string;
  inputType: "choice" | "text" | "confirm" | "multi_select";
  options?: string[];
  placeholder?: string;
  defaultValue?: string;
  context?: string;
  /** Display name of the asking agent (e.g. "Backend Engineer"). */
  agentName: string;
  /** Internal agent id used for color lookup (e.g. "backend-engineer"). */
  agentId?: string;
}

/**
 * Build the title label: if the display name already contains "agent" (case-
 * insensitive), use it as-is; otherwise append " Agent".
 * e.g. "General" → "General Agent", "Playground Agent" → "Playground Agent"
 */
function buildAgentLabel(displayName: string): string {
  return /agent/i.test(displayName) ? displayName : `${displayName} Agent`;
}

export function UserQuestionDialog() {
  // Single source of truth: a FIFO queue of pending questions. The head (index 0)
  // is the one currently shown, so concurrent questions from multiple agents are
  // presented one after another instead of clobbering each other.
  const [queue, setQueue] = useState<UserQuestionPayload[]>([]);
  const payload = queue[0] ?? null;

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<UserQuestionPayload>).detail;
      // Append; if one is already showing this waits its turn (deduped by requestId).
      setQueue((q) => (q.some((p) => p.requestId === detail.requestId) ? q : [...q, detail]));
    };
    // The agent gave up waiting (timed out) and moved on — drop that question whether
    // it's the one on screen or still waiting in the queue, so nobody answers into the void.
    const cancelHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ requestId: string }>).detail;
      setQueue((q) => q.filter((p) => p.requestId !== detail.requestId));
    };
    window.addEventListener("agentdesk:user-question-request", handler);
    window.addEventListener("agentdesk:user-question-cancel", cancelHandler);
    return () => {
      window.removeEventListener("agentdesk:user-question-request", handler);
      window.removeEventListener("agentdesk:user-question-cancel", cancelHandler);
    };
  }, []);

  // Resolve the current question, then drop it so the next queued one becomes the head.
  const resolve = useCallback(async (requestId: string, answer: string) => {
    try {
      await rpc.respondUserQuestion(requestId, answer);
    } catch {
      // best effort
    }
    setQueue((q) => q.filter((p) => p.requestId !== requestId));
  }, []);

  if (!payload) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) resolve(payload.requestId, "[Dismissed by user]");
      }}
    >
      <DialogContent className="sm:max-w-md">
        {/* Keyed by requestId so each question mounts a fresh form — resets the input
            fields when the queue advances without a setState-in-effect. */}
        <QuestionForm
          key={payload.requestId}
          payload={payload}
          onResolve={(answer) => resolve(payload.requestId, answer)}
        />
      </DialogContent>
    </Dialog>
  );
}

function QuestionForm({
  payload,
  onResolve,
}: {
  payload: UserQuestionPayload;
  onResolve: (answer: string) => Promise<void> | void;
}) {
  const [textValue, setTextValue] = useState(payload.defaultValue ?? "");
  const [selectedOption, setSelectedOption] = useState<string | null>(payload.options?.[0] ?? null);
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const agentColorMap = useAgentColorMap();
  const agentColor = payload.agentId ? (agentColorMap.get(payload.agentId) ?? null) : null;
  const agentLabel = buildAgentLabel(payload.agentName);

  const submit = useCallback(
    (answer: string) => {
      setSubmitting(true);
      void onResolve(answer);
    },
    [onResolve],
  );

  const handleConfirm = useCallback((yes: boolean) => submit(yes ? "Yes" : "No"), [submit]);
  const handleChoiceSubmit = useCallback(() => {
    if (selectedOption) submit(selectedOption);
  }, [selectedOption, submit]);
  const handleMultiSelectSubmit = useCallback(() => {
    submit(Array.from(selectedOptions).join(", "));
  }, [selectedOptions, submit]);
  const handleTextSubmit = useCallback(() => {
    if (textValue.trim()) submit(textValue.trim());
  }, [textValue, submit]);
  const handleDismiss = useCallback(() => submit("[Dismissed by user]"), [submit]);

  const toggleMultiOption = useCallback((opt: string) => {
    setSelectedOptions((prev) => {
      const next = new Set(prev);
      if (next.has(opt)) next.delete(opt);
      else next.add(opt);
      return next;
    });
  }, []);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary shrink-0" />
          <span
            className="font-semibold"
            style={agentColor ? { color: agentColor } : undefined}
          >
            {agentLabel}
          </span>
          <span className="font-normal text-foreground">Needs Your Input</span>
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <p className="text-sm">{payload.question}</p>

        {payload.context && (
          <p className="text-xs text-muted-foreground bg-muted/50 rounded-md p-2">{payload.context}</p>
        )}

        {/* Choice — single select radio-style buttons */}
        {payload.inputType === "choice" && payload.options && (
          <div className="flex flex-col gap-1.5">
            {payload.options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setSelectedOption(opt)}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-left transition-colors",
                  selectedOption === opt
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-muted/50",
                )}
              >
                <div
                  className={cn(
                    "w-3.5 h-3.5 rounded-full border-2 flex-shrink-0",
                    selectedOption === opt ? "border-primary bg-primary" : "border-muted-foreground/40",
                  )}
                />
                {opt}
              </button>
            ))}
          </div>
        )}

        {/* Multi-select — checkbox-style buttons */}
        {payload.inputType === "multi_select" && payload.options && (
          <div className="flex flex-col gap-1.5">
            {payload.options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => toggleMultiOption(opt)}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-left transition-colors",
                  selectedOptions.has(opt)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-muted/50",
                )}
              >
                {selectedOptions.has(opt) ? (
                  <CheckSquare className="w-3.5 h-3.5 flex-shrink-0" />
                ) : (
                  <Square className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/40" />
                )}
                {opt}
              </button>
            ))}
          </div>
        )}

        {/* Text input */}
        {payload.inputType === "text" && (
          <Textarea
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            placeholder={payload.placeholder ?? "Type your answer..."}
            rows={3}
            className="resize-none"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleTextSubmit();
            }}
          />
        )}
      </div>

      <DialogFooter>
        {payload.inputType === "confirm" ? (
          <>
            <Button variant="outline" onClick={() => handleConfirm(false)} disabled={submitting}>
              No
            </Button>
            <Button onClick={() => handleConfirm(true)} disabled={submitting}>
              <Check className="w-3.5 h-3.5 mr-1" />
              Yes
            </Button>
          </>
        ) : payload.inputType === "choice" ? (
          <>
            <Button variant="outline" onClick={handleDismiss} disabled={submitting}>
              Skip
            </Button>
            <Button onClick={handleChoiceSubmit} disabled={submitting || !selectedOption}>
              Submit
            </Button>
          </>
        ) : payload.inputType === "multi_select" ? (
          <>
            <Button variant="outline" onClick={handleDismiss} disabled={submitting}>
              Skip
            </Button>
            <Button onClick={handleMultiSelectSubmit} disabled={submitting || selectedOptions.size === 0}>
              Submit ({selectedOptions.size})
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={handleDismiss} disabled={submitting}>
              Skip
            </Button>
            <Button onClick={handleTextSubmit} disabled={submitting || !textValue.trim()}>
              Submit
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
