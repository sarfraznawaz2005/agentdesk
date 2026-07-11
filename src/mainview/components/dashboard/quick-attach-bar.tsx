import { useState } from "react";
import { Library } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { AttachNoteModal } from "@/components/collections/attach-note-modal";
import { PromptsDropdown } from "@/components/chat/prompts-dropdown";

const BTN_CLASS =
  "flex-shrink-0 p-1.5 text-muted-foreground/60 hover:text-muted-foreground rounded-lg hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60";

/**
 * Attach a note / prompts library — mirrors chat-input.tsx's toolbar for the
 * dashboard chat widgets (PM + custom agent), which send plain-string
 * messages with no attachment-chip pipeline. Picked content is inserted
 * straight into the compose box instead of becoming a removable chip.
 */
export function QuickAttachBar({
  onInsertText,
  disabled,
}: {
  onInsertText: (text: string) => void;
  disabled?: boolean;
}) {
  const [attachNoteOpen, setAttachNoteOpen] = useState(false);

  return (
    <>
      <Tip content="Attach a note" side="top">
        <button
          type="button"
          onClick={() => setAttachNoteOpen(true)}
          className={BTN_CLASS}
          disabled={disabled}
        >
          <Library className="w-4 h-4" />
        </button>
      </Tip>
      <PromptsDropdown onSelect={onInsertText} disabled={disabled} />
      <AttachNoteModal
        open={attachNoteOpen}
        onOpenChange={setAttachNoteOpen}
        onAttach={(note) => onInsertText(`--- ${note.title} ---\n${note.contentMarkdown}`)}
      />
    </>
  );
}
