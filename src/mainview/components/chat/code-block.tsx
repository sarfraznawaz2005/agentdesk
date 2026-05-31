/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

export type CodeBlockTheme = "dark" | "light";

interface CodeBlockProps {
  language: string;
  code: string;
  /** Visual theme — defaults to "dark" */
  theme?: CodeBlockTheme;
  /** Max height in px before scrolling. 0 = no limit. */
  maxHeight?: number;
  /** Hide the header bar (language label + copy). */
  compact?: boolean;
  /** Optional line count shown in header (right side). */
  lineCount?: number;
}

// Module-level singleton so the highlighter is only created once across all instances.
// Exported so other components (e.g. activity feed) can reuse the same instance.
let highlighterPromise: Promise<Awaited<ReturnType<typeof import("shiki").createHighlighter>>> | null = null;

export function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((m) =>
      m.createHighlighter({ themes: ["github-dark", "github-light"], langs: [] })
    );
  }
  return highlighterPromise;
}

const THEME_MAP: Record<CodeBlockTheme, { shiki: string; bg: string; headerBg: string; headerText: string; fallbackBg: string; fallbackText: string }> = {
  dark: {
    shiki: "github-dark",
    bg: "#24292e",
    headerBg: "bg-gray-800",
    headerText: "text-gray-400",
    fallbackBg: "bg-gray-900",
    fallbackText: "text-gray-300",
  },
  light: {
    shiki: "github-light",
    bg: "#f6f8fa",
    headerBg: "bg-gray-100 dark:bg-gray-800",
    headerText: "text-gray-500 dark:text-gray-400",
    fallbackBg: "bg-gray-50 dark:bg-gray-900",
    fallbackText: "text-gray-700 dark:text-gray-300",
  },
};

export function CodeBlock({ language, code, theme = "dark", maxHeight = 0, compact = false, lineCount }: CodeBlockProps) {
  const [html, setHtml] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const t = THEME_MAP[theme];

  useEffect(() => {
    let cancelled = false;

    getHighlighter().then(async (highlighter) => {
      // Dynamically load the requested language; silently fall back to plaintext
      try {
        await highlighter.loadLanguage(language as Parameters<typeof highlighter.loadLanguage>[0]);
      } catch {
        // Language not supported by shiki — will use plaintext below
      }

      if (cancelled) return;

      const loadedLangs = highlighter.getLoadedLanguages();
      const result = highlighter.codeToHtml(code, {
        lang: loadedLangs.includes(language) ? language : "plaintext",
        theme: t.shiki,
      });

      setHtml(result);
    });

    return () => {
      cancelled = true;
    };
  }, [code, language, t.shiki]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const scrollStyle = maxHeight > 0 ? { maxHeight, overflowY: "auto" as const } : {};

  return (
    <div className="relative group rounded-lg overflow-hidden my-2 border border-border">
      {/* Header bar: language label + copy button */}
      {!compact && (
        <div className={`flex items-center justify-between px-4 py-2 ${t.headerBg} text-xs ${t.headerText}`}>
          <span className="uppercase tracking-wide">{language}</span>
          <div className="flex items-center gap-3">
            {lineCount != null && (
              <span className="tabular-nums">{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
            )}
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 hover:opacity-80 transition-opacity"
              aria-label={copied ? "Copied to clipboard" : "Copy code"}
            >
              {copied ? (
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </div>
      )}

      {/* Code body: shiki HTML once loaded, plain fallback while loading */}
      {html ? (
        <div
          className="p-4 overflow-x-auto text-sm [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:!p-0"
          style={{ backgroundColor: t.bg, ...scrollStyle }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={`p-4 ${t.fallbackBg} ${t.fallbackText} text-sm overflow-x-auto`} style={scrollStyle}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
