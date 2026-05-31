import { useEffect, useRef, useState } from "react";

// Initialize mermaid lazily so it doesn't bloat the initial bundle
let mermaidInitialized = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaidLib: any = null;

async function getMermaid() {
  if (!mermaidLib) {
    mermaidLib = (await import("mermaid")).default;
  }
  if (!mermaidInitialized) {
    mermaidLib.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "loose",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
    });
    mermaidInitialized = true;
  }
  return mermaidLib;
}

let idCounter = 0;

interface MermaidDiagramProps {
  code: string;
  /** Class applied to the fallback <pre> when mermaid fails */
  fallbackClassName?: string;
}

/**
 * Renders a mermaid diagram from raw mermaid syntax.
 * If mermaid fails to parse or render, falls back to rendering the raw code
 * as a plain text block — no errors are thrown or shown to the user.
 */
export function MermaidDiagram({ code, fallbackClassName }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const id = useRef(`mermaid-${++idCounter}`);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    getMermaid()
      .then(async (m) => {
        // Validate syntax before attempting render — avoids mermaid injecting
        // its own error SVG into the page which shows "Syntax error in text".
        await m.parse(code.trim());
        return m.render(id.current, code.trim());
      })
      .then(({ svg: rendered }: { svg: string }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    // Hide entirely — never show raw mermaid syntax or mermaid error messages
    void fallbackClassName;
    return null;
  }

  if (!svg) {
    // Still rendering — render nothing to avoid layout shift
    return null;
  }

  return (
    <div
      className="my-4 overflow-x-auto flex justify-start"
      // mermaid returns trusted SVG — dangerouslySetInnerHTML is intentional
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
