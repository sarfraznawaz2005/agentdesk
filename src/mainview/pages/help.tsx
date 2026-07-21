import { useMemo, useState } from "react";
import {
  HelpCircle,
  LayoutDashboard,
  MessageCircle,
  FlaskConical,
  Inbox,
  Bot,
  Sparkles,
  BookOpen,
  Library,
  Clock,
  Users,
  BarChart2,
  Briefcase,
  MessageSquarePlus,
  Radar,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * Body content is a small block model (not raw JSX) so a single search query
 * can match/highlight against plain text uniformly across every sub-section,
 * instead of needing a parallel plain-text index kept in sync with hand-written JSX.
 */
type Block = { p: string } | { ol: string[] };

interface SubSection {
  id: string;
  title: string;
  blocks: Block[];
}

interface Section {
  id: string;
  title: string;
  intro?: string;
  subs: SubSection[];
}

const p = (text: string): Block => ({ p: text });
const ol = (items: string[]): Block => ({ ol: items });

const CONTENT: Section[] = [
  {
    id: "welcome",
    title: "Welcome to AgentDesk",
    subs: [
      {
        id: "welcome-what",
        title: "What is AgentDesk?",
        blocks: [
          p(
            "AgentDesk is a desktop app where a team of AI agents builds software for you. You describe what you want in plain English, an AI Project Manager (PM) plans the work, and specialist AI agents write the code, test it, and review it.",
          ),
          p(
            "Think of it like having a small dev team on call: a manager who understands what you're asking for and organizes the work, plus specialists who actually build it. You stay in charge the whole time — nothing important happens without your OK.",
          ),
        ],
      },
      {
        id: "welcome-why",
        title: "Why use it",
        blocks: [
          p(
            "You don't need to know how to code to build real software. Ask for a new page, a bug fix, or a whole feature — things like \"add a login page\" or \"fix the button that doesn't work on mobile\" — and AgentDesk plans it, builds it, and checks its own work.",
          ),
          p(
            "It keeps you in the loop with one simple approval step instead of a hundred small decisions, and it saves your progress with git behind the scenes as it goes, so you can always see — and undo — what changed.",
          ),
        ],
      },
      {
        id: "welcome-how",
        title: "How it works, in a nutshell",
        blocks: [
          ol([
            "You describe what you want in chat.",
            "The Project Manager puts together a plan and shows it to you.",
            "You approve it (or ask for changes).",
            "A team of specialist agents build it, check each other's work, and report back.",
          ]),
          p(
            "You only need to step in to approve plans, review results, and make the calls that only a human should make. And if you close AgentDesk partway through, it picks up right where it left off next time you open it.",
          ),
        ],
      },
    ],
  },
  {
    id: "sidebar",
    title: "Finding Your Way Around",
    intro: "The left sidebar is how you move around AgentDesk. Here's what each link does.",
    subs: [
      {
        id: "sidebar-dashboard",
        title: "Dashboard",
        blocks: [
          p(
            "Your home base. Shows all your projects as cards, lets you create a new one, and gives you a quick way to chat with a project's PM without opening it. If you've set a workspace folder, you can jump straight to it from here too.",
          ),
        ],
      },
      {
        id: "sidebar-general-chat",
        title: "General Chat",
        blocks: [
          p(
            "A general-purpose AI chat that isn't tied to any project — like talking to a helpful assistant. Good for questions, ideas, or quick research that doesn't need its own project.",
          ),
          p(
            "Unlike a project's chat or Quick Chat (below), it has no files or workspace behind it, so it can't build or save a real project for you — it just answers, in the chat.",
          ),
        ],
      },
      {
        id: "sidebar-playground",
        title: "Playground",
        blocks: [
          p(
            "A space to quickly build and preview small things — a webpage, a snippet, a prototype — without setting up a full project first. Good for trying an idea out before deciding it's worth a real project.",
          ),
        ],
      },
      {
        id: "sidebar-inbox",
        title: "Inbox",
        blocks: [
          p(
            "One place to see every message sent to your projects, whether it came from the app itself, Discord, WhatsApp, or email — read and reply from a single screen, no matter where it came in.",
          ),
        ],
      },
      {
        id: "sidebar-agents",
        title: "Agents",
        blocks: [
          p(
            "Shows every AI agent AgentDesk can call on — the Project Manager plus specialists like backend, frontend, and QA — and what each one focuses on.",
          ),
          p(
            "You can also create your own custom agents with their own instructions, and choose which AI model powers each one.",
          ),
        ],
      },
      {
        id: "sidebar-skills",
        title: "Skills",
        blocks: [
          p(
            "A library of extra abilities you can teach your agents — for example, a skill for writing a particular kind of document or following a specific checklist — so agents handle that kind of task the same way every time.",
          ),
        ],
      },
      {
        id: "sidebar-prompts",
        title: "Prompts",
        blocks: [
          p(
            "Save and reuse your favorite chat instructions — handy for things you ask for often, like a standard project checklist or a preferred writing style — so you don't have to retype them every time.",
          ),
        ],
      },
      {
        id: "sidebar-collections",
        title: "Collections",
        blocks: [
          p(
            "A place to save and organize useful replies, notes, and snippets that agents produce, so they're easy to find again later instead of scrolling back through old chats.",
          ),
        ],
      },
      {
        id: "sidebar-scheduler",
        title: "Scheduler",
        blocks: [
          p(
            "Set up tasks that run automatically on a schedule — a one-time reminder, something that repeats every day, or a rule that fires automatically when something happens (like a new task appearing).",
          ),
        ],
      },
      {
        id: "sidebar-council",
        title: "Council",
        blocks: [
          p(
            "Get input from several AI specialists at once on a question or decision. Each one answers independently first, then they see each other's answers and can revise their position, and the PM combines everything into one final recommendation.",
          ),
          p("Useful when you want more than a single opinion before deciding something important."),
        ],
      },
      {
        id: "sidebar-analytics",
        title: "Analytics",
        blocks: [
          p(
            "See how much you've used AI — cost and usage over time — broken down by project, so you know where your usage is going.",
          ),
        ],
      },
      {
        id: "sidebar-freelance",
        title: "Freelance (optional)",
        blocks: [
          p(
            "An optional feature, off by default, that helps you find and manage freelance work — it can shortlist job posts that match your skills, draft bids, and prepare replies to client messages for you to review before anything is sent.",
          ),
        ],
      },
      {
        id: "sidebar-quick-chat",
        title: "Quick Chat",
        blocks: [
          p(
            "Right-click any folder on your computer and choose \"Open in AgentDesk\" to start chatting with an agent about that folder right away — no need to create a project first.",
          ),
          p(
            "Unlike General Chat, it does work with the real files in that folder, and you can turn it into a full project later with one click if you decide to keep going.",
          ),
        ],
      },
      {
        id: "sidebar-ambient",
        title: "Ambient Mode",
        blocks: [
          p(
            "A full-screen overview of everything happening across your projects — tasks in progress, what's next, recent activity.",
          ),
          p(
            "You can also talk to it out loud: ask what's going on in any project, or tell it to start work on something, and it checks status or hands the request off to that project's own PM.",
          ),
        ],
      },
    ],
  },
  {
    id: "project",
    title: "Working Inside a Project",
    subs: [
      {
        id: "project-chat",
        title: "Chatting with your PM",
        blocks: [
          p(
            "Every project has its own Project Manager you talk to like a teammate. Tell it what you want, ask questions, or check on progress at any time — it always knows the state of the project's tasks and history.",
          ),
        ],
      },
      {
        id: "project-plans",
        title: "Plans and approval",
        blocks: [
          p(
            "For real feature work, the PM writes up a plan first and asks for your OK before anything gets built — you'll see it as a plan card in the chat, listing what it intends to do.",
          ),
          p(
            "You can click Approve, or just reply in your own words like \"yes, go ahead\" or \"also add X\" — the PM understands a plain-English reply just as well as the button, and can revise the plan if you ask for changes.",
          ),
        ],
      },
      {
        id: "project-kanban",
        title: "The Kanban board",
        blocks: [
          p(
            "Once you approve a plan, the work is broken into tasks on a board with four columns: Backlog, Working, Review, and Done. Watch tasks move across the board as agents complete them.",
          ),
          p("You can also drag a task yourself if you ever need to step in and reorder or move things manually."),
        ],
      },
      {
        id: "project-review",
        title: "Code review",
        blocks: [
          p(
            "Before a task is marked Done, another AI agent reviews the work automatically — you never need to ask for it. If something's wrong, it's sent back to be fixed.",
          ),
          p(
            "If it keeps failing after a couple of tries, it's flagged for you to look at instead of looping forever.",
          ),
        ],
      },
      {
        id: "project-git",
        title: "Git and branches",
        blocks: [
          p(
            "AgentDesk uses git behind the scenes to save every change, usually on its own feature branch, so your main code stays safe until you're ready.",
          ),
          p(
            "A Git tab in each project lets you review commits, see what changed, manage pull requests, and resolve merge conflicts with AI help.",
          ),
        ],
      },
      {
        id: "project-preview",
        title: "Live preview comments",
        blocks: [
          p(
            "While previewing your running app, you can click directly on anything you see and leave a comment — like \"make this button bigger.\" Your comment (and any errors on the page) goes straight to the agent as feedback, no need to describe it in words.",
          ),
        ],
      },
      {
        id: "project-issues",
        title: "GitHub issues & auto-fix",
        blocks: [
          p(
            "If your project is on GitHub, AgentDesk can track its issues, and — if you turn it on — have an agent automatically pick one up, fix it on its own branch, and open a pull request for you to review. It never merges the fix itself.",
          ),
        ],
      },
      {
        id: "project-deploy",
        title: "Deploying your files",
        blocks: [
          p(
            "When you're ready to publish your project to a real server, AgentDesk can sync your files there directly, showing you what changed before anything uploads.",
          ),
        ],
      },
      {
        id: "project-docs",
        title: "Notes and docs",
        blocks: [
          p(
            "Agents leave notes, plans, and documentation behind as they work, so you (or a future agent) can see what was decided and why, without having to scroll back through the whole conversation.",
          ),
        ],
      },
      {
        id: "project-settings",
        title: "Project-level settings",
        blocks: [
          p(
            "Beyond the app-wide Settings, each project has its own small set of options — like whether shell commands need your approval first, whether changes auto-commit to git, and how much conversation history the agent keeps in mind.",
          ),
        ],
      },
    ],
  },
  {
    id: "settings",
    title: "Settings, Explained",
    intro:
      "A quick tour of what lives in each Settings area — not every option, just the ones worth knowing about.",
    subs: [
      {
        id: "settings-general",
        title: "General & Appearance",
        blocks: [
          p(
            "Your profile basics (name and location, so agents can personalize things), light/dark/system theme, whether the sidebar starts collapsed, and whether the right-click \"Open in AgentDesk\" Quick Chat option is turned on.",
          ),
        ],
      },
      {
        id: "settings-ai",
        title: "AI Providers & Models",
        blocks: [
          p(
            "Connect the AI service(s) you want to use by adding an API key, then use Test Connection to confirm it works.",
          ),
          p(
            "Pick a default model, or assign a different model to specific agents — a lighter model for simple agents, a stronger one for tricky work. You can also adjust how much the AI \"thinks\" before answering, and turn word-by-word streaming replies on or off.",
          ),
        ],
      },
      {
        id: "settings-channels",
        title: "Channels",
        blocks: [
          p(
            "Connect Discord, WhatsApp, or email so your agents can send and receive messages there too — replies flow both ways, and everything still shows up in the in-app Inbox.",
          ),
          p(
            "Also home to Remote Access — a QR code that lets your phone or another browser securely control this desktop instance from anywhere.",
          ),
        ],
      },
      {
        id: "settings-integrations",
        title: "Integrations",
        blocks: [
          p(
            "Add a GitHub token so agents can push code, open pull requests, and read issues directly, and choose a web search provider so agents can look things up online.",
          ),
        ],
      },
      {
        id: "settings-ambient",
        title: "Ambient",
        blocks: [
          p(
            "Turn the Ambient Mode overlay on, choose whether it activates automatically after you've been idle, and pick its voice — the browser's built-in voice or a downloadable one that works fully offline.",
          ),
        ],
      },
      {
        id: "settings-notifications",
        title: "Notifications",
        blocks: [
          p(
            "Choose which events should notify you — a task finishing, a plan waiting for approval, an error — and where: a desktop popup, or through a connected channel like Discord or email.",
          ),
        ],
      },
      {
        id: "settings-system",
        title: "System",
        blocks: [
          p(
            "Back up or export your entire AgentDesk database, review the Audit Log (a running history of every important action — handy for seeing what happened while you were away), check the Health page to confirm everything's configured correctly, and let Recommendations auto-install anything your agents are missing.",
          ),
        ],
      },
      {
        id: "settings-plugins",
        title: "Plugins",
        blocks: [
          p(
            "Turn on optional add-ons that extend what AgentDesk can do, such as new tools an agent can call on.",
          ),
        ],
      },
    ],
  },
  {
    id: "advanced",
    title: "Advanced: How the Agents Really Work",
    intro: "You don't need any of this to use AgentDesk — it's here for anyone curious about what's happening under the hood.",
    subs: [
      {
        id: "advanced-pm",
        title: "Meet the Project Manager (PM)",
        blocks: [
          p(
            "The PM is the one agent you talk to directly. It doesn't write the code itself — its job is to understand what you want, turn it into a plan, and bring in the right specialists to get it done.",
          ),
          p("It's also the only agent with a memory of the whole project conversation, not just a single task."),
        ],
      },
      {
        id: "advanced-subagents",
        title: "Meet the sub-agents",
        blocks: [
          p(
            "Specialists — for backend, frontend, databases, testing, security, and more — are brought in by the PM to actually do the work.",
          ),
          p(
            "Each one only sees the task it's given, not your whole conversation history, which keeps it focused and fast.",
          ),
        ],
      },
      {
        id: "advanced-loop",
        title: "Plan → Approve → Execute",
        blocks: [
          p(
            "This is the core loop: the PM proposes a plan, you approve it, and then the PM and its agents handle everything else — writing code, testing it, and checking their own work — without needing you to babysit every step.",
          ),
          p(
            "Approving doesn't require a special command either — replying \"yes\" or \"looks good\" in your own words works just as well as clicking the button.",
          ),
        ],
      },
      {
        id: "advanced-kanban-rules",
        title: "The Kanban rules",
        blocks: [
          p(
            "Tasks always move forward: Backlog → Working → Review → Done. Agents are only allowed to send a task to Review — moving it to Done is reserved for the automatic review step below, so nothing is marked finished without a check.",
          ),
          p("You can still drag a task yourself if you ever need to override that."),
        ],
      },
      {
        id: "advanced-code-review",
        title: "Automatic code review",
        blocks: [
          p(
            "Whenever a task reaches Review, AgentDesk automatically brings in a reviewer agent — you don't need to ask for it.",
          ),
          p(
            "If it finds problems, the task goes back to Working to be fixed, up to a couple of tries, before it's flagged for you instead of looping forever.",
          ),
        ],
      },
      {
        id: "advanced-parallel",
        title: "Working in parallel vs. one at a time",
        blocks: [
          p(
            "Agents that write or change code work one at a time, so they don't step on each other's changes.",
          ),
          p(
            "Agents that only research or read information — like checking existing code or looking something up — can run several at once, since there's nothing for them to conflict over.",
          ),
        ],
      },
      {
        id: "advanced-git",
        title: "Feature branches & auto-commits",
        blocks: [
          p(
            "Before work starts, the PM sets up a dedicated git branch for the feature, so your main code stays untouched.",
          ),
          p(
            "As agents finish tasks, their changes are committed automatically, so you always have a clear, reversible history of what changed and why.",
          ),
        ],
      },
      {
        id: "advanced-memory",
        title: "Long conversations & memory",
        blocks: [
          p(
            "If a conversation runs long, AgentDesk automatically condenses older messages so agents don't lose track of what matters, while keeping the important context available — you don't need to manage this yourself.",
          ),
        ],
      },
      {
        id: "advanced-restart-safe",
        title: "Restart-safe by design",
        blocks: [
          p(
            "Nothing is lost if you close AgentDesk, restart your computer, or an agent gets interrupted mid-task.",
          ),
          p(
            "Progress lives in the kanban board and conversation history, not just in memory, so the next time you open the project, agents pick up exactly where things left off.",
          ),
        ],
      },
    ],
  },
];

const SIDEBAR_ICONS: Record<string, LucideIcon> = {
  "sidebar-dashboard": LayoutDashboard,
  "sidebar-general-chat": MessageCircle,
  "sidebar-playground": FlaskConical,
  "sidebar-inbox": Inbox,
  "sidebar-agents": Bot,
  "sidebar-skills": Sparkles,
  "sidebar-prompts": BookOpen,
  "sidebar-collections": Library,
  "sidebar-scheduler": Clock,
  "sidebar-council": Users,
  "sidebar-analytics": BarChart2,
  "sidebar-freelance": Briefcase,
  "sidebar-quick-chat": MessageSquarePlus,
  "sidebar-ambient": Radar,
};

function blockText(block: Block): string {
  return "p" in block ? block.p : block.ol.join(" ");
}

function subSearchText(sub: SubSection): string {
  return `${sub.title} ${sub.blocks.map(blockText).join(" ")}`.toLowerCase();
}

function subMatches(sub: SubSection, query: string): boolean {
  if (!query) return true;
  return subSearchText(sub).includes(query);
}

/** Wraps every case-insensitive occurrence of `query` in `text` with a <mark>. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) =>
        re.test(part) ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-500/40 text-inherit rounded-sm px-px">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function BlockBody({ blocks, query }: { blocks: Block[]; query: string }) {
  return (
    <>
      {blocks.map((block, i) =>
        "p" in block ? (
          <p key={i} className="mb-2 last:mb-0">
            <Highlight text={block.p} query={query} />
          </p>
        ) : (
          <ol key={i} className="list-decimal pl-5 mb-2 last:mb-0 space-y-1">
            {block.ol.map((item, j) => (
              <li key={j}>
                <Highlight text={item} query={query} />
              </li>
            ))}
          </ol>
        ),
      )}
    </>
  );
}

function Sub({ sub, query }: { sub: SubSection; query: string }) {
  const Icon = SIDEBAR_ICONS[sub.id];
  return (
    <div id={sub.id} className="pt-2 first:pt-0">
      <h3 className="flex items-center gap-2 text-base font-semibold text-foreground mb-1.5">
        {Icon && (
          <span className="flex items-center justify-center w-6 h-6 rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 shrink-0">
            <Icon className="w-3.5 h-3.5" aria-hidden="true" />
          </span>
        )}
        <Highlight text={sub.title} query={query} />
      </h3>
      <div className="text-sm text-muted-foreground leading-relaxed pl-0.5">
        <BlockBody blocks={sub.blocks} query={query} />
      </div>
    </div>
  );
}

export function HelpPage() {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const filtered = useMemo(() => {
    return CONTENT.map((section) => ({
      ...section,
      subs: section.subs.filter((sub) => subMatches(sub, normalizedQuery)),
    })).filter((section) => section.subs.length > 0);
  }, [normalizedQuery]);

  const totalMatches = filtered.reduce((sum, section) => sum + section.subs.length, 0);
  const isSearching = normalizedQuery.length > 0;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div className="flex items-center gap-2">
          <HelpCircle className="w-6 h-6 text-indigo-600" aria-hidden="true" />
          <h1 className="text-2xl font-bold text-foreground">Help</h1>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search in Help"
            aria-label="Search in Help"
            className="w-full pl-8 pr-8 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {isSearching && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground transition-colors"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {isSearching && (
        <p className="text-xs text-muted-foreground mb-4">
          {totalMatches > 0 ? `${totalMatches} result${totalMatches === 1 ? "" : "s"} for "${query.trim()}"` : `No results for "${query.trim()}"`}
        </p>
      )}

      <div className="flex gap-8 items-start">
        {/* Table of contents */}
        {!isSearching && (
          <nav
            aria-label="Help contents"
            className="hidden md:block w-64 shrink-0 sticky top-4 self-start max-h-[calc(100vh-6rem)] overflow-y-auto pr-2"
          >
            <ul className="space-y-4">
              {CONTENT.map((section) => (
                <li key={section.id}>
                  <button
                    type="button"
                    onClick={() => jumpTo(section.id)}
                    className="text-left text-sm font-semibold text-foreground hover:text-indigo-600 transition-colors"
                  >
                    {section.title}
                  </button>
                  <ul className="mt-1.5 space-y-1 border-l border-border pl-3">
                    {section.subs.map((sub) => (
                      <li key={sub.id}>
                        <button
                          type="button"
                          onClick={() => jumpTo(sub.id)}
                          className="text-left text-xs text-muted-foreground hover:text-indigo-600 transition-colors"
                        >
                          {sub.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          {(isSearching ? filtered : CONTENT).map((section) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-4 pb-10 mb-10 border-b border-border last:border-b-0 last:mb-0"
            >
              <h2 className="text-xl font-bold text-foreground mb-4">{section.title}</h2>
              <div className="space-y-5">
                {section.intro && !isSearching && (
                  <p className="text-sm text-muted-foreground -mt-1">{section.intro}</p>
                )}
                {section.subs.map((sub) => (
                  <Sub key={sub.id} sub={sub} query={normalizedQuery} />
                ))}
              </div>
            </section>
          ))}

          {isSearching && totalMatches === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing matched. Try a different word, or clear the search to browse everything.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
