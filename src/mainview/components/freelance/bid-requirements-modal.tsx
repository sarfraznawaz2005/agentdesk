import { useState } from "react";
import { Sparkles, Loader2, Bot, User } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import type { BidQuestionDto, BidAnswerDto } from "../../../shared/rpc/freelance";

interface Props {
  listingTitle: string;
  questions: BidQuestionDto[];
  onGenerate: (answers: BidAnswerDto[]) => void;
  onCancel: () => void;
  generating: boolean;
}

export function BidRequirementsModal({ listingTitle, questions, onGenerate, onCancel, generating }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.aiAnswer ?? ""])),
  );

  const humanQuestions = questions.filter((q) => !q.canAiAnswer);
  const aiQuestions = questions.filter((q) => q.canAiAnswer);

  const handleSubmit = () => {
    const collected: BidAnswerDto[] = questions.map((q) => ({
      question: q.question,
      answer: answers[q.id]?.trim() ?? "",
    })).filter((a) => a.answer);
    onGenerate(collected);
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg bg-background border border-border rounded-xl shadow-xl p-5 focus:outline-none">
          <Dialog.Title className="text-sm font-semibold mb-0.5">Application Requirements</Dialog.Title>
          <Dialog.Description className="text-xs text-muted-foreground mb-4 line-clamp-1" title={listingTitle}>
            {listingTitle}
          </Dialog.Description>

          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
            {/* Human-required questions first */}
            {humanQuestions.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                  <User className="size-3" />
                  <span>Your input needed</span>
                </div>
                {humanQuestions.map((q) => (
                  <div key={q.id} className="space-y-1">
                    <label className="text-xs text-foreground/80">{q.question}</label>
                    <textarea
                      className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                      rows={2}
                      placeholder="Your answer…"
                      value={answers[q.id] ?? ""}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* AI-pre-filled questions — collapsible / editable */}
            {aiQuestions.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400">
                  <Bot className="size-3" />
                  <span>AI suggestions — edit if needed</span>
                </div>
                {aiQuestions.map((q) => (
                  <div key={q.id} className="space-y-1">
                    <label className="text-xs text-foreground/80">{q.question}</label>
                    <textarea
                      className="w-full rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                      rows={2}
                      value={answers[q.id] ?? ""}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={generating}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={generating}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              {generating ? "Generating…" : "Generate Proposal"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
