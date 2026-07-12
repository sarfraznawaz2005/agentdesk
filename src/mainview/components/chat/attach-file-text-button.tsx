import { useRef } from "react";
import { Paperclip } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";

const UNSUPPORTED_PREFIXES = ["image/", "audio/", "video/"];
// Keep inserted text reasonable — this inserts raw file content into a chat
// input, not a real attachment pipeline (see main chat's AttachmentFile for that).
const MAX_CHARS = 200_000;

export interface AttachFileTextButtonProps {
  onInsertText: (text: string) => void;
  disabled?: boolean;
}

/**
 * Text-only "attach file" — reads the picked file's text content and inserts it
 * into the input, same as "Attach a note". Unlike the main chat's Paperclip
 * button, this does NOT send real attachments (images/audio as multi-modal
 * content) to the AI — neither Playground's nor Council's backend RPC accepts
 * attachments, so this is scoped to text/code files only.
 */
export function AttachFileTextButton({ onInsertText, disabled }: AttachFileTextButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (UNSUPPORTED_PREFIXES.some((p) => file.type.startsWith(p))) {
      toast("error", `"${file.name}" is a ${file.type.split("/")[0]} file — only text/code files can be attached here.`);
      return;
    }
    try {
      let text = await file.text();
      if (text.length > MAX_CHARS) {
        text = `${text.slice(0, MAX_CHARS)}\n\n[... truncated, file too large]`;
      }
      onInsertText(`--- ${file.name} ---\n${text}`);
    } catch {
      toast("error", `Could not read "${file.name}" as text.`);
    }
  };

  return (
    <>
      <Tip content="Attach file (text content)" side="top">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex-shrink-0 p-1.5 text-muted-foreground/60 hover:text-muted-foreground rounded-lg hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60"
          disabled={disabled}
        >
          <Paperclip className="w-4 h-4" />
        </button>
      </Tip>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}
