# Browser Testing — Agent Reference

AgentDesk agents can drive a web browser two ways. They are **not** interchangeable,
and **neither attaches to the running WebView2 desktop app** (there is no
`--remote-debugging-port=9222` on the app, and nothing reads such a port). Both
drive a *separate* browser. Pick deliberately.

## The two tools

### 1. `live-browser` skill — the user's REAL, logged-in browser
- **Use for:** anything behind a sign-in, sites that block bots (Gmail/Google,
  banking, social), or any task that needs the user's existing session.
- **What it is:** a persistent, logged-in Chrome/Edge/Brave profile launched with
  **no** automation flags — `navigator.webdriver` stays `false` and there is no
  "controlled by automated test software" banner, so sites treat it as an ordinary
  human. Logins survive across runs.
- **How it's wired:** `skills/live-browser/SKILL.md`. The launcher
  (`skills/live-browser/scripts/launch.mjs`) starts a dedicated profile on an
  **uncommon free port** and persists it; the CDP client
  (`skills/live-browser/scripts/cdp.mjs`) reads that persisted port. It
  **deliberately never probes 9222** (see `cdp.mjs:102`, `launch.mjs:12`,
  `lib.mjs:9`) so it can never hijack a foreign debug browser.
- **How agents invoke it:** `read_skill("live-browser")`, then run the
  `launch.mjs` / `cdp.mjs` commands via `run_shell` (see the SKILL for the
  command set: `list`, `shot`, `snap`, `eval`, `nav`, `click`, `type`, …).

### 2. chrome-devtools MCP — its own throwaway automation browser
- **Use for:** throwaway inspection, scraping public pages, performance traces,
  network/console debugging, and automating sites that don't fight automation.
- **What it is:** the `chrome-devtools_*` tools driving a Chromium instance the
  MCP server **launches itself**. It is an automation browser
  (`navigator.webdriver` is true, shows the automation banner) and carries **no**
  saved logins, so bot-detecting sites often block or challenge it.
- **How it's wired:** seeded into the app's MCP config in
  `src/bun/db/seed.ts:1506-1512` —
  `npx -y chrome-devtools-mcp@latest --no-performance-crux --no-usage-statistics`.
  Note there is **no `--browserUrl`**: it spawns its own browser rather than
  attaching to anything. Configure it in-app (Settings → MCP), not via
  `claude mcp add`.
- **Key constraint:** because it drives its own separate browser, it **cannot see
  the in-app preview** (Playground iframe, WebView2 UI). The Playground agent
  explicitly removes `chrome-devtools_*` from its toolset for this reason
  (`src/bun/playground/orchestrator.ts:319-322`).

## How agents choose

The PM and sub-agent prompts arbitrate between the two via
`BROWSER_TOOLING_GUIDANCE` and the PM's browser-choice note in
`src/bun/agents/prompts.ts:707-715` (PM delegation note) and `771-809`
(sub-agent decision section). Summary of the rules:

- Needs the user's login / an authenticated session, or targets a bot-blocking
  site → **`live-browser`**.
- Throwaway inspection, scraping public pages, performance/network/console
  debugging, or an automation-friendly dev site → **chrome-devtools MCP**.
- Unsure and the task touches a real account or major consumer site →
  prefer **`live-browser`** (getting blocked mid-task is worse than a little setup).

## What does NOT exist (do not attempt)

- ❌ Attaching chrome-devtools MCP to the running app via
  `claude mcp add ... --browserUrl http://127.0.0.1:9222`.
- ❌ Starting the app with `--remote-debugging-port=9222` to inspect the WebView2
  UI over CDP — nothing in the app exposes or reads port 9222.
- ❌ Any hardcoded Helium / Chrome browser path. The `live-browser` launcher
  auto-detects Chrome → Edge → Brave.
