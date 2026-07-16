# Prompt-Based Testing — AgentDesk

> A library of chat prompts that exercise specific AgentDesk features —
> orchestration, single/parallel agent dispatch, tools, multimodal input,
> and the bigger standalone features — so a lot of the app can be smoke-
> tested just by typing something in and watching what happens, without
> needing to read code or click through every settings page.
>
> **How to use this**: pick a prompt relevant to what you're worried might
> have regressed, paste it into the relevant chat surface (usually the main
> project chat unless noted otherwise), and compare what actually happens
> against the **Expect** line. AI responses aren't perfectly deterministic —
> exact wording will vary — but the *behavior* described in **Expect** should
> hold every time.
>
> **Prerequisites vary per prompt** — some only need any working AI provider;
> others need a specific provider (image-generation-capable, reasoning-
> capable), a specific feature enabled (Freelance, Issue Fixer, Council), or
> external setup (a GitHub repo connected, an MCP server configured). Each
> prompt notes this where it applies.

---

## A. Core PM Orchestration

**1. Plain question — no dispatch expected**
> Prompt: `What is 2 + 2?`

Tests: the PM answers directly for simple questions instead of always dispatching an agent.
Expect: a direct answer, no sub-agent badge, nothing created on the Kanban board.

**2. Single sequential agent dispatch (read-only)**
> Prompt: `Have a code-explorer agent look through this project and tell me what its main entry point file is.`

Tests: single-agent dispatch, read-only tool restriction.
Expect: an agent badge appears and runs, tool calls (file/search) show live in the message, a summary comes back, and no files are modified.

**3. Single sequential agent dispatch (write agent)**
> Prompt: `Create a file called hello.txt in the project root with the content "Hello World".`

Tests: a write-capable agent actually touching the filesystem.
Expect: `hello.txt` appears in the workspace with the exact content requested.

**4. Parallel agent dispatch**
> Prompt: `Dispatch two code-explorer agents in parallel — one to summarize the frontend code and one to summarize the backend code.`

Tests: `run_agents_parallel`, concurrent execution.
Expect: two agent cards run at the same time (overlapping "Stop (Ns)" timers), each finishes independently with its own summary, and the PM combines them into one final answer.

**5. Plan approval flow (propose → reject with feedback → approve)**
> Prompt: `Create a plan to add a dark mode toggle to this app.`

Tests: task-planner dispatch, the approval card UI, feedback-driven re-planning.
Expect: an amber plan card appears with Approve/Reject buttons.
- Click **Reject**, type feedback like `Put the toggle in settings, not the header` → a revised plan card appears reflecting that change.
- Click **Approve** → backlog tasks appear on the Kanban board, and the PM auto-dispatches the first one.

