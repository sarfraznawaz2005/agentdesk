# Browser Testing — Agent Reference

## Prerequisites
- App started via `run.ps1` (sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`)
- chrome-devtools-mcp configured: `claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222`
- Restart Claude Code after MCP config change

## Verify connection
```bash
curl http://localhost:9222/json  # must return AgentDesk target
```
```js
// evaluate_script — returns false in plain browser, true in WebView2 desktop app
() => ({ hasElectrobun: !!window.electrobun })
```

## MCP tool sequence
1. `list_pages` — confirm `http://localhost:5173/` is selected
2. `take_snapshot` — get accessibility tree with element UIDs
3. `click uid=X` — navigate/interact using UIDs from snapshot
4. `take_screenshot` — verify visual state
5. `evaluate_script` — inspect JS state, React store, DOM

## Known constraints
- `window.electrobun` is always `false` in Helium/Chrome — RPC to Bun backend is unavailable
- UI renders and is navigable; agent-triggered actions (chat, workflows) require the desktop app
- Helium browser path: `C:\Users\Sarfraz\AppData\Local\imput\Helium\Application\chrome.exe`

## Wrong flags (do not use)
- `--port 9222` — launches a NEW Chrome, does not connect to existing WebView2
- `--browser-ws-endpoint` — not a valid flag for this MCP
- Setting env var in `src/bun/index.ts` — too late, native host already spawned

---

# For Humans — How to Setup

Follow these steps once. After setup, just start the app and Claude can inspect it automatically.

### Step 1 — Start the app correctly

Always use `run.ps1`, not `run.bat`:

```powershell
.\run.ps1
```

This sets the remote debugging environment variable before the app launches. Without it, port 9222 won't be available.

### Step 2 — Verify the app is debuggable

Open your browser and go to:

```
http://localhost:9222/json
```

You should see a JSON response with `"title": "AgentDesk"`. If you see nothing or an error, the app wasn't started via `run.ps1`.

### Step 3 — Install the chrome-devtools MCP (one-time only)

Open a terminal and run:

```bash
claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222
```

### Step 4 — Restart Claude Code

Close and reopen Claude Code so it picks up the new MCP configuration.

### Step 5 — Open the app in your browser (optional)

If you want to visually browse the app yourself, open **Helium** (or any Chromium browser) and go to:

```
http://localhost:5173
```

The UI will render and you can navigate it. Note that sending messages or triggering agents won't work in the browser — those require the desktop app to be running.

### Step 6 — Tell Claude to inspect the UI

Just ask Claude to take a screenshot, click something, or check how a feature looks. Claude will use the MCP to interact with the live running app.

**Example prompts:**
- "Take a screenshot of the kanban board"
- "Click into the blogApp project and show me the activity pane"
- "Check the console for errors"
