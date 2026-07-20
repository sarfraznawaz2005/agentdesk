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
12. Shell command approval prompts
13. Long conversation auto-summarization
14. To-do list tracking in chat

## AI Providers & Models
15. Adding, testing, and switching AI providers/models
16. Per-agent model assignment
17. Reasoning effort selector (thinking level)
18. AI usage & cost analytics dashboard
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

## Channels & Notifications
32. Discord integration
33. WhatsApp integration
34. Email integration
35. Unified inbox
36. Desktop & channel notifications (task done, approvals, etc.)

## Chat Experience
37. Multiple conversations per project
38. Searching inside a conversation
39. Prompts library (reusable saved prompts)
40. Voice input (dictate a message)
41. Forking a conversation from a message
42. Exporting a chat as markdown
43. Chat widgets on dashboard (PM and custom agents)
44. Quick Chat (open any folder without creating a project)
45. Attaching/saving notes between chat and Collections
46. Ambient Mode (full-screen voice-interactive status overlay, opens from the Dashboard or auto-activates when idle; talk to it hands-free — no tap needed to end your turn or start the next one, it keeps listening automatically until you tap Stop — and ask about any project's status or tell it to start work on one; you can interrupt it by talking while it's thinking or replying, or by tapping Interrupt; it answers or dispatches, showing what it's checking along the way, and can be projected onto a second monitor/TV; its voice can be the browser default, a configured speech model, or a downloadable fully-offline voice with its own download-progress option in Settings)

## Bigger Features
47. Freelance stuff (chat, auto-shortlist, auto-bidding/replies)
48. Issue Fixer agent
49. Playground agent
50. Council
51. Collections chat
52. Scheduler (cron jobs)
53. Automation rules

## Git & Remote
54. Git tab (branches, commits, diffs, pull requests, conflict resolver)
55. Remote Access (control the desktop app from your phone/browser)
56. Remote Sync (deploy files to a server via SFTP/FTP)
57. Live preview annotations (comment on your running app for the AI)

## Settings & Admin
58. Agent constitution editor
59. Environment variables management
60. Notification preferences
61. Data backup & export/import
62. Audit log
63. System health page
64. Auto-install missing dependencies (Recommendations)
65. Project-level settings (auto-execute, shell approval, auto-commit, context limit)
66. Right-click text menu in production/canary builds (Cut/Copy/Paste/Select-All, no Inspect option)