**6. Auto-continue after a task completes**
No prompt — just observe after approving a multi-task plan (see #5): once the first task passes review and moves to Done, does the PM automatically start the next backlog task without being asked?

**7. Stop button / abort mid-response**
> Prompt: `Write a detailed 1500-word essay about the history of computers.`

Action: click **Stop** partway through.
Tests: abort correctness.
Expect: streaming halts immediately, the partial text stays visible (not corrupted/duplicated), and the composer accepts a new message right away with no stuck "busy" indicator.

**8. Agent asks you a question mid-task**
> Prompt: `Before creating a new settings page, ask me what section it should live under — use the ask-a-question tool, don't just guess.`

Tests: `request_human_input`.
Expect: an in-app modal (or question card) pops up and the agent visibly waits for your answer through it, not by you typing free text in chat.

**9. Shell command approval prompt**
> Prompt: `Run "git status" using the shell tool.`

Tests: shell approval gating (only if Shell Approval Mode is set to "Ask" — set that first if it's on Auto).
Expect: an Allow/Deny/Allow-for-session card appears in the chat before the command actually runs.

**10. Conversation compaction**
> Prompt: `/compact`

Tests: manual conversation compaction (also triggers automatically near the context limit).
Expect: an amber "Compacting conversation…" banner appears then clears, and the conversation remains usable for the next message afterward.

**11. To-do list tracking**
> Prompt: `Create a to-do list with 3 items — research options, implement the feature, write tests — then mark the first one done.`

Tests: `todo_write`/`todo_update_item`.
Expect: a checklist-style card renders (not plain markdown), showing pending/done icons and a "1/3 done" count.

---

## B. Kanban Workflow

**12. Acceptance criteria + automatic review cycle**
> Prompt: `Create a plan to add a "Clear All" button to [some existing list in this app]. Include at least 2 acceptance criteria.` → Approve.

Tests: criteria gating, auto code-review spawn on move-to-review.
Expect: the task card shows a criteria checklist; once the assigned agent finishes and calls its verification step, the task auto-moves to Review and a code-reviewer agent is spawned automatically — no human had to trigger the review.

**13. Task dependencies**
> Prompt: `Create a plan with two tasks where the second task is blocked by the first one being done.` → Approve.

Tests: `blocked_by`.
Expect: the second task's card shows a lock icon and stays out of dispatch order until the first task reaches Done.

**14. Review rejection loop**
Not directly promptable (the reviewer's verdict is judged by the AI, not forced by wording) — instead, just observe naturally during any real review: if a reviewer requests changes, does the task move back to Working and get re-dispatched to the same agent, with the reviewer's feedback attached?

---

## C. Tools

**15. File tools**
> Prompt: `Read package.json and tell me this project's name and version.`

Expect: the exact `name`/`version` fields from the real file, not a guess.

**16. Web search**
> Prompt: `Search the web for today's top tech news headline.`

Expect: a `web_search` tool call, and results that are genuinely current (not a stale/fabricated headline).

**17. Web fetch**
> Prompt: `Fetch https://example.com and tell me exactly what it says.`

Expect: an accurate description matching that page's real (very short, boilerplate) content — a fabricated-sounding answer means the fetch isn't actually working.

**18. Deep research**
> Prompt: `Dispatch a research-expert agent to do deep research on SQLite vs. PostgreSQL for a desktop app and give me a cited report.`

Expect: a longer wait than a normal reply, then a long-form report with real inline citations/sources, not a short off-the-cuff answer.

**19. Screenshot capture**
> Prompt: `Take a screenshot of https://example.com and describe what's on the page.`

Expect: a description that specifically matches that real page (confirms an actual image was captured and seen, not hallucinated).

**20. Image input (attach + read)**
Attach any image file via the paperclip button, then prompt: `What's in this image?`

Expect: an accurate description of the actual picture you attached.

**21. Image generation**
> Prompt: `Generate an image of a red bicycle.`
*(Requires an image-generation-capable provider/model configured.)*

Expect: a real image renders inline in the chat matching the request.

**22. Audio input**
Attach a WAV or MP3 file, then prompt: `Transcribe this audio.`

Expect: an accurate transcription/description of the actual audio content.

**23. Code diagnostics (LSP)**
> Prompt: `Check this project for TypeScript errors using the diagnostics tool.`

Expect: a real error/warning list (or a genuine "no errors found") matching the actual project state.

**24. Git tools**
> Prompt: `Show me git status and the last 5 commits.`

Expect: output that matches the real repo state exactly (compare against running `git log` yourself).

**25. Agent memory across sessions**
> Prompt (in one conversation): `Remember that our team prefers tabs over spaces for indentation.`
> Prompt (in a brand-new conversation): `What's our indentation preference?`

Expect: the second conversation correctly recalls the fact saved in the first, even though they share no message history.

**26. Decision log**
> Prompt: `Log a decision: we chose SQLite over Postgres because it's simpler to embed in a desktop app.`

Expect: a `DECISIONS.md` file appears/updates in the project workspace, and also shows up in the project's Docs tab.

**27. Skills**
> Prompt: `What skills are available to you? Read one and tell me what it does.`

Expect: a real list of installed skills, and accurate content from whichever one it reads.

**28. MCP tool usage**
*(Requires at least one MCP server configured, e.g. chrome-devtools.)*
> Prompt: `Using the chrome-devtools tool, navigate to https://example.com and take a snapshot.`

Expect: the MCP tool call succeeds and returns a real result from that external tool.

---

## D. Model / Provider Behavior

**29. Reasoning effort**
Set the reasoning-effort selector to **High**, then prompt: `A train leaves station A at 60mph heading toward station B, 300 miles away. Another train leaves station B at the same time heading toward A at 40mph. When do they meet?`

Expect: a visible thinking/reasoning block appears before the final answer (on a reasoning-capable provider), and the answer is correct (3 hours — closing speed 100mph over 300 miles).

**30. Model switching mid-project**
Switch the model in the model selector, then prompt: `Which model are you?`

Expect: if the model-name display is enabled, the reply is labeled with the newly selected model, not the old one.

---

## E. Bigger Standalone Features

**31. Council**
*(On the Council page.)*
> Prompt: `Should a small team building a new SaaS product start with microservices or a monolith?`

Expect: 3-5 personas answer in Round 1, a convergence check, a possible informed Round 2, and one final synthesized answer at the end.

**32. Playground**
*(On the Playground page.)*
> Prompt: `Build a simple counter app with plus and minus buttons using HTML/CSS/JS.`

Expect: files get created and the live preview updates automatically; clicking the buttons in the preview actually changes the count.

**33. Collections chat**
*(Requires at least one saved note in a Collection.)*
> Prompt: `Search my collections for notes about [some topic you've saved] and summarize them.`

Expect: real matching notes get found and summarized — and the assistant never tries to create/edit a note from this chat (it's read-only by design).

**34. Freelance chat / auto-shortlist**
*(Requires Freelance configured.)*
> Prompt: `Show me the latest shortlisted freelance listings and explain why each was flagged as workable.`

Expect: real listings with the AI's actual stated reasoning, not placeholder text.

**35. Scheduler**
*(On the Scheduler page.)* Create a one-shot reminder task for 2 minutes from now with a distinctive message.

Expect: a notification/reminder actually fires at the scheduled time.

**36. Issue Fixer**
*(Requires a GitHub repo connected to the project.)*
> Prompt: `Trigger the Issue Fixer to check for fixable issues right now.`

Expect: if a real trigger-eligible issue exists, the fixer agent runs on its own branch and opens a pull request — it should never merge or push directly to your default branch.

---

## F. Slash Commands & Chat Mechanics

**37. `/clear`** — clears the current conversation's visible messages.
**38. `/compact`** — see #10 above.
**39. `/fork`** — branches a new conversation starting from the current point (the hover "Fork-from-here" action on a specific message does the same thing anchored to that message).
**40. `/info`** — shows a quick status readout (context usage, active provider/model, etc.).
**41. `/new`** — starts a fresh conversation.
**42. `/preview`** — opens the live-preview annotation window for the project's dev server.
**43. `/mcp`** — opens the MCP server status dialog.

**44. `@` file mention**
> Prompt: type `@` then pick a file, e.g. `@package.json what does this file configure?`

Expect: the file's real content gets read and injected as context — the answer should be specific to that file's actual contents, not a generic guess.
