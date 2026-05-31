---
name: chrome-browser
description: Interact with a local Chrome/Chromium/Brave/Edge browser via Chrome DevTools Protocol — take screenshots, inspect accessibility trees, evaluate JavaScript, click elements, navigate pages, and read network entries. Use when the user asks to inspect, automate, debug, or interact with a page currently open in their browser.
allowed-tools: run_shell
hidden: true
---

# Chrome Browser

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Prerequisites

- Chrome (or Chromium, Brave, Edge, Vivaldi) with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)
- If the browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path

## Commands

All commands use `node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs"`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" list
```

### Take a screenshot

```bash
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" shot <target> [file]
# default: screenshot-<target>.png in runtime dir
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" snap <target>
```

### Evaluate JavaScript

```bash
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" html    <target> [selector]   # full page or element HTML
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" nav     <target> <url>         # navigate and wait for load
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" net     <target>               # resource timing entries
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" click   <target> <selector>    # click element by CSS selector
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" clickxy <target> <x> <y>       # click at CSS pixel coords
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" evalraw <target> <method> [json]  # raw CDP command passthrough
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" open    [url]                  # open new tab (each triggers Allow prompt)
node "${AGENTDESK_SKILL_DIR}/scripts/cdp.mjs" stop    [target]               # stop daemon(s)
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- Prefer `snap` over `html` for page structure — it's faster and token-efficient.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Chrome shows an "Allow debugging" modal once per tab on first access. A background daemon keeps the session alive so subsequent commands need no further approval. Daemons auto-exit after 20 minutes of inactivity.
- Always run `list` first to discover targetId prefixes before using other commands.
