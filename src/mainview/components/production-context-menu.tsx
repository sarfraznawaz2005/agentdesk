import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Scissors, Copy, Clipboard, TextCursorInput } from "lucide-react";
import { rpc } from "../lib/rpc";
import { IS_REMOTE } from "../lib/remote-transport";

// WebView2's built-in right-click context menu is production's only way to
// Cut/Copy/Paste text, but it also exposes "Inspect" — so it can't just be
// disabled outright (see src/bun/index.ts's dom-ready comment for that
// history). This replaces it in production/canary builds only (dev channel
// keeps the native menu, including Inspect, for debugging) with a minimal
// text-only menu backed by Bun's native clipboard RPC, so copy/paste keeps
// working without a devtools entry point. No-op in web/remote mode — that's
// the user's own real browser tab, where suppressing its context menu would
// be pointless (they still have their own F12) and hostile.
const ACTIVE = !import.meta.env.DEV && !IS_REMOTE;

type EditableEl = HTMLInputElement | HTMLTextAreaElement;

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

function isEditable(el: EventTarget | null): el is EditableEl {
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) return !el.disabled && !el.readOnly && TEXT_INPUT_TYPES.has(el.type);
  return false;
}

function selectedTextOf(el: EditableEl): string {
  return el.value.substring(el.selectionStart ?? 0, el.selectionEnd ?? 0);
}

/** Sets an editable element's value the way React's controlled inputs expect
 * (via the native setter + a real "input" event) so onChange fires normally. */
function setNativeValue(el: EditableEl, value: string, cursor: number): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.selectionStart = el.selectionEnd = cursor;
}

interface MenuState {
  x: number;
  y: number;
  target: EditableEl | null;
  selection: string;
}

export function ProductionContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ACTIVE) return;

    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return; // another handler already owns this (e.g. a custom app menu)

      // Always suppress WebView2's native menu in production — that's the
      // whole point (it's the only thing hiding Inspect). Whether we THEN
      // show our own Cut/Copy/Paste menu depends on the target below; a
      // plain background right-click (no editable target, no selection)
      // gets no replacement menu either, but the native one must never show.
      e.preventDefault();

      const editable = isEditable(e.target) ? (e.target as EditableEl) : null;
      const selection = editable ? selectedTextOf(editable) : (window.getSelection()?.toString() ?? "");
      if (!editable && !selection) { setMenu(null); return; }

      setMenu({ x: e.clientX, y: e.clientY, target: editable, selection });
    };

    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // Clamp inside the viewport once rendered so it never overflows.
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 4);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 4);
    if (x !== menu.x || y !== menu.y) menuRef.current.style.transform = `translate(${x - menu.x}px, ${y - menu.y}px)`;
  }, [menu]);

  if (!ACTIVE || !menu) return null;

  const { target, selection } = menu;

  const doCopy = async () => {
    if (selection) await rpc.writeClipboardText(selection);
    setMenu(null);
  };

  const doCut = async () => {
    if (target && selection) {
      await rpc.writeClipboardText(selection);
      const start = target.selectionStart ?? 0;
      const newValue = target.value.slice(0, start) + target.value.slice(target.selectionEnd ?? start);
      setNativeValue(target, newValue, start);
    }
    setMenu(null);
  };

  const doPaste = async () => {
    if (target) {
      const { text } = await rpc.readClipboardText();
      if (text) {
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? start;
        const newValue = target.value.slice(0, start) + text + target.value.slice(end);
        setNativeValue(target, newValue, start + text.length);
      }
    }
    setMenu(null);
  };

  const doSelectAll = () => {
    target?.select();
    setMenu(null);
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-background rounded-lg shadow-lg border border-border py-1 min-w-[140px]"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {target && selection && (
        <button onClick={doCut} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted">
          <Scissors className="w-3 h-3" />
          Cut
        </button>
      )}
      {selection && (
        <button onClick={doCopy} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted">
          <Copy className="w-3 h-3" />
          Copy
        </button>
      )}
      {target && (
        <button onClick={doPaste} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted">
          <Clipboard className="w-3 h-3" />
          Paste
        </button>
      )}
      {target && (
        <button onClick={doSelectAll} className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted">
          <TextCursorInput className="w-3 h-3" />
          Select All
        </button>
      )}
    </div>
  );
}
