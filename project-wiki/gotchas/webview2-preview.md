---
title: WebView2 Preview Constraints
type: gotcha
status: verified
verified_at: 2026-06-27
sources:
  - src/bun/index.ts
  - src/bun/playground/server.ts
  - src/bun/rpc/playground.ts
  - src/mainview/pages/playground.tsx
tags: [webview, preview]
---

# WebView2 Preview Constraints

AgentDesk runs in Electrobun on top of the **system WebView2 (Edge/Chromium)** on
Windows. The Playground (and any in-app live preview) renders agent-generated
content by pointing an in-page `<iframe>` at a local HTTP server. WebView2 is more
locked-down than a plain Chromium build, so three non-obvious constraints shape
how previews are built. All three were discovered building the [[playground]]
feature and are encoded as workarounds in the code — this page explains *why* they
exist so nobody "simplifies" them away.

## The model: iframe → localhost works

The preview is a plain `<iframe>` inside the `views://` React page whose `src` is
`http://127.0.0.1:<port>/...` — see `src/mainview/pages/playground.tsx:900`. There
is **no** need for the `<electrobun-webview>` OOPIF tag or a separate
`BrowserWindow`; a same-page iframe pointed at a Bun static server renders fine.

The one requirement is that the localhost origin is whitelisted in the window's
navigation rules. The default rule blocks everything (`^*`); `src/bun/index.ts:342`
explicitly re-allows `views://*`, `http://localhost:*` and `http://127.0.0.1:*`.

Critically, **nav rules govern top-level/frame *navigation* only — not script /
img / fetch sub-resources.** That is why a localhost preview page can still pull
CDN scripts (PDF.js, SheetJS, etc.) even though no external origin is whitelisted.
The static server itself is `Bun.serve` on port 4760+ (`src/bun/playground/server.ts:19`),
falling through a candidate list if a port is taken.

## Constraint 1 — native PDF navigation is blocked → use PDF.js

Navigating an iframe directly at a `*.pdf` URL shows **"This page has been blocked
by Microsoft Edge"** — WebView2's native PDF plugin is disabled. The server works
around this with a dedicated `/__pdf?file=...` route that returns an HTML wrapper
which renders the PDF to a `<canvas>` via **PDF.js** loaded from a CDN
(`src/bun/playground/server.ts:139` for the route, `:73` for the viewer HTML). The
`?file=` value is sanitized (`:140`) before being substituted into the same-origin
PDF path. Any preview that needs to show a PDF must go through this route, never a
direct `.pdf` link.

## Constraint 2 — Electrobun's RPC bridge leaks into every iframe

Electrobun injects its webview RPC bridge runtime into **every document, including
the preview iframe**. Inside the iframe those bridge calls have no valid host
target, so they reject as unhandled promise rejections with
`"Element not found. (0x80070490)"` (wrapped in a `{callId, remoteObjectId, ...}`
envelope). These are **not page bugs** and they accumulate per load. The
console-capture shim injected into served HTML filters them out before forwarding
to the app's "Console" panel — it drops anything carrying a `callId`/`remoteObjectId`
key or matching `0x80070490`/`"Element not found"`
(`src/bun/playground/server.ts:58`–`:63`). When capturing console output from any
WebView2-hosted iframe, apply the same filter or you will surface phantom errors.

## Constraint 3 — `Utils.paths.downloads` ignores a relocated Downloads

Electrobun's `Utils.paths.downloads` always returns the default
`%USERPROFILE%\Downloads`; it does **not** honor a Downloads known-folder that the
user relocated to another drive (common on Windows). To write to the *real*
Downloads, `resolveDownloadsDir()` reads the registry value
`{374DE290-123F-4565-9164-39C4925E467B}` under
`HKCU\...\CurrentVersion\Explorer\Shell Folders`, validates the path exists, and
only then falls back to `Utils.paths.downloads`
(`src/bun/rpc/playground.ts:205`–`:222`). Any feature saving a user-visible file to
"Downloads" should call this helper, not `Utils.paths.downloads` directly.

## Key files

| File | Role |
|---|---|
| `src/bun/index.ts:342` | Navigation rules — whitelists `localhost`/`127.0.0.1` so the iframe can load |
| `src/bun/playground/server.ts` | Bun static preview server (port 4760+); `/__pdf` route, console-capture/filter shim |
| `src/bun/rpc/playground.ts:205` | `resolveDownloadsDir()` — registry lookup for the real Downloads folder |
| `src/mainview/pages/playground.tsx:900` | The preview `<iframe>` (src = localhost server URL, sandboxed) |

## Gotchas / Constraints (recap)

- A direct `.pdf` iframe nav is blocked → route through `/__pdf` (PDF.js canvas).
- `0x80070490` / "Element not found" rejections from the iframe are Electrobun
  bridge noise, not bugs — filter them.
- Nav rules only gate navigation, not sub-resources — CDN scripts load on a
  localhost page even though only localhost is whitelisted.
- Never trust `Utils.paths.downloads` for "save to Downloads" on Windows; use
  `resolveDownloadsDir()`.

## Related
- [[playground]]
- [[electrobun-webview-overlay]]

## Open questions
- Whether the same `/__pdf` + console-filter pattern is (or should be) reused by
  the Freelance inbox iframe (`src/mainview/components/freelance/inbox-tab.tsx`),
  which also embeds an iframe but via the `<electrobun-webview>` session host.
- macOS/Linux WebView (WebKit) behavior for the native-PDF block is unverified;
  the workaround is keyed off `process.platform === "win32"` only for the
  Downloads lookup, but the PDF route is unconditional.
