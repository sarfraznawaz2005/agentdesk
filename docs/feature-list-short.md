# AgentDesk — Manual Test Checklist

> Quick-scan list for you to manually click through after any substantial
> change, to confirm the app still works end-to-end. Full technical detail
> (file pointers, data, failure modes) lives in `feature-list.md` — this is
> just the plain-language checklist.

## Agents & Task Workflow
1. Single agent task dispatch
2. Parallel agent dispatch (multiple agents at once)
3. Plan approval flow (propose a plan → approve/reject → tasks get created)
4. Auto-continue to the next task after one finishes
5. Kanban workflow (backlog → working → review → done, drag-and-drop)
6. Automatic code review after a task completes, and rejection sending it back
7. Task acceptance-criteria checklist
8. Auto git commit & feature branches per task
9. Creating a GitHub issue from a kanban task
10. Stop/abort a running agent mid-response
11. Agent asking you a question mid-task
12. Shell command / code-execution approval prompts
13. Long conversation auto-summarization
14. To-do list tracking in chat

## AI Providers & Models
15. Adding, testing, switching, setting the default directly from the provider list, and exporting/importing AI providers/models (export bundles all providers incl. API keys, with a plaintext-keys warning; import matches by base URL — overwriting an existing provider's credentials while keeping your own name)
16. Per-agent model assignment — and the model you pick in the composer applies to the sub-agents the PM dispatches too, not just the PM, unless an agent has its own model or provider override set
17. Thinking level selector — every agent thinks at Medium by default; picking Low/Medium/High in a chat overrides the PM and every sub-agent it dispatches (and the General Chat assistant), and the choice persists (per-project in project chat, across all conversations in General Chat)
18. AI usage & cost analytics dashboard (incl. clearing all recorded usage data to reset usage & provider stats to zero)
19. Raw prompt log viewer (debug prompts)
20. Provider health dashboard
21. Claude subscription sign-in

## Tools & Capabilities
22. Skills
23. MCP servers
24. Plugins
25. Web search & research tools
26. Screenshot capture of a live web app
27. Sending images, files, or audio to the AI in chat
28. AI generating an image in chat
29. Code error checking (LSP)
30. Agent memory across sessions
31. Agent-authored project docs & decision log
32. Sub-agents running a quick Python/JavaScript script in the project workspace (approval-gated like shell commands; auto-approved in Playground)
33. Agents inspecting a past commit's changed files and diff, and running read-only SQL against a SQLite database file — both work for exploration agents that have no shell access
34. Settings → Agents → Tools greys out write tools for read-only agents (Code Explorer, Research Expert, Task Planner) and labels them "stripped at dispatch" — they can't be switched on because those agents never receive them, and the list stays accurate even after restoring an old backup
35. The PM's agent list is split into "start here" agents and specialists, each entry saying when to use it and which agent to use instead for adjacent work — so a database task goes to the database expert rather than the backend engineer

## Channels & Notifications
36. Discord integration
37. WhatsApp integration
38. Email integration
39. Unified inbox
40. Desktop & channel notifications (task done, approvals, etc.)

## Chat Experience
41. Multiple conversations per project (searchable by title in the sidebar)
42. Searching inside a conversation
43. Prompts library (reusable saved prompts)
44. Voice input (dictate a message)
45. Forking a conversation from a message
46. Exporting a chat as markdown
47. Chat widgets on dashboard (PM and custom agents)
48. Quick Chat (open any folder without creating a project)
49. General Chat (standalone ChatGPT-style assistant with no project or workspace — answers directly in chat rather than creating files, its own conversations which auto-title themselves from your first message like every other chat, can read a file you attach and use web search/fetch, run a quick Python/JavaScript snippet for a calculation or small script, a Deep Research toggle, memory of its own, voice input, MCP status, conversation compaction that also happens automatically when a conversation gets long, attaching files/notes/prompts to a message, generated images that are still there when you come back to the conversation, per-message actions — copy, delete, fork a new conversation from a message, retry the last response, save a reply to Collections, and see which model answered — a header bar to toggle the conversation list/zoom text/search within a conversation/export as markdown/clear chat; a settings gear icon that opens General Chat's own streaming style — smooth live typing, chunked (larger blocks, lighter on long replies), or one complete reply — separate from the app-wide streaming setting; still shows it's working and lets you Stop it if you leave the page or refresh mid-reply; the sidebar's General Chat link shows a spinner while it's working and a red "new activity" dot when it finishes a reply while you're on another page, cleared as soon as you open General Chat)
50. Attaching/saving notes between chat and Collections
51. Ambient Mode (full-screen voice-interactive status overlay, opens from the Dashboard or auto-activates when idle; talk to it hands-free — no tap needed to end your turn or start the next one, it keeps listening automatically until you tap Stop — and ask about any project's status or tell it to start work on one; you can interrupt it by talking while it's thinking or replying, or by tapping Interrupt; if it's taking a moment, it says a quick "one moment"-style phrase before the real answer so you're not just met with silence; it answers or dispatches, showing what it's checking along the way, and can be projected onto a second monitor/TV; its voice can be the browser default, a configured speech model, or a downloadable fully-offline voice with its own download-progress option in Settings; speech input can likewise be the browser default or a downloadable fully-offline listening mode with its own download-progress option in Settings)

## Bigger Features
52. Freelance stuff (chat, auto-shortlist, auto-bidding/replies)
53. Issue Fixer agent
54. Playground agent
55. Council
56. Collections chat
57. Scheduler (cron jobs)
58. Automation rules

## Git & Remote
59. Git tab (branches, commits, diffs, pull requests, conflict resolver)
60. Remote Access (control the desktop app from your phone/browser)
61. Remote Sync (deploy files to a server via SFTP/FTP)
62. Live preview annotations (comment on your running app for the AI)

## Settings & Admin
63. Agent constitution editor
64. Environment variables management
65. Notification preferences
66. Data backup & export/import
67. Audit log
68. Provider error log — when an AI provider fails (outage, rate limit, bad key), the endpoint, HTTP status and its error message are written to a provider_errors.log file in the app's data folder, in normal installs too, not just dev
69. System health page
70. Auto-install missing dependencies (Recommendations)
71. Project-level settings (auto-execute, shell approval, auto-commit, context limit)
72. Right-click text menu in production/canary builds (Cut/Copy/Paste/Select-All, no Inspect option)
73. Help page (sidebar link with a table of contents that jumps straight to any section/sub-section)
