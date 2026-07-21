import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { markdownSanitizeSchema, markdownUrlTransform } from "@/lib/markdown-sanitize-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface NoteEditorProps {
  initialTitle?: string;
  initialContent?: string;
  onSave: (title: string, content: string) => void;
  onCancel: () => void;
  saving?: boolean;
}

type EditorMode = "edit" | "preview";

export function NoteEditor({
  initialTitle = "",
  initialContent = "",
  onSave,
  onCancel,
  saving = false,
}: NoteEditorProps) {
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [mode, setMode] = useState<EditorMode>("edit");

  const canSave = title.trim().length > 0 && !saving;

  function handleSave() {
    if (!canSave) return;
    onSave(title.trim(), content);
  }

  return (
    <div className="flex flex-col gap-3 min-h-0 flex-1">
      {/* Title */}
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Doc title"
        className="text-base font-medium shrink-0"
        autoFocus
      />

      {/* Edit / Preview toggle */}
      <div className="flex items-center gap-1 border-b pb-2 shrink-0">
        <Button
          variant={mode === "edit" ? "default" : "ghost"}
          size="sm"
          onClick={() => setMode("edit")}
        >
          Edit
        </Button>
        <Button
          variant={mode === "preview" ? "default" : "ghost"}
          size="sm"
          onClick={() => setMode("preview")}
        >
          Preview
        </Button>
      </div>

      {/* Content area — wrapper div takes flex-1, textarea fills it with h-full */}
      {mode === "edit" ? (
        <div className="flex-1 min-h-0">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Write your doc in Markdown..."
            className="font-mono text-sm resize-none h-full"
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto rounded-md border bg-muted/30 p-4">
          {content.trim() ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]}
              urlTransform={markdownUrlTransform}
              components={{
                 
                code({ className, children, ref: _ref, ...props }) {
                  const match = /language-(\w+)/.exec(className ?? "");
                  if (!match) {
                    return (
                      <code className="px-1.5 py-0.5 rounded text-sm font-mono bg-muted text-foreground" {...props}>
                        {children}
                      </code>
                    );
                  }
                  return (
                    <pre className="my-3 rounded-lg bg-gray-900 text-gray-100 p-4 overflow-x-auto text-sm font-mono leading-relaxed">
                      <code>{children}</code>
                    </pre>
                  );
                },
                p: ({ children }) => <p className="mb-3 last:mb-0 text-sm text-foreground leading-relaxed">{children}</p>,
                ul: ({ children }) => <ul className="list-disc pl-5 mb-3 space-y-1 text-sm text-foreground">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 space-y-1 text-sm text-foreground">{children}</ol>,
                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                h1: ({ children }) => <h1 className="text-xl font-bold mb-3 mt-5 first:mt-0 text-foreground">{children}</h1>,
                h2: ({ children }) => <h2 className="text-lg font-bold mb-2 mt-4 first:mt-0 text-foreground">{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-semibold mb-2 mt-3 first:mt-0 text-foreground">{children}</h3>,
                h4: ({ children }) => <h4 className="text-sm font-semibold mb-1 mt-2 first:mt-0 text-foreground">{children}</h4>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-4 border-border pl-4 italic mb-3 text-muted-foreground">{children}</blockquote>
                ),
                a: ({ href, children }) => (
                  <a href={href} className="text-indigo-600 hover:text-indigo-800 underline" target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
                hr: () => <hr className="my-4 border-border" />,
                table: ({ children }) => (
                  <div className="overflow-x-auto mb-3">
                    <table className="min-w-full text-sm border-collapse">{children}</table>
                  </div>
                ),
                th: ({ children }) => (
                  <th className="border border-border px-3 py-1.5 bg-muted font-semibold text-left text-foreground">{children}</th>
                ),
                td: ({ children }) => (
                  <td className="border border-border px-3 py-1.5 text-foreground">{children}</td>
                ),
                strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                em: ({ children }) => <em className="italic text-muted-foreground">{children}</em>,
              }}
            >
              {content}
            </ReactMarkdown>
          ) : (
            <p className="text-sm text-muted-foreground italic">Nothing to preview.</p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-2 shrink-0">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!canSave}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
